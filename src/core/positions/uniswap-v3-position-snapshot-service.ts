import { AppError } from '../../api/errors.js';
import { lpMonitorConfigSchema } from '../../api/schemas.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import type { Metric } from '../metrics/metric.js';
import type { MetricSnapshotReader } from '../metrics/latest-metric-store.js';

export type UniswapPositionSnapshotStatus = 'warming_up' | 'ok' | 'empty' | 'partial' | 'stale' | 'error';

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

function groupByTokenId(metrics: Metric[]): Map<string, Metric[]> {
  const grouped = new Map<string, Metric[]>();
  for (const metric of metrics) {
    const tokenId = metric.labels?.tokenId;
    if (tokenId === undefined) continue;
    const tokenMetrics = grouped.get(tokenId) ?? [];
    tokenMetrics.push(metric);
    grouped.set(tokenId, tokenMetrics);
  }
  return grouped;
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
    const metrics = this.metrics.list(monitorId).filter((metric) => metric.source.startsWith('uniswap'));
    const scanStatus = byName(metrics, 'scan_status') ?? byName(metrics, 'read_status');
    const observedAt = scanStatus?.observedAt ?? null;
    const dataAgeSeconds = observedAt === null
      ? null
      : Math.max(0, Math.round((this.now().getTime() - Date.parse(observedAt)) / 100) / 10);
    const isStale = metrics.some((metric) => metric.status === 'stale') || (
      dataAgeSeconds !== null && dataAgeSeconds > monitor.maxStaleSeconds
    );
    const groups = groupByTokenId(metrics);
    const positions = [...groups.entries()]
      .filter(([, positionMetrics]) => byName(positionMetrics, 'read_status')?.value === true)
      .map(([tokenId, positionMetrics]) => this.position(tokenId, positionMetrics))
      .sort((left, right) => {
        const leftId = BigInt(left.tokenId);
        const rightId = BigInt(right.tokenId);
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      });
    const failedPositionCount = [...groups.values()]
      .filter((positionMetrics) => byName(positionMetrics, 'read_status')?.status === 'error')
      .length;
    const caughtUp = booleanValue(byName(metrics, 'discovery_caught_up')) ?? true;
    const scanFailed = scanStatus?.status === 'error' || scanStatus?.value === false;
    const status: UniswapPositionSnapshotStatus =
      scanStatus === undefined ? 'warming_up' :
      isStale ? 'stale' :
      !caughtUp || scanStatus.status === 'warming_up' ? 'warming_up' :
      scanFailed && positions.length > 0 ? 'partial' :
      scanFailed ? 'error' :
      positions.length === 0 ? 'empty' :
      failedPositionCount > 0 ? 'partial' : 'ok';

    return {
      monitorId,
      protocol: 'uniswap' as const,
      version: config.version,
      chainId: config.chainId,
      chainName: scanStatus?.labels?.chainName ?? 'Robinhood Chain',
      walletAddress: 'walletAddress' in config ? config.walletAddress : null,
      requestedTokenId: 'tokenId' in config ? config.tokenId : null,
      status,
      observedAt,
      dataAgeSeconds,
      maxStaleSeconds: monitor.maxStaleSeconds,
      discovery: {
        caughtUp,
        scannedThroughBlock: stringValue(byName(metrics, 'discovery_scanned_block')),
        chainTipBlock: stringValue(byName(metrics, 'discovery_chain_tip_block')),
      },
      summary: {
        positionCount: positions.length,
        failedPositionCount,
      },
      positions,
      error: scanFailed ? {
        code: 'UNISWAP_POSITION_READ_FAILED' as const,
        message: 'The Uniswap positions could not be fully read from the configured RPC',
      } : null,
    };
  }

  public getLegacy(monitorId: string) {
    const snapshot = this.get(monitorId);
    if (snapshot.requestedTokenId === null) {
      throw new AppError(409, 'USE_COLLECTION_ENDPOINT', 'Wallet monitors must use /uniswap-positions');
    }
    return {
      monitorId: snapshot.monitorId,
      status: snapshot.status === 'empty' ? 'error' : snapshot.status,
      observedAt: snapshot.observedAt,
      dataAgeSeconds: snapshot.dataAgeSeconds,
      maxStaleSeconds: snapshot.maxStaleSeconds,
      position: snapshot.positions[0] ?? null,
      error: snapshot.error,
    };
  }

  private position(tokenId: string, metrics: Metric[]) {
    const labels = byName(metrics, 'read_status')?.labels ?? {};
    const version = labels.version === 'v4' ? 'v4' as const : 'v3' as const;
    return {
      protocol: 'uniswap' as const,
      version,
      chainId: Number(labels.chainId),
      chainName: labels.chainName ?? 'Robinhood Chain',
      tokenId,
      owner: stringValue(byName(metrics, 'position_owner')),
      positionManagerAddress: stringValue(byName(metrics, 'position_manager_address')),
      poolAddress: stringValue(byName(metrics, 'pool_address')),
      poolId: stringValue(byName(metrics, 'pool_id')),
      poolManagerAddress: stringValue(byName(metrics, 'pool_manager_address')),
      stateViewAddress: stringValue(byName(metrics, 'state_view_address')),
      blockNumber: stringValue(byName(metrics, 'block_number')),
      token0: {
        address: labels.token0Address ?? null,
        symbol: labels.token0Symbol ?? null,
        decimals: labels.token0Decimals === undefined ? null : Number(labels.token0Decimals),
        native: labels.token0Native === 'true',
      },
      token1: {
        address: labels.token1Address ?? null,
        symbol: labels.token1Symbol ?? null,
        decimals: labels.token1Decimals === undefined ? null : Number(labels.token1Decimals),
        native: labels.token1Native === 'true',
      },
      feeTier: numberValue(byName(metrics, 'fee_tier')),
      lpFee: numberValue(byName(metrics, 'lp_fee')),
      protocolFee: numberValue(byName(metrics, 'protocol_fee')),
      tickSpacing: numberValue(byName(metrics, 'tick_spacing')),
      hooksAddress: stringValue(byName(metrics, 'hooks_address')),
      tickLower: numberValue(byName(metrics, 'tick_lower')),
      tickUpper: numberValue(byName(metrics, 'tick_upper')),
      currentTick: numberValue(byName(metrics, 'current_tick')),
      liquidity: stringValue(byName(metrics, 'liquidity')),
      inRange: booleanValue(byName(metrics, 'in_range')),
      tokensOwed0: stringValue(byName(metrics, 'tokens_owed0')),
      tokensOwed1: stringValue(byName(metrics, 'tokens_owed1')),
    };
  }
}
