import { describe, expect, it, vi } from 'vitest';

import { LatestMetricStore } from '../src/core/metrics/latest-metric-store.js';
import { MetricPipeline } from '../src/core/metrics/metric-pipeline.js';
import type {
  MetricConsumer,
  MonitorRuntimeState,
  MonitorRuntimeStateStore,
  RuntimeMonitor,
} from '../src/core/metrics/metric-pipeline.js';
import type { Metric } from '../src/core/metrics/metric.js';

class FakeMonitorStateStore implements MonitorRuntimeStateStore {
  public readonly monitors = new Map<string, RuntimeMonitor>();
  public readonly states = new Map<string, MonitorRuntimeState>();

  public findRuntimeMonitor(id: string): RuntimeMonitor | undefined {
    return this.monitors.get(id);
  }

  public updateRuntimeState(id: string, state: MonitorRuntimeState): void {
    this.states.set(id, state);
  }
}

const baseMetric: Metric = {
  monitorId: 'mon_btc',
  source: 'binance',
  target: 'BTCUSDT',
  name: 'price',
  value: '90000',
  unit: 'USDT',
  observedAt: '2026-09-14T12:00:00.000Z',
  receivedAt: '2026-09-14T12:00:00.100Z',
  status: 'ok',
  labels: { marketType: 'spot' },
};

function setup(consumer?: MetricConsumer) {
  const monitorStates = new FakeMonitorStateStore();
  monitorStates.monitors.set('mon_btc', { id: 'mon_btc', enabled: true });
  monitorStates.monitors.set('mon_disabled', { id: 'mon_disabled', enabled: false });
  const latestMetrics = new LatestMetricStore();
  const pipeline = new MetricPipeline(monitorStates, latestMetrics, consumer === undefined ? [] : [consumer]);
  return { monitorStates, latestMetrics, pipeline };
}

describe('MetricPipeline', () => {
  it('stores a defensive latest snapshot, updates monitor state, and forwards ok metrics', async () => {
    const consume = vi.fn(async () => undefined);
    const { monitorStates, pipeline } = setup({ consume });

    const result = await pipeline.ingest(baseMetric);

    expect(result).toEqual({ accepted: true, forwardedToConsumers: true, consumerErrors: [] });
    expect(consume).toHaveBeenCalledOnce();
    expect(monitorStates.states.get('mon_btc')).toEqual({
      status: 'ok',
      lastDataAt: '2026-09-14T12:00:00.000Z',
      lastError: null,
    });

    const snapshot = pipeline.list('mon_btc');
    expect(snapshot).toEqual([baseMetric]);
    if (snapshot[0]?.labels !== undefined) snapshot[0].labels.marketType = 'mutated';
    expect(pipeline.list('mon_btc')[0]?.labels?.marketType).toBe('spot');
  });

  it('rejects duplicate and out-of-order observations without forwarding them', async () => {
    const consume = vi.fn(async () => undefined);
    const { pipeline } = setup({ consume });
    await pipeline.ingest(baseMetric);

    const duplicate = await pipeline.ingest({ ...baseMetric, receivedAt: '2026-09-14T12:00:01.000Z' });
    const older = await pipeline.ingest({
      ...baseMetric,
      value: '80000',
      observedAt: '2026-09-14T11:59:59.000Z',
      receivedAt: '2026-09-14T12:00:02.000Z',
    });

    expect(duplicate).toMatchObject({ accepted: false, reason: 'out_of_order' });
    expect(older).toMatchObject({ accepted: false, reason: 'out_of_order' });
    expect(consume).toHaveBeenCalledOnce();
    expect(pipeline.list('mon_btc')[0]?.value).toBe('90000');
  });

  it('stores non-ok metrics but does not send them to rule consumers', async () => {
    const consume = vi.fn(async () => undefined);
    const { monitorStates, pipeline } = setup({ consume });

    await pipeline.ingest({ ...baseMetric, status: 'stale' });
    await pipeline.ingest({
      ...baseMetric,
      name: 'unclaimed_token0',
      status: 'unsupported',
      observedAt: '2026-09-14T12:00:01.000Z',
    });

    expect(consume).not.toHaveBeenCalled();
    expect(pipeline.list('mon_btc')).toHaveLength(2);
    expect(monitorStates.states.get('mon_btc')?.status).toBe('stale');
  });

  it('uses absolute time when choosing the latest successful observation', async () => {
    const { monitorStates, pipeline } = setup();
    await pipeline.ingest({
      ...baseMetric,
      observedAt: '2026-09-14T20:00:00.000+08:00',
      receivedAt: '2026-09-14T12:00:00.100Z',
    });
    await pipeline.ingest({
      ...baseMetric,
      name: 'volume',
      value: '100',
      observedAt: '2026-09-14T13:00:00.000Z',
      receivedAt: '2026-09-14T13:00:00.100Z',
    });

    expect(monitorStates.states.get('mon_btc')?.lastDataAt).toBe('2026-09-14T13:00:00.000Z');
  });

  it('aggregates error, stale, warming, unsupported, and recovered statuses conservatively', async () => {
    const { monitorStates, pipeline } = setup();

    await pipeline.ingest(baseMetric);
    await pipeline.ingest({ ...baseMetric, name: 'data_age_seconds', value: '91', status: 'stale' });
    expect(monitorStates.states.get('mon_btc')?.status).toBe('stale');

    await pipeline.ingest({ ...baseMetric, name: 'optional_fee', value: 'false', status: 'unsupported' });
    expect(monitorStates.states.get('mon_btc')?.status).toBe('stale');

    await pipeline.ingest({ ...baseMetric, name: 'connection', value: 'false', status: 'error' });
    expect(monitorStates.states.get('mon_btc')).toMatchObject({
      status: 'error',
      lastError: 'connection metric reported an error',
    });

    await pipeline.ingest({
      ...baseMetric,
      name: 'connection',
      value: 'true',
      status: 'ok',
      observedAt: '2026-09-14T12:00:01.000Z',
    });
    await pipeline.ingest({
      ...baseMetric,
      name: 'data_age_seconds',
      value: '0',
      status: 'ok',
      observedAt: '2026-09-14T12:00:01.000Z',
    });
    expect(monitorStates.states.get('mon_btc')).toMatchObject({ status: 'ok', lastError: null });
  });

  it('rejects metrics for missing or disabled monitors', async () => {
    const { pipeline } = setup();
    await expect(pipeline.ingest({ ...baseMetric, monitorId: 'missing' })).resolves.toMatchObject({
      accepted: false,
      reason: 'monitor_not_found',
    });
    await expect(pipeline.ingest({ ...baseMetric, monitorId: 'mon_disabled' })).resolves.toMatchObject({
      accepted: false,
      reason: 'monitor_disabled',
    });
    expect(pipeline.list('missing')).toEqual([]);
    expect(pipeline.list('mon_disabled')).toEqual([]);
  });

  it('rejects malformed metrics through the asynchronous ingestion contract', async () => {
    const { pipeline } = setup();
    await expect(pipeline.ingest({ ...baseMetric, observedAt: 'not-a-date' })).rejects.toThrow();
    expect(pipeline.list('mon_btc')).toEqual([]);
  });

  it('serializes concurrent observations for the same monitor', async () => {
    const consumedValues: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const consumer: MetricConsumer = {
      consume: vi.fn(async (metric: Metric) => {
        consumedValues.push(String(metric.value));
        if (metric.value === '1') await firstBlocked;
      }),
    };
    const { pipeline } = setup(consumer);

    const first = pipeline.ingest({ ...baseMetric, value: '1' });
    const second = pipeline.ingest({
      ...baseMetric,
      value: '2',
      observedAt: '2026-09-14T12:00:01.000Z',
      receivedAt: '2026-09-14T12:00:01.100Z',
    });
    await Promise.resolve();
    expect(consumedValues).toEqual(['1']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(consumedValues).toEqual(['1', '2']);
  });

  it('isolates consumer failures and continues delivering to other consumers', async () => {
    const failedConsumer: MetricConsumer = { consume: vi.fn(async () => Promise.reject(new Error('rule engine unavailable'))) };
    const successfulConsume = vi.fn(async () => undefined);
    const monitorStates = new FakeMonitorStateStore();
    monitorStates.monitors.set('mon_btc', { id: 'mon_btc', enabled: true });
    const pipeline = new MetricPipeline(monitorStates, new LatestMetricStore(), [failedConsumer, { consume: successfulConsume }]);

    const result = await pipeline.ingest(baseMetric);

    expect(result).toMatchObject({ accepted: true, forwardedToConsumers: true, consumerErrors: ['rule engine unavailable'] });
    expect(successfulConsume).toHaveBeenCalledOnce();
  });
});
