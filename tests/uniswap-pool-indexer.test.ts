import { afterEach, describe, expect, it, vi } from 'vitest';

import { ETHEREUM_UNISWAP_V3 } from '../src/adapters/uniswap/uniswap-v3-position-reader.js';
import type { DiscoveredUniswapPool } from '../src/adapters/uniswap/uniswap-pool-catalog-reader.js';
import { IntegrationOperationsService } from '../src/core/integrations/integration-operations-service.js';
import { UniswapPoolIndexCoordinator } from '../src/core/integrations/uniswap-pool-index-coordinator.js';
import type { PollingScheduler, PollingTask } from '../src/core/scheduling/polling-scheduler.js';
import { createDatabase } from '../src/db/client.js';
import type { AppDatabase } from '../src/db/client.js';
import { ChainScanCursorRepository } from '../src/db/repositories/chain-scan-cursor-repository.js';
import { IntegrationNetworkHealthRepository } from '../src/db/repositories/integration-network-health-repository.js';
import { IntegrationRepository } from '../src/db/repositories/integration-repository.js';
import { MarketRepository } from '../src/db/repositories/market-repository.js';
import { UniswapPoolRepository } from '../src/db/repositories/uniswap-pool-repository.js';
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

function fixture(
  scan: (version: 'v3' | 'v4', from: bigint, to: bigint, signal?: AbortSignal) => Promise<DiscoveredUniswapPool[]>,
  latest: bigint,
) {
  const database = createDatabase(':memory:');
  databases.push(database);
  const integrations = new IntegrationRepository(database.db, new EncryptionService(Buffer.alloc(32, 6)));
  const integration = integrations.create({
    name: 'Ethereum', type: 'evm_rpc', provider: 'custom', enabled: true,
    config: { chainId: 1, rpcUrl: 'https://rpc.invalid' },
  });
  const health = new IntegrationNetworkHealthRepository(database.db);
  health.replace({
    integrationId: integration.id, chainId: 1, rpcStatus: 'ok', aaveV3Status: 'ok',
    aaveAccountReadStatus: 'ok', aaveReserveCatalogStatus: 'ok', aaveEventLogsStatus: 'ok',
    uniswapV3Status: 'ok', uniswapV4Status: 'error', blockNumber: latest.toString(), errorCode: null,
    testedAt: '2026-09-16T00:00:00.000Z',
  });
  const pools = new UniswapPoolRepository(database.db);
  const cursors = new ChainScanCursorRepository(database.db);
  const scheduler = new CapturingScheduler();
  const coordinator = new UniswapPoolIndexCoordinator(
    integrations, health, pools, cursors, scheduler as unknown as PollingScheduler,
    {
      readerFactory: { create: () => ({ latestBlock: async () => latest, scan }) },
      maximumChunksPerRun: 1,
      failureBackoffMilliseconds: 0,
    },
  );
  coordinator.reconcile();
  const task = scheduler.tasks.get(`uniswap-pools:${integration.id}:1:v3`);
  if (task === undefined) throw new Error('Indexer task missing');
  return { database, integrations, integration, health, pools, cursors, coordinator, task, scheduler };
}

describe('Uniswap pool adaptive indexer', () => {
  it('backs off failed provider runs without issuing another RPC request', async () => {
    let nowMilliseconds = 0;
    const scan = vi.fn(async (): Promise<DiscoveredUniswapPool[]> => {
      throw new Error('provider unavailable');
    });
    const database = createDatabase(':memory:');
    databases.push(database);
    const integrations = new IntegrationRepository(database.db, new EncryptionService(Buffer.alloc(32, 7)));
    const integration = integrations.create({
      name: 'Ethereum', type: 'evm_rpc', provider: 'custom', enabled: true,
      config: { chainId: 1, rpcUrl: 'https://rpc.invalid' },
    });
    const health = new IntegrationNetworkHealthRepository(database.db);
    health.replace({
      integrationId: integration.id, chainId: 1, rpcStatus: 'ok', aaveV3Status: 'ok',
      aaveAccountReadStatus: 'ok', aaveReserveCatalogStatus: 'ok', aaveEventLogsStatus: 'ok',
      uniswapV3Status: 'ok', uniswapV4Status: 'error', blockNumber: (ETHEREUM_UNISWAP_V3.deploymentBlock + 12n).toString(),
      errorCode: null, testedAt: '2026-09-16T00:00:00.000Z',
    });
    const scheduler = new CapturingScheduler();
    const coordinator = new UniswapPoolIndexCoordinator(
      integrations, health, new UniswapPoolRepository(database.db), new ChainScanCursorRepository(database.db),
      scheduler as unknown as PollingScheduler,
      {
        readerFactory: { create: () => ({ latestBlock: async () => ETHEREUM_UNISWAP_V3.deploymentBlock + 12n, scan }) },
        maximumChunksPerRun: 1, failureBackoffMilliseconds: 1_000, now: () => new Date(nowMilliseconds),
      },
    );
    coordinator.reconcile();
    const task = scheduler.tasks.get(`uniswap-pools:${integration.id}:1:v3`);
    if (task === undefined) throw new Error('Indexer task missing');
    await task.run(new AbortController().signal);
    await task.run(new AbortController().signal);
    expect(scan).toHaveBeenCalledTimes(1);
    nowMilliseconds = 1_000;
    await task.run(new AbortController().signal);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('bisects a rejected 100000-block request and persists every successful subrange', async () => {
    const deployment = ETHEREUM_UNISWAP_V3.deploymentBlock;
    const confirmed = deployment + 99_999n;
    const scan = vi.fn(async (_version: 'v3' | 'v4', from: bigint, to: bigint) => {
      if (to - from + 1n > 10_000n) throw new Error('block range too wide');
      return [];
    });
    const { task, cursors, integration, pools } = fixture(scan, confirmed + 12n);

    await task.run(new AbortController().signal);

    expect(scan.mock.calls.length).toBeGreaterThan(2);
    expect(cursors.get(integration.id, 'uniswap', 1, 'pools:v3')).toBe(confirmed);
    expect(pools.getIndexerState(integration.id, 1, 'v3')).toMatchObject({ status: 'ok', lastErrorCode: null });
  });

  it('resumes from the last successful cursor with the configured reorg rewind after a middle failure', async () => {
    const deployment = ETHEREUM_UNISWAP_V3.deploymentBlock;
    const confirmed = deployment + 140n;
    const failingBlock = deployment + 110n;
    let fail = true;
    const scan = vi.fn(async (_version: 'v3' | 'v4', from: bigint, to: bigint) => {
      if (fail && from <= failingBlock && to >= failingBlock) throw new Error('single block provider failure');
      return [] as never[];
    });
    const setup = fixture(scan, confirmed + 12n);
    setup.cursors.save(setup.integration.id, 'uniswap', 1, 'pools:v3', deployment + 100n);
    setup.coordinator.close();
    const scheduler = setup.scheduler;
    // Reconcile re-registers the task while retaining the persisted cursor.
    setup.coordinator.reconcile();
    const task = scheduler.tasks.get(`uniswap-pools:${setup.integration.id}:1:v3`);
    if (task === undefined) throw new Error('Indexer task missing after reconcile');
    await task.run(new AbortController().signal);
    const afterFailure = setup.cursors.get(setup.integration.id, 'uniswap', 1, 'pools:v3');
    expect(afterFailure).toBeDefined();
    expect(afterFailure as bigint).toBeGreaterThan(deployment + 100n);
    expect(setup.pools.getIndexerState(setup.integration.id, 1, 'v3')?.status).toBe('error');
    const catalog = new IntegrationOperationsService(
      setup.integrations, new MarketRepository(setup.database.db), setup.health,
      globalThis.fetch, undefined, undefined, undefined, setup.pools, setup.cursors,
    ).uniswapPoolCatalog(setup.integration.id, { chainId: 1, version: 'v3', limit: 50 });
    expect(catalog).toMatchObject({
      status: 'partial',
      discovery: { lastError: 'INDEXER_PARTIAL_FAILURE' },
      error: { code: 'INDEXER_PARTIAL_FAILURE' },
    });
    expect(catalog.discovery.lastAttemptAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    fail = false;
    scan.mockClear();
    await task.run(new AbortController().signal);
    expect(scan.mock.calls[0]?.[1]).toBe((afterFailure as bigint) - 11n);
    expect(setup.cursors.get(setup.integration.id, 'uniswap', 1, 'pools:v3')).toBe(confirmed);
  });

  it('stops adaptive splitting immediately when aborted', async () => {
    const deployment = ETHEREUM_UNISWAP_V3.deploymentBlock;
    const controller = new AbortController();
    const scan = vi.fn(async () => {
      controller.abort();
      throw new Error('aborted range');
    });
    const { task } = fixture(scan, deployment + 100_011n);

    await task.run(controller.signal);

    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('advances the cursor and retains a pool when one token metadata read is partial', async () => {
    const deployment = ETHEREUM_UNISWAP_V3.deploymentBlock;
    const scan = vi.fn(async (): Promise<DiscoveredUniswapPool[]> => [{
      chainId: 1, version: 'v3', resourceId: '0x00000000000000000000000000000000000000aa',
      poolAddress: '0x00000000000000000000000000000000000000AA', poolId: null,
      token0: {
        address: '0x0000000000000000000000000000000000000010', symbol: null, decimals: null,
        native: false, status: 'error',
      },
      token1: {
        address: '0x0000000000000000000000000000000000000020', symbol: 'USDC', decimals: 6,
        native: false, status: 'ok',
      },
      feeTier: 500, tickSpacing: 10, hooksAddress: null, discoveredAtBlock: deployment.toString(),
    }]);
    const { task, pools, integration, cursors } = fixture(scan, deployment + 12n);

    await task.run(new AbortController().signal);

    expect(cursors.get(integration.id, 'uniswap', 1, 'pools:v3')).toBe(deployment);
    expect(pools.list({ integrationId: integration.id, chainId: 1, version: 'v3', limit: 50 }).items[0])
      .toMatchObject({ token0Symbol: null, token0Decimals: null, token1Symbol: 'USDC' });
  });
});
