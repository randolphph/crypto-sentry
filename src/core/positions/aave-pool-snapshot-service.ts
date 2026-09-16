import { AppError } from '../../api/errors.js';
import { aavePoolMonitorConfigSchema } from '../../api/schemas.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import type { Metric } from '../metrics/metric.js';
import type { MetricSnapshotReader } from '../metrics/latest-metric-store.js';

function newest(metrics: Metric[]): string | null {
  return metrics.reduce<string | null>((value, metric) => (
    value === null || Date.parse(metric.observedAt) > Date.parse(value) ? metric.observedAt : value
  ), null);
}

export class AavePoolSnapshotService {
  public constructor(
    private readonly monitors: MonitorRepository,
    private readonly metrics: MetricSnapshotReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public get(monitorId: string) {
    const monitor = this.monitors.get(monitorId);
    if (monitor.type !== 'aave_pool') throw new AppError(409, 'MONITOR_TYPE_MISMATCH', 'Aave pool snapshot requires an aave_pool monitor');
    const config = aavePoolMonitorConfigSchema.parse(monitor.config);
    const metrics = this.metrics.list(monitorId).filter((metric) => metric.source === 'aave_v3');
    const progress = metrics.find((metric) => metric.name === 'event_scan_status');
    const events = new Map<string, { token?: Metric; usd?: Metric }>();
    for (const metric of metrics.filter((item) => item.kind === 'event' && item.eventId !== undefined)) {
      const current = events.get(metric.eventId as string) ?? {};
      if (metric.name === 'aave_event_amount_token') current.token = metric;
      if (metric.name === 'aave_event_amount_usd') current.usd = metric;
      events.set(metric.eventId as string, current);
    }
    const recentEvents = [...events.entries()].flatMap(([eventId, values]) => {
      const source = values.token ?? values.usd;
      if (source === undefined) return [];
      return [{
        eventId,
        eventType: source.labels?.eventType ?? null,
        chainId: 1,
        reserveAssetAddress: source.labels?.reserveAssetAddress ?? null,
        symbol: source.labels?.symbol ?? null,
        tokenAmount: typeof values.token?.value === 'string' ? values.token.value : null,
        usdAmount: typeof values.usd?.value === 'string' ? values.usd.value : null,
        valuationStatus: source.labels?.valuationStatus ?? 'unavailable',
        user: source.labels?.user ?? null,
        onBehalfOf: source.labels?.onBehalfOf ?? null,
        liquidator: source.labels?.liquidator ?? null,
        txHash: source.labels?.transactionHash ?? null,
        logIndex: source.labels?.logIndex ?? null,
        blockNumber: source.labels?.blockNumber ?? null,
        observedAt: source.observedAt,
        collateralAssetAddress: source.labels?.collateralAssetAddress ?? null,
        collateralSymbol: source.labels?.collateralSymbol ?? null,
        collateralTokenAmount: source.labels?.collateralTokenAmount ?? null,
        collateralUsdAmount: source.labels?.collateralUsdAmount ?? null,
      }];
    }).sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
    const observedAt = newest(metrics);
    const dataAgeSeconds = observedAt === null ? null : Math.max(0, (this.now().getTime() - Date.parse(observedAt)) / 1_000);
    const stale = dataAgeSeconds !== null && dataAgeSeconds > monitor.maxStaleSeconds;
    const failed = progress?.status === 'error';
    const partial = recentEvents.some((event) => event.valuationStatus !== 'ok');
    return {
      status: progress === undefined ? 'warming_up' as const
        : failed ? 'error' as const
          : stale ? 'stale' as const
            : partial ? 'partial' as const
              : recentEvents.length === 0 ? 'empty' as const : 'ok' as const,
      observedAt,
      dataAgeSeconds,
      maxStaleSeconds: monitor.maxStaleSeconds,
      summary: {
        eventCount: recentEvents.length,
        selectedReserveCount: config.reserveAssetAddresses.length,
        monitorsAllReserves: config.reserveAssetAddresses.length === 0,
      },
      chainId: 1,
      reserveAssetAddresses: config.reserveAssetAddresses,
      discovery: {
        caughtUp: progress?.status === 'ok' && progress.labels?.scannedThroughBlock !== undefined &&
          progress.labels.confirmedTipBlock !== undefined &&
          BigInt(progress.labels.scannedThroughBlock) >= BigInt(progress.labels.confirmedTipBlock),
        scannedThroughBlock: progress?.labels?.scannedThroughBlock ?? null,
        confirmedTipBlock: progress?.labels?.confirmedTipBlock ?? null,
        chainTipBlock: progress?.labels?.chainTipBlock ?? null,
        confirmationBlocks: progress?.labels?.confirmationBlocks ?? null,
      },
      recentEvents,
      error: failed ? { code: 'INDEXER_PARTIAL_FAILURE', message: 'The Aave event scanner could not reach the configured RPC' } : null,
    };
  }
}
