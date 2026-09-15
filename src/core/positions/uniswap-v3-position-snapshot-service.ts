import { AppError } from '../../api/errors.js';
import { lpMonitorConfigSchema } from '../../api/schemas.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import type { Metric } from '../metrics/metric.js';
import type { MetricSnapshotReader } from '../metrics/latest-metric-store.js';

export type UniswapV3PositionSnapshotStatus = 'warming_up' | 'ok' | 'stale' | 'error';

function byName(metrics: Metric[], name: string): Metric | undefined {
  return metrics.find((metric) => metric.name === name);
}

function stringValue(metric: Metric | undefined): string | null {
  return typeof metric?.value === 'string' ? metric.value : null;
}

function booleanValue(metric: Metric | undefined): boolean | null {
  return typeof metric?.value === 'boolean' ? metric.value : null;
}

function numberValue(metric: Metric | undefined): number | null {
  const value = stringValue(metric);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestObservation(metrics: Metric[]): string | null {
  return metrics.reduce<string | null>((latest, metric) => (
    latest === null || Date.parse(metric.observedAt) > Date.parse(latest) ? metric.observedAt : latest
  ), null);
}

export class UniswapV3PositionSnapshotService {
  public constructor(
    private readonly monitors: MonitorRepository,
    private readonly metrics: MetricSnapshotReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public get(monitorId: string) {
    const monitor = this.monitors.get(monitorId);
    if (monitor.type !== 'lp_position') {
      throw new AppError(409, 'MONITOR_TYPE_MISMATCH', 'Uniswap snapshots are only available for LP monitors');
    }
    const config = lpMonitorConfigSchema.parse(monitor.config);
    const metrics = this.metrics.list(monitorId).filter((metric) => metric.source === 'uniswap_v3');
    const readStatus = byName(metrics, 'read_status');
    const observedAt = readStatus?.observedAt ?? latestObservation(metrics);
    const dataAgeSeconds = observedAt === null
      ? null
      : Math.max(0, Math.round((this.now().getTime() - Date.parse(observedAt)) / 100) / 10);
    const isStale = metrics.some((metric) => metric.status === 'stale') || (
      dataAgeSeconds !== null && dataAgeSeconds > monitor.maxStaleSeconds
    );
    const failed = readStatus?.status === 'error' || readStatus?.value === false;
    const labels = readStatus?.labels ?? {};
    const ready = readStatus?.status === 'ok' && readStatus.value === true;

    return {
      monitorId,
      status: failed ? 'error' as const : ready ? (isStale ? 'stale' as const : 'ok' as const) : 'warming_up' as const,
      observedAt,
      dataAgeSeconds,
      maxStaleSeconds: monitor.maxStaleSeconds,
      position: ready ? {
        protocol: 'uniswap' as const,
        version: 'v3' as const,
        chainId: config.chainId,
        chainName: labels.chainName ?? 'Robinhood Chain',
        tokenId: config.tokenId,
        owner: stringValue(byName(metrics, 'position_owner')),
        positionManagerAddress: stringValue(byName(metrics, 'position_manager_address')),
        poolAddress: stringValue(byName(metrics, 'pool_address')),
        blockNumber: stringValue(byName(metrics, 'block_number')),
        token0: {
          address: labels.token0Address ?? null,
          symbol: labels.token0Symbol ?? null,
          decimals: labels.token0Decimals === undefined ? null : Number(labels.token0Decimals),
        },
        token1: {
          address: labels.token1Address ?? null,
          symbol: labels.token1Symbol ?? null,
          decimals: labels.token1Decimals === undefined ? null : Number(labels.token1Decimals),
        },
        feeTier: numberValue(byName(metrics, 'fee_tier')),
        tickLower: numberValue(byName(metrics, 'tick_lower')),
        tickUpper: numberValue(byName(metrics, 'tick_upper')),
        currentTick: numberValue(byName(metrics, 'current_tick')),
        liquidity: stringValue(byName(metrics, 'liquidity')),
        inRange: booleanValue(byName(metrics, 'in_range')),
        tokensOwed0: stringValue(byName(metrics, 'tokens_owed0')),
        tokensOwed1: stringValue(byName(metrics, 'tokens_owed1')),
      } : null,
      error: failed ? {
        code: 'UNISWAP_POSITION_READ_FAILED' as const,
        message: 'The Uniswap V3 position could not be read from the configured RPC',
      } : null,
    };
  }
}
