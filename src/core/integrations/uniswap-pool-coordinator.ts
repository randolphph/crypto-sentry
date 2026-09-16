import { UniswapPoolReader } from '../../adapters/uniswap/uniswap-pool-reader.js';
import type { UniswapPoolReadResult, UniswapPoolTarget } from '../../adapters/uniswap/uniswap-pool-reader.js';
import { rpcIntegrationConfigSchema } from '../../api/schemas.js';
import type { ChainScanCursorRepository } from '../../db/repositories/chain-scan-cursor-repository.js';
import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import type { UniswapPoolRepository } from '../../db/repositories/uniswap-pool-repository.js';
import type { UniswapPoolSwapSampleRepository } from '../../db/repositories/uniswap-pool-swap-sample-repository.js';
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
    options: {
      fetch?: typeof globalThis.fetch; readerFactory?: UniswapPoolReaderFactory; now?: () => Date;
      onError?: (error: Error) => void; samples?: UniswapPoolSwapSampleRepository;
    } = {},
  ) {
    this.readerFactory = options.readerFactory ?? { create: (readerOptions) => new UniswapPoolReader({
      ...readerOptions, ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }) };
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => undefined);
    this.samples = options.samples;
  }

  private readonly samples: UniswapPoolSwapSampleRepository | undefined;

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
        const amount0 = event.amount0 === null ? null : new Decimal(event.amount0).abs().toSignificantDigits(30).toString();
        const amount1 = event.amount1 === null ? null : new Decimal(event.amount1).abs().toSignificantDigits(30).toString();
        const amountUsd = event.eventType === 'swap'
          ? this.swapUsdValue(amount0, amount1, row.token0Symbol, row.token1Symbol)
          : this.usdValue(amount0, amount1, row.token0Symbol, row.token1Symbol, result.token0Price, result.token1Price);
        const eventObservedAt = event.observedAt ?? timestamp;
        if (event.eventType === 'swap' && amount0 !== null && amount1 !== null && monitor.volumeWindowSeconds.length > 0) {
          this.samples?.save(monitor.monitorId, {
            eventId: event.eventId, observedAt: eventObservedAt,
            token0Volume: amount0, token1Volume: amount1, usdVolume: amountUsd,
          });
        }
        await this.pipeline.ingest({
          monitorId: monitor.monitorId, source: 'uniswap_pool', target: monitor.resourceId,
          name: event.eventType === 'collect' ? 'fee_collection' : event.eventType,
          value: amount0 ?? amount1 ?? '1', unit: amount0 === null ? row.token1Symbol ?? 'token1' : row.token0Symbol ?? 'token0',
          observedAt: eventObservedAt, receivedAt: timestamp, status: 'ok', kind: 'event', eventId: event.eventId,
          labels: { ...labels, eventType: event.eventType, amount0: amount0 ?? 'unavailable', amount1: amount1 ?? 'unavailable',
            amountUsd: amountUsd ?? 'unavailable', valuationStatus: amountUsd === null ? 'unavailable' : 'ok',
            transactionHash: event.transactionHash, logIndex: String(event.logIndex), blockNumber: event.blockNumber },
        });
      }
      await this.emitWindowVolumes(monitor, labels, row.token0Symbol, row.token1Symbol, timestamp);
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

  private swapUsdValue(
    amount0: string | null,
    amount1: string | null,
    symbol0: string | null,
    symbol1: string | null,
  ): string | null {
    if (amount0 === null || amount1 === null) return null;
    const stable = new Set(['USDC', 'USDT', 'DAI', 'USDS']);
    if (symbol1 !== null && stable.has(symbol1.toUpperCase())) return new Decimal(amount1).toSignificantDigits(30).toString();
    if (symbol0 !== null && stable.has(symbol0.toUpperCase())) return new Decimal(amount0).toSignificantDigits(30).toString();
    return null;
  }

  private async emitWindowVolumes(
    monitor: ReturnType<MonitorRepository['listEnabledUniswapPoolMonitors']>[number],
    labels: Record<string, string>,
    token0Symbol: string | null,
    token1Symbol: string | null,
    timestamp: string,
  ): Promise<void> {
    if (this.samples === undefined) return;
    if (monitor.volumeWindowSeconds.length === 0) {
      this.samples.clear(monitor.monitorId);
      return;
    }
    const largestWindow = Math.max(...monitor.volumeWindowSeconds);
    const cutoff = new Date(Date.parse(timestamp) - largestWindow * 2 * 1_000).toISOString();
    const samples = this.samples.listSince(monitor.monitorId, cutoff);
    const stable = new Set(['USDC', 'USDT', 'DAI', 'USDS']);
    const usdSupported = [token0Symbol, token1Symbol].some((symbol) => symbol !== null && stable.has(symbol.toUpperCase()));
    const sum = (values: string[]) => values.reduce((total, value) => total.plus(value), new Decimal(0)).toSignificantDigits(30).toString();
    for (const windowSeconds of monitor.volumeWindowSeconds) {
      const end = Date.parse(timestamp);
      const start = end - windowSeconds * 1_000;
      const previousStart = start - windowSeconds * 1_000;
      const current = samples.filter((sample) => {
        const time = Date.parse(sample.observedAt);
        return time > start && time <= end;
      });
      const previous = samples.filter((sample) => {
        const time = Date.parse(sample.observedAt);
        return time > previousStart && time <= start;
      });
      const windowLabels = { ...labels, windowSeconds: String(windowSeconds) };
      const values: Array<[string, string, string, 'ok' | 'warming_up']> = [
        ['volume_token0', sum(current.map((sample) => sample.token0Volume)), token0Symbol ?? 'token0', 'ok'],
        ['volume_token1', sum(current.map((sample) => sample.token1Volume)), token1Symbol ?? 'token1', 'ok'],
      ];
      const currentUsdAvailable = usdSupported && current.every((sample) => sample.usdVolume !== null);
      const previousUsdAvailable = usdSupported && previous.every((sample) => sample.usdVolume !== null);
      const currentUsd = currentUsdAvailable ? sum(current.map((sample) => sample.usdVolume as string)) : null;
      const previousUsd = previousUsdAvailable ? sum(previous.map((sample) => sample.usdVolume as string)) : null;
      values.push(['volume_usd', currentUsd ?? 'unavailable', 'USD', currentUsd === null ? 'warming_up' : 'ok']);
      const change = previousUsd === null || currentUsd === null || new Decimal(previousUsd).isZero()
        ? null : new Decimal(currentUsd).div(previousUsd).minus(1).mul(100).toSignificantDigits(30).toString();
      values.push(['volume_change_percent', change ?? 'unavailable', 'percent', change === null ? 'warming_up' : 'ok']);
      for (const [name, value, unit, status] of values) await this.pipeline.ingest({
        monitorId: monitor.monitorId, source: 'uniswap_pool', target: monitor.resourceId,
        name, value, unit, observedAt: timestamp, receivedAt: timestamp, status, labels: windowLabels,
      });
    }
    this.samples.prune(monitor.monitorId, cutoff);
  }
}
