import { UniswapPoolReader } from '../../adapters/uniswap/uniswap-pool-reader.js';
import type { UniswapPoolReadResult, UniswapPoolTarget } from '../../adapters/uniswap/uniswap-pool-reader.js';
import { rpcIntegrationConfigSchema } from '../../api/schemas.js';
import type { ChainScanCursorRepository } from '../../db/repositories/chain-scan-cursor-repository.js';
import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import type { UniswapPoolRepository } from '../../db/repositories/uniswap-pool-repository.js';
import type { MetricPipeline } from '../metrics/metric-pipeline.js';
import type { PollingScheduler } from '../scheduling/polling-scheduler.js';
import { resolveEvmRpcRequest } from './evm-rpc-config.js';
import { Decimal } from 'decimal.js';

export interface UniswapPoolReaderPort {
  latestBlock(signal?: AbortSignal): Promise<bigint>;
  read(target: UniswapPoolTarget, fromBlock: bigint, toBlock: bigint, signal?: AbortSignal): Promise<UniswapPoolReadResult>;
}

export interface UniswapPoolReaderFactory {
  create(options: {
    rpcUrl: string; headers?: Record<string, string>; expectedChainId: number; timeoutMilliseconds: number;
  }): UniswapPoolReaderPort;
}

export class UniswapPoolCoordinator {
  private readonly monitorIds = new Set<string>();
  private readonly readerFactory: UniswapPoolReaderFactory;
  private readonly now: () => Date;
  private readonly onError: (error: Error) => void;

  public constructor(
    private readonly integrations: IntegrationRepository,
    private readonly monitors: MonitorRepository,
    private readonly pools: UniswapPoolRepository,
    private readonly cursors: ChainScanCursorRepository,
    private readonly pipeline: MetricPipeline,
    private readonly scheduler: PollingScheduler,
    options: { fetch?: typeof globalThis.fetch; readerFactory?: UniswapPoolReaderFactory; now?: () => Date; onError?: (error: Error) => void } = {},
  ) {
    this.readerFactory = options.readerFactory ?? { create: (readerOptions) => new UniswapPoolReader({
      ...readerOptions, ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }) };
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => undefined);
  }

  public reconcile(): void {
    const monitors = this.monitors.listEnabledUniswapPoolMonitors();
    const desired = new Set(monitors.map((monitor) => monitor.monitorId));
    for (const id of this.monitorIds) if (!desired.has(id)) this.scheduler.remove(this.taskId(id));
    this.monitorIds.clear();
    for (const monitor of monitors) {
      this.scheduler.upsert({
        id: this.taskId(monitor.monitorId), intervalMilliseconds: monitor.intervalSeconds * 1_000,
        run: async (signal) => this.scan(monitor, signal),
      });
      this.monitorIds.add(monitor.monitorId);
    }
  }

  public close(): void {
    for (const id of this.monitorIds) this.scheduler.remove(this.taskId(id));
    this.monitorIds.clear();
  }

  private taskId(id: string) { return `uniswap-pool:${id}`; }

  private async scan(monitor: ReturnType<MonitorRepository['listEnabledUniswapPoolMonitors']>[number], signal: AbortSignal) {
    const row = this.pools.get(monitor.rpcIntegrationId, monitor.chainId, monitor.version, monitor.resourceId);
    if (row === undefined) return;
    const target: UniswapPoolTarget = {
      chainId: row.chainId, version: row.version as 'v3' | 'v4', resourceId: row.resourceId,
      poolAddress: row.poolAddress, poolId: row.poolId,
      token0Address: row.token0Address, token0Symbol: row.token0Symbol, token0Decimals: row.token0Decimals,
      token1Address: row.token1Address, token1Symbol: row.token1Symbol, token1Decimals: row.token1Decimals,
      feeTier: row.feeTier, tickSpacing: row.tickSpacing,
    };
    const integration = this.integrations.getRuntime(monitor.rpcIntegrationId);
    const config = rpcIntegrationConfigSchema.parse(integration.config);
    const resolved = resolveEvmRpcRequest(config, monitor.chainId);
    const reader = this.readerFactory.create({
      rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: monitor.chainId,
      timeoutMilliseconds: config.timeoutMilliseconds,
    });
    const timestamp = this.now().toISOString();
    const labels = {
      chainId: String(monitor.chainId), version: monitor.version, resourceId: monitor.resourceId,
      token0Address: row.token0Address, token0Symbol: row.token0Symbol ?? 'UNKNOWN',
      token1Address: row.token1Address, token1Symbol: row.token1Symbol ?? 'UNKNOWN',
    };
    try {
      const tip = await reader.latestBlock(signal);
      const confirmed = tip > 12n ? tip - 12n : 0n;
      const stream = `monitor:${monitor.monitorId}`;
      const saved = this.cursors.get(monitor.rpcIntegrationId, `uniswap_${monitor.version}_pool`, monitor.chainId, stream);
      const from = saved === undefined ? (confirmed > 2_000n ? confirmed - 2_000n : 0n) : (saved > 12n ? saved - 11n : 0n);
      const result = await reader.read(target, from, confirmed, signal);
      this.pipeline.forgetMonitor(monitor.monitorId);
      const gauges: Array<[string, string, string]> = [
        ['current_tick', String(result.currentTick), 'tick'], ['token0_price', result.token0Price, row.token1Symbol ?? 'token1'],
        ['token1_price', result.token1Price, row.token0Symbol ?? 'token0'], ['active_liquidity', result.activeLiquidity, 'liquidity'],
        ['lp_fee', result.lpFee, 'hundredths_bps'], ['block_number', result.blockNumber, 'block'],
      ];
      if (result.protocolFee !== null) gauges.push(['protocol_fee', result.protocolFee, 'hundredths_bps']);
      if (result.tvlToken0 !== null) gauges.push(['tvl_token0', result.tvlToken0, row.token0Symbol ?? 'token0']);
      if (result.tvlToken1 !== null) gauges.push(['tvl_token1', result.tvlToken1, row.token1Symbol ?? 'token1']);
      const tvlUsd = this.usdValue(
        result.tvlToken0, result.tvlToken1, row.token0Symbol, row.token1Symbol, result.token0Price, result.token1Price,
      );
      if (tvlUsd !== null) gauges.push(['tvl_usd', tvlUsd, 'USD']);
      for (const [name, value, unit] of gauges) await this.pipeline.ingest({
        monitorId: monitor.monitorId, source: 'uniswap_pool', target: monitor.resourceId, name, value, unit,
        observedAt: timestamp, receivedAt: timestamp, status: 'ok', labels,
      });
      for (const event of result.events) {
        const amountUsd = this.usdValue(
          event.amount0, event.amount1, row.token0Symbol, row.token1Symbol, result.token0Price, result.token1Price,
        );
        await this.pipeline.ingest({
        monitorId: monitor.monitorId, source: 'uniswap_pool', target: monitor.resourceId,
        name: event.eventType === 'collect' ? 'fee_collection' : event.eventType,
        value: event.amount0 ?? event.amount1 ?? '1', unit: event.amount0 === null ? row.token1Symbol ?? 'token1' : row.token0Symbol ?? 'token0',
        observedAt: timestamp, receivedAt: timestamp, status: 'ok', kind: 'event', eventId: event.eventId,
        labels: { ...labels, eventType: event.eventType, amount0: event.amount0 ?? 'unavailable', amount1: event.amount1 ?? 'unavailable',
          amountUsd: amountUsd ?? 'unavailable', valuationStatus: amountUsd === null ? 'unavailable' : 'ok',
          transactionHash: event.transactionHash, logIndex: String(event.logIndex), blockNumber: event.blockNumber },
      });
      }
      this.cursors.save(monitor.rpcIntegrationId, `uniswap_${monitor.version}_pool`, monitor.chainId, stream, confirmed);
      await this.pipeline.ingest({
        monitorId: monitor.monitorId, source: 'uniswap_pool', target: monitor.resourceId, name: 'sync_status', value: true,
        observedAt: timestamp, receivedAt: timestamp, status: 'ok',
        labels: {
          ...labels,
          scannedThroughBlock: confirmed.toString(),
          confirmedTipBlock: confirmed.toString(),
          chainTipBlock: tip.toString(),
        },
      });
    } catch {
      if (signal.aborted) return;
      this.onError(new Error(`Uniswap ${monitor.version} pool monitor failed on chain ${monitor.chainId}`));
      await this.pipeline.ingest({
        monitorId: monitor.monitorId, source: 'uniswap_pool', target: monitor.resourceId, name: 'sync_status', value: false,
        observedAt: timestamp, receivedAt: timestamp, status: 'error', labels,
      });
    }
  }

  private usdValue(
    amount0: string | null,
    amount1: string | null,
    symbol0: string | null,
    symbol1: string | null,
    price0: string,
    price1: string,
  ): string | null {
    if (amount0 === null || amount1 === null) return null;
    const stable = new Set(['USDC', 'USDT', 'DAI', 'USDS']);
    if (symbol1 !== null && stable.has(symbol1.toUpperCase())) {
      return new Decimal(amount0).mul(price0).plus(amount1).toSignificantDigits(30).toString();
    }
    if (symbol0 !== null && stable.has(symbol0.toUpperCase())) {
      return new Decimal(amount0).plus(new Decimal(amount1).mul(price1)).toSignificantDigits(30).toString();
    }
    return null;
  }
}
