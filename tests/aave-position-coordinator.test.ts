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
import { ProtocolMetricSampleRepository } from '../src/db/repositories/protocol-metric-sample-repository.js';
import { RuleRepository } from '../src/db/repositories/rule-repository.js';
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
  it('emits a position-opened event from the chain event that caused a persisted account state transition', async () => {
    const database = createDatabase(':memory:');
    databases.push(database);
    const integrations = new IntegrationRepository(database.db, new EncryptionService(Buffer.alloc(32, 5)));
    const integration = integrations.create({
      name: 'Ethereum', type: 'evm_rpc', provider: 'custom', enabled: true,
      config: { chainId: 1, rpcUrl: 'https://rpc.example' },
    });
    const monitors = new MonitorRepository(database.db, integrations);
    const monitor = monitors.create({
      name: 'Aave account', type: 'aave_account', enabled: true, intervalSeconds: 20, maxStaleSeconds: 90,
      config: { rpcIntegrationId: integration.id, chainId: 1, walletAddress },
    });
    let now = new Date('2026-09-16T00:00:00.000Z');
    let collateral = '0';
    const latest = new LatestMetricStore();
    const pipeline = new MetricPipeline(monitors, latest);
    const scheduler = new CapturingScheduler();
    const coordinator = new AaveV3PositionCoordinator(
      integrations, monitors, pipeline, scheduler as unknown as PollingScheduler,
      {
        now: () => now, samples: new ProtocolMetricSampleRepository(database.db),
        readerFactory: { create: () => ({ read: async () => ({ ...position, totalCollateralBase: collateral, totalDebtBase: '0' }) }) },
      },
    );
    coordinator.reconcile();
    const scan = scheduler.tasks.get(`aave-v3:${monitor.id}`);
    if (scan === undefined) throw new Error('Aave account task was not scheduled');
    await scan.run(new AbortController().signal);
    await pipeline.ingest({
      monitorId: monitor.id, source: 'aave_v3', target: walletAddress, name: 'account_supply', value: '1', unit: 'USDC',
      observedAt: '2026-09-16T00:00:10.000Z', receivedAt: '2026-09-16T00:00:11.000Z', status: 'ok',
      kind: 'event', eventId: '1:0xabc:7', labels: { blockNumber: '124', chainId: '1' },
    });
    now = new Date('2026-09-16T00:00:20.000Z');
    collateral = '1';
    await scan.run(new AbortController().signal);

    expect(latest.list(monitor.id).find((metric) => metric.name === 'account_position_opened')).toMatchObject({
      kind: 'event', eventId: '1:0xabc:7', value: true,
    });
    coordinator.close();
    await pipeline.close();
  });

  it('represents no debt as an infinite health factor and restores account change windows from SQLite', async () => {
    const database = createDatabase(':memory:');
    databases.push(database);
    const integrations = new IntegrationRepository(database.db, new EncryptionService(Buffer.alloc(32, 5)));
    const integration = integrations.create({
      name: 'Ethereum', type: 'evm_rpc', provider: 'custom', enabled: true,
      config: { chainId: 1, rpcUrl: 'https://rpc.example' },
    });
    const monitors = new MonitorRepository(database.db, integrations);
    const monitor = monitors.create({
      name: 'Aave account', type: 'aave_account', enabled: true, intervalSeconds: 20, maxStaleSeconds: 90,
      config: { rpcIntegrationId: integration.id, chainId: 1, walletAddress },
    });
    new RuleRepository(database.db).create({
      monitorId: monitor.id, name: 'Collateral change', combinator: 'and', durationSeconds: 0,
      cooldownSeconds: 60, severity: 'warning', notificationIntegrationIds: [], enabled: true,
      conditions: [{
        metric: 'total_collateral_change_percent', labels: { windowSeconds: '300' }, operator: 'gte',
        threshold: '5', windowSeconds: 300, hysteresis: '0',
      }],
    });
    let now = new Date('2026-09-16T00:00:00.000Z');
    let collateral = '100';
    const latest = new LatestMetricStore();
    const pipeline = new MetricPipeline(monitors, latest);
    const scheduler = new CapturingScheduler();
    const coordinator = new AaveV3PositionCoordinator(
      integrations, monitors, pipeline, scheduler as unknown as PollingScheduler,
      {
        now: () => now,
        samples: new ProtocolMetricSampleRepository(database.db),
        readerFactory: { create: () => ({ read: async () => ({
          ...position, totalCollateralBase: collateral, totalDebtBase: '0', healthFactor: '115792089237316195423570985008687907853269984665640564039457.584007913129639935',
        }) }) },
      },
    );
    coordinator.reconcile();
    const scan = scheduler.tasks.get(`aave-v3:${monitor.id}`);
    if (scan === undefined) throw new Error('Aave account task was not scheduled');
    await scan.run(new AbortController().signal);
    expect(latest.list(monitor.id).find((metric) => metric.name === 'health_factor')).toMatchObject({
      value: 'unavailable', status: 'unsupported',
    });
    expect(latest.list(monitor.id).find((metric) => metric.name === 'health_factor_infinite')).toMatchObject({ value: true });
    expect(latest.list(monitor.id).find((metric) => metric.name === 'total_collateral_change_percent')).toMatchObject({ status: 'warming_up' });

    now = new Date('2026-09-16T00:05:00.000Z');
    collateral = '110';
    await scan.run(new AbortController().signal);
    expect(latest.list(monitor.id).find((metric) => metric.name === 'total_collateral_change_base')).toMatchObject({ value: '10', status: 'ok' });
    const collateralChange = latest.list(monitor.id).find((metric) => metric.name === 'total_collateral_change_percent');
    expect(collateralChange).toMatchObject({ value: '10', status: 'ok' });
    expect(collateralChange?.labels?.windowSeconds).toBe('300');
    coordinator.close();
    await pipeline.close();
  });

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
