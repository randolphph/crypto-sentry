import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UniswapV3Position } from '../src/adapters/uniswap/uniswap-v3-position-reader.js';
import { UniswapV3PositionCoordinator } from '../src/core/integrations/uniswap-v3-position-coordinator.js';
import { LatestMetricStore } from '../src/core/metrics/latest-metric-store.js';
import { MetricPipeline } from '../src/core/metrics/metric-pipeline.js';
import type { PollingScheduler, PollingTask } from '../src/core/scheduling/polling-scheduler.js';
import { createDatabase } from '../src/db/client.js';
import type { AppDatabase } from '../src/db/client.js';
import { IntegrationRepository } from '../src/db/repositories/integration-repository.js';
import { MonitorRepository } from '../src/db/repositories/monitor-repository.js';
import { UniswapV4OwnershipRepository } from '../src/db/repositories/uniswap-v4-ownership-repository.js';
import { EncryptionService } from '../src/security/encryption/encryption-service.js';

class CapturingScheduler {
  public readonly tasks = new Map<string, PollingTask>();
  public upsert(task: PollingTask): void { this.tasks.set(task.id, task); }
  public remove(taskId: string): void { this.tasks.delete(taskId); }
}

const databases: AppDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('Uniswap closed position cache', () => {
  it('does not reread a zero-liquidity position on every polling interval', async () => {
    const database = createDatabase(':memory:');
    databases.push(database);
    const integrations = new IntegrationRepository(database.db, new EncryptionService(Buffer.alloc(32, 8)));
    const integration = integrations.create({
      name: 'Robinhood RPC', type: 'evm_rpc', provider: 'custom', enabled: true,
      config: { chainId: 4_663, rpcUrl: 'https://rpc.example' },
    });
    const monitors = new MonitorRepository(database.db, integrations);
    const monitor = monitors.create({
      name: 'Closed LP wallet', type: 'uniswap_wallet', enabled: true, intervalSeconds: 20, maxStaleSeconds: 90,
      config: {
        rpcIntegrationId: integration.id, chainIds: [4_663], versions: ['v3'],
        walletAddress: '0x0000000000000000000000000000000000001234',
      },
    });
    const closedPosition: UniswapV3Position = {
      protocol: 'uniswap', version: 'v3', chainId: 4_663, chainName: 'Robinhood Chain', blockNumber: '100',
      tokenId: '42', owner: '0x0000000000000000000000000000000000001234',
      positionManagerAddress: '0x0000000000000000000000000000000000000001',
      poolAddress: '0x0000000000000000000000000000000000000002',
      token0: { address: '0x0000000000000000000000000000000000000010', symbol: 'USDG', decimals: 6 },
      token1: { address: '0x0000000000000000000000000000000000000020', symbol: 'WETH', decimals: 18 },
      feeTier: 500, tickLower: -100, tickUpper: 100, currentTick: 0, liquidity: '0', inRange: false,
      tokensOwed0: '1', tokensOwed1: '2',
    };
    const read = vi.fn(async () => closedPosition);
    const scheduler = new CapturingScheduler();
    const pipeline = new MetricPipeline(monitors, new LatestMetricStore());
    const coordinator = new UniswapV3PositionCoordinator(
      integrations, monitors, new UniswapV4OwnershipRepository(database.db), pipeline,
      scheduler as unknown as PollingScheduler,
      {
        now: () => new Date('2026-09-17T00:00:00.000Z'),
        closedPositionRefreshMilliseconds: 15 * 60 * 1_000,
        readerFactory: { create: () => ({
          discover: async () => ({ blockNumber: 100n, tokenIds: ['42'] }), read,
        }) },
      },
    );
    coordinator.reconcile();
    const task = scheduler.tasks.get(`uniswap:${monitor.id}`);
    if (task === undefined) throw new Error('Expected Uniswap task');
    await task.run(new AbortController().signal);
    await task.run(new AbortController().signal);
    expect(read).toHaveBeenCalledOnce();
    coordinator.close();
    await pipeline.close();
  });
});

