import { afterEach, describe, expect, it } from 'vitest';

import { UniswapPoolCoordinator } from '../src/core/integrations/uniswap-pool-coordinator.js';
import { LatestMetricStore } from '../src/core/metrics/latest-metric-store.js';
import { MetricPipeline } from '../src/core/metrics/metric-pipeline.js';
import { MonitorSnapshotService } from '../src/core/positions/monitor-snapshot-service.js';
import type { PollingScheduler, PollingTask } from '../src/core/scheduling/polling-scheduler.js';
import { createDatabase } from '../src/db/client.js';
import type { AppDatabase } from '../src/db/client.js';
import { ChainScanCursorRepository } from '../src/db/repositories/chain-scan-cursor-repository.js';
import { IntegrationRepository } from '../src/db/repositories/integration-repository.js';
import { MetricEventRepository } from '../src/db/repositories/metric-event-repository.js';
import { MonitorRepository } from '../src/db/repositories/monitor-repository.js';
import { RuleRepository } from '../src/db/repositories/rule-repository.js';
import { UniswapPoolRepository } from '../src/db/repositories/uniswap-pool-repository.js';
import { UniswapPoolSwapSampleRepository } from '../src/db/repositories/uniswap-pool-swap-sample-repository.js';
import { EncryptionService } from '../src/security/encryption/encryption-service.js';

class CapturingScheduler {
  public readonly tasks = new Map<string, PollingTask>();

  public upsert(task: PollingTask): void {
    this.tasks.set(task.id, task);
  }

  public remove(id: string): void {
    this.tasks.delete(id);
  }
}

const databases: AppDatabase[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe('Uniswap pool rolling volume', () => {
  it('persists deduplicated swap samples and calculates adjacent rolling windows after restart', async () => {
    const database = createDatabase(':memory:');
    databases.push(database);
    const integrations = new IntegrationRepository(database.db, new EncryptionService(Buffer.alloc(32, 7)));
    const integration = integrations.create({
      name: 'Ethereum', type: 'evm_rpc', provider: 'custom', enabled: true,
      config: { chainId: 1, rpcUrl: 'https://rpc.invalid' },
    });
    const poolAddress = '0x00000000000000000000000000000000000000aa';
    const pools = new UniswapPoolRepository(database.db);
    pools.upsert({
      integrationId: integration.id, chainId: 1, version: 'v3', resourceId: poolAddress,
      poolAddress, poolId: null,
      token0Address: '0x0000000000000000000000000000000000000010', token0Symbol: 'WETH',
      token0Decimals: 18, token0Native: false,
      token1Address: '0x0000000000000000000000000000000000000020', token1Symbol: 'USDC',
      token1Decimals: 6, token1Native: false, feeTier: 500, tickSpacing: 10, hooksAddress: null,
      discoveredAtBlock: '100', updatedAt: '2026-09-16T00:00:00.000Z',
    });
    const monitors = new MonitorRepository(database.db, integrations);
    const monitor = monitors.create({
      name: 'WETH/USDC', type: 'uniswap_pool', enabled: true, intervalSeconds: 20, maxStaleSeconds: 90,
      config: { rpcIntegrationId: integration.id, chainId: 1, version: 'v3', poolAddress },
    });
    new RuleRepository(database.db).create({
      monitorId: monitor.id, name: 'Volume acceleration', combinator: 'and',
      conditions: [{
        metric: 'volume_change_percent', labels: {}, windowSeconds: 60,
        operator: 'gte', threshold: '50', hysteresis: '0',
      }],
      durationSeconds: 0, cooldownSeconds: 60, severity: 'warning', notificationIntegrationIds: [], enabled: true,
    });
    new RuleRepository(database.db).create({
      monitorId: monitor.id, name: 'Two minute volume', combinator: 'and',
      conditions: [{
        metric: 'volume_token0', labels: {}, windowSeconds: 120,
        operator: 'gte', threshold: '1', hysteresis: '0',
      }],
      durationSeconds: 0, cooldownSeconds: 60, severity: 'warning', notificationIntegrationIds: [], enabled: true,
    });
    const latest = new LatestMetricStore();
    const pipeline = new MetricPipeline(monitors, latest, [], new MetricEventRepository(database.db));
    const cursors = new ChainScanCursorRepository(database.db);
    let now = new Date('2026-09-16T00:00:31.000Z');
    let readCount = 0;
    const readerFactory = { create: () => ({
      latestBlock: async () => 200n,
      read: async () => {
        readCount += 1;
        const first = readCount === 1;
        return {
          blockNumber: first ? '187' : '188', currentTick: 100, token0Price: '2000', token1Price: '0.0005',
          activeLiquidity: '1000', tvlToken0: '10', tvlToken1: '20000', lpFee: '500', protocolFee: '0',
          events: [{
            eventId: first ? '1:0xfirst:1' : '1:0xsecond:1', eventType: 'swap' as const,
            blockNumber: first ? '187' : '188', transactionHash: first ? '0xfirst' : '0xsecond', logIndex: 1,
            amount0: first ? '-1' : '-2', amount1: first ? '2000' : '4000',
            observedAt: first ? '2026-09-16T00:00:30.000Z' : '2026-09-16T00:01:30.000Z',
          }],
        };
      },
    }) };
    const firstScheduler = new CapturingScheduler();
    const firstCoordinator = new UniswapPoolCoordinator(
      integrations, monitors, pools, cursors, pipeline, firstScheduler as unknown as PollingScheduler,
      { readerFactory, samples: new UniswapPoolSwapSampleRepository(database.db), now: () => now },
    );
    firstCoordinator.reconcile();
    const firstTask = firstScheduler.tasks.get(`uniswap-pool:${monitor.id}`);
    if (firstTask === undefined) throw new Error('Pool monitor task missing');
    await firstTask.run(new AbortController().signal);
    firstCoordinator.close();

    now = new Date('2026-09-16T00:02:00.000Z');
    const restartedSamples = new UniswapPoolSwapSampleRepository(database.db);
    const secondScheduler = new CapturingScheduler();
    const restarted = new UniswapPoolCoordinator(
      integrations, monitors, pools, cursors, pipeline, secondScheduler as unknown as PollingScheduler,
      { readerFactory, samples: restartedSamples, now: () => now },
    );
    restarted.reconcile();
    const secondTask = secondScheduler.tasks.get(`uniswap-pool:${monitor.id}`);
    if (secondTask === undefined) throw new Error('Restarted pool monitor task missing');
    await secondTask.run(new AbortController().signal);
    await secondTask.run(new AbortController().signal);

    expect(restartedSamples.listSince(monitor.id, '2026-09-15T00:00:00.000Z')).toHaveLength(2);
    const snapshot = new MonitorSnapshotService(monitors, latest, () => now).get(monitor.id);
    expect(snapshot).toMatchObject({
      data: { volumes: [{
        windowSeconds: '60', volumeToken0: '2', volumeToken1: '4000',
        volumeUsd: '4000', volumeChangePercent: '100', status: 'ok',
      }, {
        windowSeconds: '120', volumeToken0: '3', volumeToken1: '6000',
        volumeUsd: '6000', volumeChangePercent: null, status: 'warming_up',
      }] },
    });

    restarted.close();
    await pipeline.close();
  });
});
