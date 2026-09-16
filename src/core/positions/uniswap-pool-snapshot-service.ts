import { AppError } from '../../api/errors.js';
import { uniswapPoolMonitorConfigSchema } from '../../api/schemas.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import type { Metric } from '../metrics/metric.js';
import type { MetricSnapshotReader } from '../metrics/latest-metric-store.js';

function stringValue(metrics: Metric[], name: string): string | null {
  const value = metrics.find((metric) => metric.name === name)?.value;
  return typeof value === 'string' ? value : null;
}

export class UniswapPoolSnapshotService {
  public constructor(
    private readonly monitors: MonitorRepository,
    private readonly metrics: MetricSnapshotReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public get(monitorId: string) {
    const monitor = this.monitors.get(monitorId);
    if (monitor.type !== 'uniswap_pool') throw new AppError(409, 'MONITOR_TYPE_MISMATCH', 'Pool snapshot requires uniswap_pool');
    const config = uniswapPoolMonitorConfigSchema.parse(monitor.config);
    const metrics = this.metrics.list(monitorId).filter((metric) => metric.source === 'uniswap_pool');
    const sync = metrics.find((metric) => metric.name === 'sync_status');
    const observedAt = metrics.reduce<string | null>((latest, metric) => (
      latest === null || Date.parse(metric.observedAt) > Date.parse(latest) ? metric.observedAt : latest
    ), null);
    const dataAgeSeconds = observedAt === null ? null : Math.max(0, (this.now().getTime() - Date.parse(observedAt)) / 1_000);
    const events = metrics.filter((metric) => metric.kind === 'event').map((metric) => ({
      eventId: metric.eventId, eventType: metric.labels?.eventType ?? metric.name,
      amount0: metric.labels?.amount0 ?? null, amount1: metric.labels?.amount1 ?? null,
      amountUsd: metric.labels?.amountUsd === 'unavailable' ? null : metric.labels?.amountUsd ?? null,
      valuationStatus: metric.labels?.valuationStatus ?? 'unavailable',
      txHash: metric.labels?.transactionHash ?? null, logIndex: metric.labels?.logIndex ?? null,
      blockNumber: metric.labels?.blockNumber ?? null, observedAt: metric.observedAt,
    }));
    const stale = dataAgeSeconds !== null && dataAgeSeconds > monitor.maxStaleSeconds;
    const tvlUsd = stringValue(metrics, 'tvl_usd');
    return {
      status: sync === undefined ? 'warming_up' as const : sync.status === 'error' ? 'error' as const
        : stale ? 'stale' as const : tvlUsd === null ? 'partial' as const : 'ok' as const,
      observedAt, dataAgeSeconds, maxStaleSeconds: monitor.maxStaleSeconds,
      summary: { eventCount: events.length, valuationCoverage: tvlUsd === null ? 'unavailable' : 'full' },
      pool: {
        chainId: config.chainId, version: config.version, poolAddress: config.poolAddress ?? null, poolId: config.poolId ?? null,
        token0Price: stringValue(metrics, 'token0_price'), token1Price: stringValue(metrics, 'token1_price'),
        currentTick: stringValue(metrics, 'current_tick'), activeLiquidity: stringValue(metrics, 'active_liquidity'),
        tvlToken0: stringValue(metrics, 'tvl_token0'), tvlToken1: stringValue(metrics, 'tvl_token1'), tvlUsd,
        lpFee: stringValue(metrics, 'lp_fee'), protocolFee: stringValue(metrics, 'protocol_fee'),
        valuationStatus: tvlUsd === null ? 'unavailable' : 'ok',
        valuationSource: tvlUsd === null ? null : 'onchain_stablecoin_pool',
        valuationObservedAt: tvlUsd === null ? null : observedAt,
      },
      discovery: {
        caughtUp: sync?.status === 'ok' && sync.labels?.scannedThroughBlock === sync.labels?.confirmedTipBlock,
        scannedThroughBlock: sync?.labels?.scannedThroughBlock ?? null, chainTipBlock: sync?.labels?.chainTipBlock ?? null,
      },
      recentEvents: events,
      error: sync?.status === 'error' ? { code: 'INDEXER_PARTIAL_FAILURE', message: 'Uniswap pool synchronization failed' }
        : tvlUsd === null ? { code: 'VALUATION_UNAVAILABLE', message: 'Reliable USD valuation is not currently available' } : null,
    };
  }
}
