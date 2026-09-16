import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';

import { AaveV3ReserveCatalogReader } from '../src/adapters/aave/aave-v3-reserve-catalog-reader.js';
import { supportedAaveV3Markets } from '../src/adapters/aave/aave-v3-position-reader.js';
import type { AaveV3ChainEvent } from '../src/adapters/aave/aave-v3-event-reader.js';
import { AaveV3EventCoordinator } from '../src/core/integrations/aave-v3-event-coordinator.js';
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

describe('Aave phase 2 resources and events', () => {
  it('returns official reserves and preserves token metadata when one price is unavailable', async () => {
    const market = supportedAaveV3Markets.get(1);
    if (market === undefined) throw new Error('Ethereum Aave deployment is missing');
    const results = market.assets.flatMap((_asset, index) => [
      { status: 'success', result: [6n, 0n, 0n, 0n, 0n, true, true, false, true, false] },
      index === 0 ? { status: 'failure', error: new Error('oracle unavailable') } : { status: 'success', result: 100_000_000n },
      { status: 'success', result: `Reserve ${index}` },
    ]);
    const publicClient = {
      getChainId: vi.fn(async () => 1),
      getBlockNumber: vi.fn(async () => 123n),
      readContract: vi.fn(async () => 100_000_000n),
      multicall: vi.fn(async () => results),
    } as unknown as PublicClient;
    const catalog = await new AaveV3ReserveCatalogReader({
      rpcUrl: 'https://rpc.invalid', expectedChainId: 1, publicClient,
      now: () => new Date('2026-09-16T00:00:00.000Z'),
    }).read();

    expect(catalog).toMatchObject({
      chainId: 1, protocol: 'aave', version: 'v3', status: 'partial', blockNumber: '123',
      poolAddress: market.poolAddress, poolAddressesProviderAddress: market.poolAddressesProviderAddress,
    });
    expect(catalog.items).toHaveLength(market.assets.length);
    expect(catalog.items[0]).toMatchObject({ priceUsd: null, priceStatus: 'error', active: true, borrowingEnabled: true });
    expect(catalog.items[1]).toMatchObject({ priceUsd: '1', priceStatus: 'ok', name: 'Reserve 1' });
  });

  it('scans confirmed blocks once per integration, distributes five event types, and deduplicates reorg replay', async () => {
    const database = createDatabase(':memory:');
    databases.push(database);
    const integrations = new IntegrationRepository(database.db, new EncryptionService(Buffer.alloc(32, 4)));
    const integration = integrations.create({
      name: 'Ethereum', type: 'evm_rpc', provider: 'custom', enabled: true,
      config: { chainId: 1, rpcUrl: 'https://rpc.invalid' },
    });
    const monitors = new MonitorRepository(database.db, integrations);
    const market = supportedAaveV3Markets.get(1);
    const reserve = market?.assets[0];
    if (reserve === undefined) throw new Error('Aave reserve fixture is missing');
    const walletAddress = '0x0000000000000000000000000000000000001234';
    const pool = monitors.create({
      name: 'Aave pool', type: 'aave_pool', enabled: true, intervalSeconds: 20, maxStaleSeconds: 90,
      config: { rpcIntegrationId: integration.id, chainId: 1, reserveAssetAddresses: [reserve.underlyingAddress] },
    });
    const account = monitors.create({
      name: 'Aave account', type: 'aave_account', enabled: true, intervalSeconds: 20, maxStaleSeconds: 90,
      config: { rpcIntegrationId: integration.id, chainId: 1, walletAddress },
    });
    const latest = new LatestMetricStore();
    const pipeline = new MetricPipeline(monitors, latest, [], new MetricEventRepository(database.db));
    const scheduler = new CapturingScheduler();
    const types = ['supply', 'withdraw', 'borrow', 'repay', 'liquidation'] as const;
    const chainEvents: AaveV3ChainEvent[] = types.map((eventType, index) => ({
      eventId: `1:0x${String(index + 1).padStart(64, '0')}:${index}`,
      eventType, chainId: 1, blockNumber: '100', transactionHash: `0x${String(index + 1).padStart(64, '0')}`,
      logIndex: index, observedAt: `2026-09-16T00:00:0${index}.000Z`, reserveAssetAddress: reserve.underlyingAddress,
      symbol: reserve.symbol, tokenAmount: String(index + 1), usdAmount: index === 4 ? null : String(index + 1),
      valuationStatus: index === 4 ? 'unavailable' : 'ok', user: walletAddress,
      onBehalfOf: walletAddress, repayer: null, to: null, liquidator: null,
      collateralAssetAddress: null, collateralSymbol: null, collateralTokenAmount: null, collateralUsdAmount: null,
    }));
    const scan = vi.fn(async () => chainEvents);
    const coordinator = new AaveV3EventCoordinator(
      integrations, monitors, new ChainScanCursorRepository(database.db), pipeline,
      scheduler as unknown as PollingScheduler,
      {
        confirmationBlocks: 12n, initialLookbackBlocks: 10n, reorgRewindBlocks: 2n, blockChunkSize: 100n,
        readerFactory: { create: () => ({ latestBlock: async () => 100n, scan }) },
      },
    );
    coordinator.reconcile();
    const task = scheduler.tasks.get(`aave-v3-events:${integration.id}`);
    if (task === undefined) throw new Error('Aave event task was not scheduled');
    await task.run(new AbortController().signal);
    await task.run(new AbortController().signal);

    expect(scan).toHaveBeenNthCalledWith(1, 78n, 88n, expect.any(AbortSignal));
    expect(scan).toHaveBeenNthCalledWith(2, 87n, 88n, expect.any(AbortSignal));
    expect(latest.list(pool.id).filter((metric) => metric.kind === 'event')).toHaveLength(9);
    expect(latest.list(account.id).filter((metric) => metric.kind === 'event').map((metric) => metric.name)).toEqual(
      expect.arrayContaining(types.map((type) => `account_${type}`)),
    );
    const snapshot = new MonitorSnapshotService(monitors, latest, () => new Date('2026-09-16T00:00:10.000Z')).get(pool.id);
    expect(snapshot).toMatchObject({
      monitorType: 'aave_pool', status: 'partial', capability: { available: true },
      summary: { eventCount: 5 },
      data: { discovery: {
        caughtUp: true, scannedThroughBlock: '88', confirmedTipBlock: '88', chainTipBlock: '100', confirmationBlocks: '12',
      } },
    });
    coordinator.close();
    expect(scheduler.tasks.size).toBe(0);
    await pipeline.close();
  });
});
