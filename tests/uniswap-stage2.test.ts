import { afterEach, describe, expect, it, vi } from 'vitest';

import { ETHEREUM_UNISWAP_V3 } from '../src/adapters/uniswap/uniswap-v3-position-reader.js';
import { ETHEREUM_UNISWAP_V4 } from '../src/adapters/uniswap/uniswap-v4-position-reader.js';
import { UniswapPoolIndexCoordinator } from '../src/core/integrations/uniswap-pool-index-coordinator.js';
import { UniswapPoolCoordinator } from '../src/core/integrations/uniswap-pool-coordinator.js';
import { LatestMetricStore } from '../src/core/metrics/latest-metric-store.js';
import { MetricPipeline } from '../src/core/metrics/metric-pipeline.js';
import { MonitorSnapshotService } from '../src/core/positions/monitor-snapshot-service.js';
import type { PollingScheduler, PollingTask } from '../src/core/scheduling/polling-scheduler.js';
import { createDatabase } from '../src/db/client.js';
import type { AppDatabase } from '../src/db/client.js';
import { ChainScanCursorRepository } from '../src/db/repositories/chain-scan-cursor-repository.js';
import { IntegrationNetworkHealthRepository } from '../src/db/repositories/integration-network-health-repository.js';
import { IntegrationRepository } from '../src/db/repositories/integration-repository.js';
import { MetricEventRepository } from '../src/db/repositories/metric-event-repository.js';
import { MonitorRepository } from '../src/db/repositories/monitor-repository.js';
import { UniswapPoolRepository } from '../src/db/repositories/uniswap-pool-repository.js';
import { EncryptionService } from '../src/security/encryption/encryption-service.js';

class CapturingScheduler {
  public readonly tasks = new Map<string, PollingTask>();
  public upsert(task: PollingTask): void { this.tasks.set(task.id, task); }
  public remove(id: string): void { this.tasks.delete(id); }
}

const databases: AppDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('Uniswap phase 2 resources and pool monitor', () => {
  it('publishes official Ethereum V3 and V4 deployments', () => {
    expect(ETHEREUM_UNISWAP_V3).toMatchObject({ chainId: 1, chainName: 'Ethereum' });
    expect(ETHEREUM_UNISWAP_V4).toMatchObject({ chainId: 1, chainName: 'Ethereum' });
    expect(ETHEREUM_UNISWAP_V3.factoryAddress).toMatch(/^0x[0-9A-Fa-f]{40}$/);
    expect(ETHEREUM_UNISWAP_V4.poolManagerAddress).toMatch(/^0x[0-9A-Fa-f]{40}$/);
  });

  it('resumes pool indexing with a reorg rewind and values a stablecoin pool from its on-chain price', async () => {
    const database = createDatabase(':memory:');
    databases.push(database);
    const integrations = new IntegrationRepository(database.db, new EncryptionService(Buffer.alloc(32, 3)));
    const integration = integrations.create({
      name: 'Ethereum', type: 'evm_rpc', provider: 'custom', enabled: true,
      config: { chainId: 1, rpcUrl: 'https://rpc.invalid' },
    });
    const health = new IntegrationNetworkHealthRepository(database.db);
    health.replace({
      integrationId: integration.id, chainId: 1, rpcStatus: 'ok', aaveV3Status: 'ok',
      aaveAccountReadStatus: 'ok', aaveReserveCatalogStatus: 'ok', aaveEventLogsStatus: 'ok',
      uniswapV3Status: 'ok', uniswapV4Status: 'ok', blockNumber: '12379633', errorCode: null,
      testedAt: '2026-09-16T00:00:00.000Z',
    });
    const pools = new UniswapPoolRepository(database.db);
    const cursors = new ChainScanCursorRepository(database.db);
    const scheduler = new CapturingScheduler();
    const scan = vi.fn(async () => [{
      chainId: 1, version: 'v3' as const,
      resourceId: '0x00000000000000000000000000000000000000aa',
      poolAddress: '0x00000000000000000000000000000000000000AA' as const, poolId: null,
      token0: { address: '0x0000000000000000000000000000000000000010' as const, symbol: 'WETH', decimals: 18, native: false, status: 'ok' as const },
      token1: { address: '0x0000000000000000000000000000000000000020' as const, symbol: 'USDC', decimals: 6, native: false, status: 'ok' as const },
      feeTier: 500, tickSpacing: 10, hooksAddress: null, discoveredAtBlock: '12369630',
    }]);
    const indexer = new UniswapPoolIndexCoordinator(
      integrations, health, pools, cursors, scheduler as unknown as PollingScheduler,
      { readerFactory: { create: () => ({ latestBlock: async () => 12_369_633n, scan }) } },
    );
    indexer.reconcile();
    const indexTask = scheduler.tasks.get(`uniswap-pools:${integration.id}:1:v3`);
    if (indexTask === undefined) throw new Error('Pool index task was not scheduled');
    await indexTask.run(new AbortController().signal);
    await indexTask.run(new AbortController().signal);
    expect(scan).toHaveBeenNthCalledWith(1, 'v3', ETHEREUM_UNISWAP_V3.deploymentBlock, 12_369_621n, expect.any(AbortSignal));
    expect(scan).toHaveBeenNthCalledWith(
      2, 'v3', ETHEREUM_UNISWAP_V3.deploymentBlock, 12_369_621n, expect.any(AbortSignal),
    );
    expect(pools.list({ integrationId: integration.id, chainId: 1, version: 'v3', limit: 50 }).items).toHaveLength(1);
    expect(pools.list({ integrationId: integration.id, chainId: 1, version: 'v3', q: '500', limit: 50 }).items).toHaveLength(1);

    const monitors = new MonitorRepository(database.db, integrations);
    const monitor = monitors.create({
      name: 'WETH/USDC', type: 'uniswap_pool', enabled: true, intervalSeconds: 20, maxStaleSeconds: 90,
      config: { rpcIntegrationId: integration.id, chainId: 1, version: 'v3', poolAddress: '0x00000000000000000000000000000000000000aa' },
    });
    const latest = new LatestMetricStore();
    const pipeline = new MetricPipeline(monitors, latest, [], new MetricEventRepository(database.db));
    const poolCoordinator = new UniswapPoolCoordinator(
      integrations, monitors, pools, cursors, pipeline, scheduler as unknown as PollingScheduler,
      { readerFactory: { create: () => ({ latestBlock: async () => 200n, read: async () => ({
        blockNumber: '188', currentTick: 100, token0Price: '2000', token1Price: '0.0005',
        activeLiquidity: '12345678901234567890', tvlToken0: '10', tvlToken1: '20000', lpFee: '500', protocolFee: '0',
        events: [{
          eventId: '1:0xabc:1', eventType: 'swap', blockNumber: '188', transactionHash: '0xabc', logIndex: 1,
          amount0: '1', amount1: '2000', observedAt: '2026-09-16T00:00:00.000Z',
        }],
      }) }) }, now: () => new Date('2026-09-16T00:00:00.000Z') },
    );
    poolCoordinator.reconcile();
    const monitorTask = scheduler.tasks.get(`uniswap-pool:${monitor.id}`);
    if (monitorTask === undefined) throw new Error('Pool monitor task was not scheduled');
    await monitorTask.run(new AbortController().signal);
    await monitorTask.run(new AbortController().signal);
    expect(latest.list(monitor.id).filter((metric) => metric.kind === 'event')).toHaveLength(1);
    const snapshot = new MonitorSnapshotService(monitors, latest, () => new Date('2026-09-16T00:00:01.000Z')).get(monitor.id);
    expect(snapshot).toMatchObject({
      monitorType: 'uniswap_pool', status: 'ok', capability: { available: true },
      summary: { valuationCoverage: 'full' },
      data: {
        pool: { currentTick: '100', tvlToken0: '10', tvlToken1: '20000', tvlUsd: '40000', valuationStatus: 'ok' },
        discovery: { caughtUp: true, scannedThroughBlock: '188', chainTipBlock: '200' },
        recentEvents: [{ amountUsd: '2000', valuationStatus: 'ok' }],
      },
      error: null,
    });
    poolCoordinator.close();
    indexer.close();
    await pipeline.close();
  });
});
