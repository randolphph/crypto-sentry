import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PollingScheduler } from '../src/core/scheduling/polling-scheduler.js';

describe('PollingScheduler', () => {
  it('runs each task in the supplied RPC audit context', async () => {
    const contexts: string[] = [];
    const scheduler = new PollingScheduler({
      onError: () => undefined,
      minimumIntervalMilliseconds: 1,
      runWithContext: async (taskId, operation) => {
        contexts.push(taskId);
        return operation();
      },
    });
    let resolveRun: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => { resolveRun = resolve; });
    scheduler.upsert({
      id: 'uniswap:mon_rpc', intervalMilliseconds: 1,
      run: async () => { resolveRun?.(); },
    });
    await vi.advanceTimersByTimeAsync(0);
    await completed;
    expect(contexts).toEqual(['uniswap:mon_rpc']);
    await scheduler.close();
  });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps healthy tasks running when another task fails', async () => {
    const errors: Array<{ taskId: string; message: string }> = [];
    const scheduler = new PollingScheduler({
      minimumIntervalMilliseconds: 10,
      onError: (taskId, error) => errors.push({ taskId, message: error.message }),
    });
    const healthy = vi.fn(async () => undefined);
    const failing = vi.fn(async () => Promise.reject(new Error('RPC unavailable')));
    scheduler.upsert({ id: 'healthy', intervalMilliseconds: 100, run: healthy });
    scheduler.upsert({ id: 'failing', intervalMilliseconds: 100, run: failing });

    await vi.advanceTimersByTimeAsync(0);
    expect(healthy).toHaveBeenCalledOnce();
    expect(failing).toHaveBeenCalledOnce();
    expect(errors).toEqual([{ taskId: 'failing', message: 'RPC unavailable' }]);

    await vi.advanceTimersByTimeAsync(100);
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(failing).toHaveBeenCalledTimes(2);
    await scheduler.close();
  });

  it('never overlaps one task and aborts it during shutdown', async () => {
    let release: (() => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async (signal: AbortSignal) => {
      observedSignal = signal;
      await blocked;
    });
    const scheduler = new PollingScheduler({
      minimumIntervalMilliseconds: 10,
      onError: () => undefined,
    });
    scheduler.upsert({ id: 'position', intervalMilliseconds: 100, run });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledOnce();

    const closing = scheduler.close();
    expect(observedSignal?.aborted).toBe(true);
    release?.();
    await closing;
  });

  it('validates intervals and removes scheduled tasks', async () => {
    const scheduler = new PollingScheduler({
      minimumIntervalMilliseconds: 10,
      onError: () => undefined,
    });
    expect(() => scheduler.upsert({ id: 'too-fast', intervalMilliseconds: 9, run: async () => undefined }))
      .toThrow('interval must be at least 10ms');
    const run = vi.fn(async () => undefined);
    scheduler.upsert({ id: 'removed', intervalMilliseconds: 100, run });
    scheduler.remove('removed');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).not.toHaveBeenCalled();
    await scheduler.close();
  });

  it('waits for an in-flight task that was removed before shutdown', async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new PollingScheduler({
      minimumIntervalMilliseconds: 10,
      onError: () => undefined,
    });
    scheduler.upsert({ id: 'removed-running', intervalMilliseconds: 100, run: async () => blocked });
    await vi.advanceTimersByTimeAsync(0);
    scheduler.remove('removed-running');

    let closed = false;
    const closing = scheduler.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    release?.();
    await closing;
    expect(closed).toBe(true);
  });
});
