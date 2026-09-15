import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AaveV3Position } from '../src/adapters/aave/aave-v3-position-reader.js';
import {
  AaveV3PositionCoordinator,
} from '../src/core/integrations/aave-v3-position-coordinator.js';
import type {
  AaveV3PositionReaderFactory,
} from '../src/core/integrations/aave-v3-position-coordinator.js';
import { LatestMetricStore } from '../src/core/metrics/latest-metric-store.js';
import { MetricPipeline } from '../src/core/metrics/metric-pipeline.js';
import type { PollingScheduler, PollingTask } from '../src/core/scheduling/polling-scheduler.js';
import { createDatabase } from '../src/db/client.js';
import type { AppDatabase } from '../src/db/client.js';
import { IntegrationRepository } from '../src/db/repositories/integration-repository.js';
import { MonitorRepository } from '../src/db/repositories/monitor-repository.js';
import { EncryptionService } from '../src/security/encryption/encryption-service.js';

const walletAddress = '0x0000000000000000000000000000000000001234';
const position: AaveV3Position = {
  chainId: 1,
  chainName: 'Ethereum',
  blockNumber: '12345678',
  walletAddress,
  baseCurrencySymbol: 'USD',
  totalCollateralBase: '5000',
  totalDebtBase: '1000',
  availableBorrowsBase: '2500',
  liquidationThresholdPercent: '82.5',
  ltvPercent: '75',
  healthFactor: '1.5',
  assets: [],
};

class CapturingScheduler {
  public readonly tasks = new Map<string, PollingTask>();

  public upsert(task: PollingTask): void {
    this.tasks.set(task.id, task);
  }

  public remove(taskId: string): void {
    this.tasks.delete(taskId);
  }
}

interface Fixture {
  database: AppDatabase;
  integrations: IntegrationRepository;
  monitors: MonitorRepository;
  pipeline: MetricPipeline;
  scheduler: CapturingScheduler;
  monitorId: string;
}

const databases: AppDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
});

function createFixture(rpcUrls: string[]): Fixture {
  const database = createDatabase(':memory:');
  databases.push(database);
  const integrations = new IntegrationRepository(database.db, new EncryptionService(Buffer.alloc(32, 5)));
  for (const [index, rpcUrl] of rpcUrls.entries()) {
    integrations.create({
      name: `Ethereum RPC ${index + 1}`,
      type: 'evm_rpc',
      provider: 'custom',
      enabled: true,
      config: { chainId: 1, rpcUrl },
    });
  }
  const monitors = new MonitorRepository(database.db);
  const monitor = monitors.create({
    name: 'Aave account',
    type: 'aave_position',
    enabled: true,
    intervalSeconds: 20,
    maxStaleSeconds: 90,
    config: { walletAddress },
  });
  const pipeline = new MetricPipeline(monitors, new LatestMetricStore());
  return { database, integrations, monitors, pipeline, scheduler: new CapturingScheduler(), monitorId: monitor.id };
}

function task(fixture: Fixture, prefix: string): PollingTask {
  const scheduled = fixture.scheduler.tasks.get(`${prefix}:${fixture.monitorId}`);
  if (scheduled === undefined) throw new Error(`Expected scheduled task ${prefix}`);
  return scheduled;
}

describe('AaveV3PositionCoordinator resilience', () => {
  it('retries a failed endpoint and falls back to the next RPC', async () => {
    const fixture = createFixture(['https://primary.example', 'https://backup.example']);
    const primaryRead = vi.fn(async () => Promise.reject(new Error('primary unavailable')));
    const backupRead = vi.fn(async () => position);
    const factory: AaveV3PositionReaderFactory = {
      create: ({ rpcUrl }) => ({ read: rpcUrl.includes('primary') ? primaryRead : backupRead }),
    };
    const coordinator = new AaveV3PositionCoordinator(
      fixture.integrations,
      fixture.monitors,
      fixture.pipeline,
      fixture.scheduler as unknown as PollingScheduler,
      {
        readerFactory: factory,
        retryBaseDelayMilliseconds: 1,
        sleep: async () => undefined,
      },
    );
    coordinator.reconcile();

    await task(fixture, 'aave-v3').run(new AbortController().signal);

    expect(primaryRead).toHaveBeenCalledTimes(2);
    expect(backupRead).toHaveBeenCalledOnce();
    expect(fixture.pipeline.list(fixture.monitorId).find(({ name }) => name === 'rpc_status')).toMatchObject({
      status: 'ok', value: true,
    });
    coordinator.close();
    await fixture.pipeline.close();
  });

  it('opens a failing endpoint circuit and retries after the cooldown', async () => {
    const fixture = createFixture(['https://primary.example']);
    let now = new Date('2026-09-14T12:00:00.000Z');
    const read = vi.fn<() => Promise<AaveV3Position | undefined>>().mockRejectedValue(new Error('unavailable'));
    const coordinator = new AaveV3PositionCoordinator(
      fixture.integrations,
      fixture.monitors,
      fixture.pipeline,
      fixture.scheduler as unknown as PollingScheduler,
      {
        readerFactory: { create: () => ({ read }) },
        now: () => now,
        maximumAttemptsPerEndpoint: 1,
        circuitBreakerFailureThreshold: 2,
        circuitBreakerCooldownMilliseconds: 60_000,
      },
    );
    coordinator.reconcile();
    const scan = task(fixture, 'aave-v3');

    await scan.run(new AbortController().signal);
    now = new Date('2026-09-14T12:00:01.000Z');
    await scan.run(new AbortController().signal);
    now = new Date('2026-09-14T12:00:02.000Z');
    await scan.run(new AbortController().signal);
    expect(read).toHaveBeenCalledTimes(2);

    read.mockResolvedValue(position);
    now = new Date('2026-09-14T12:01:02.001Z');
    await scan.run(new AbortController().signal);
    expect(read).toHaveBeenCalledTimes(3);
    expect(fixture.pipeline.list(fixture.monitorId).find(({ name }) => name === 'rpc_status')).toMatchObject({
      status: 'ok', value: true,
    });
    coordinator.close();
    await fixture.pipeline.close();
  });

  it('emits stale data age when successful scans stop arriving', async () => {
    const fixture = createFixture(['https://primary.example']);
    let now = new Date('2026-09-14T12:00:00.000Z');
    const coordinator = new AaveV3PositionCoordinator(
      fixture.integrations,
      fixture.monitors,
      fixture.pipeline,
      fixture.scheduler as unknown as PollingScheduler,
      {
        readerFactory: { create: () => ({ read: async () => position }) },
        now: () => now,
      },
    );
    coordinator.reconcile();
    await task(fixture, 'aave-v3').run(new AbortController().signal);

    now = new Date('2026-09-14T12:01:31.000Z');
    await task(fixture, 'aave-v3-stale').run(new AbortController().signal);

    expect(fixture.pipeline.list(fixture.monitorId).find(({ name }) => name === 'data_age_seconds')).toMatchObject({
      value: '91',
      status: 'stale',
    });
    expect(fixture.monitors.get(fixture.monitorId).lastStatus).toBe('stale');
    coordinator.close();
    await fixture.pipeline.close();
  });
});
