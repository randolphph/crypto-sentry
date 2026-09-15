import { AppError } from '../../api/errors.js';
import { aaveMonitorConfigSchema } from '../../api/schemas.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import type { Metric } from '../metrics/metric.js';
import type { MetricSnapshotReader } from '../metrics/latest-metric-store.js';

export type AavePositionSnapshotStatus = 'warming_up' | 'ok' | 'empty' | 'partial' | 'stale' | 'error';

export interface AaveAssetSnapshot {
  symbol: string;
  assetAddress: string;
  suppliedAmount: string | null;
  stableDebtAmount: string | null;
  variableDebtAmount: string | null;
  totalDebtAmount: string | null;
  suppliedBase: string | null;
  debtBase: string | null;
  usageAsCollateral: boolean | null;
}

export interface AaveChainPositionSnapshot {
  chainId: number;
  chainName: string;
  blockNumber: string | null;
  observedAt: string;
  baseCurrency: string;
  account: {
    totalCollateralBase: string | null;
    totalDebtBase: string | null;
    availableBorrowsBase: string | null;
    liquidationThresholdPercent: string | null;
    ltvPercent: string | null;
    healthFactor: string | null;
  };
  assets: AaveAssetSnapshot[];
}

export interface AaveNetworkScanSnapshot {
  chainId: number;
  chainName: string;
  status: 'ok' | 'stale' | 'error';
  hasPosition: boolean;
  observedAt: string;
}

export interface AavePositionSnapshot {
  monitorId: string;
  walletAddress: string;
  status: AavePositionSnapshotStatus;
  observedAt: string | null;
  dataAgeSeconds: number | null;
  maxStaleSeconds: number;
  summary: {
    scannedChainCount: number;
    successfulChainCount: number;
    failedChainCount: number;
    positionChainCount: number;
    positionAssetCount: number;
  };
  networkScans: AaveNetworkScanSnapshot[];
  positions: AaveChainPositionSnapshot[];
  error: { code: 'NO_SUPPORTED_RPC'; message: string } | null;
}

function stringValue(metric: Metric | undefined): string | null {
  return typeof metric?.value === 'string' ? metric.value : null;
}

function booleanValue(metric: Metric | undefined): boolean | null {
  return typeof metric?.value === 'boolean' ? metric.value : null;
}

function valueByName(metrics: Metric[], name: string): Metric | undefined {
  return metrics.find((metric) => metric.name === name);
}

function numericMetricValue(metrics: Metric[], name: string): number {
  const value = stringValue(valueByName(metrics, name));
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestObservation(metrics: Metric[]): string | null {
  return metrics.reduce<string | null>((latest, metric) => {
    return latest === null || Date.parse(metric.observedAt) > Date.parse(latest) ? metric.observedAt : latest;
  }, null);
}

function groupBy<T>(values: T[], key: (value: T) => string | undefined): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    if (groupKey === undefined) continue;
    const group = grouped.get(groupKey) ?? [];
    group.push(value);
    grouped.set(groupKey, group);
  }
  return grouped;
}

export class AavePositionSnapshotService {
  public constructor(
    private readonly monitors: MonitorRepository,
    private readonly metrics: MetricSnapshotReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public get(monitorId: string): AavePositionSnapshot {
    const monitor = this.monitors.get(monitorId);
    if (monitor.type !== 'aave_position') {
      throw new AppError(409, 'MONITOR_TYPE_MISMATCH', 'Position snapshots are only available for Aave monitors');
    }
    const config = aaveMonitorConfigSchema.parse(monitor.config);
    const metrics = this.metrics.list(monitorId).filter((metric) => metric.source === 'aave_v3');
    const observedAt = latestObservation(metrics);
    const dataAgeSeconds = observedAt === null
      ? null
      : Math.max(0, Math.round((this.now().getTime() - Date.parse(observedAt)) / 100) / 10);
    const isStale = dataAgeSeconds !== null && dataAgeSeconds > monitor.maxStaleSeconds;

    const rpcMetrics = metrics.filter((metric) => metric.name === 'rpc_status' && metric.labels?.chainId !== undefined);
    const positionMetrics = metrics.filter((metric) => metric.labels?.chainId !== undefined && metric.name !== 'rpc_status');
    const positionMetricsByChain = groupBy(positionMetrics, (metric) => metric.labels?.chainId);
    const positions = [...positionMetricsByChain.entries()]
      .filter(([, chainMetrics]) => chainMetrics.some((metric) => metric.name === 'health_factor'))
      .map(([chainId, chainMetrics]) => this.buildChainPosition(chainId, chainMetrics))
      .sort((left, right) => left.chainId - right.chainId);
    const positionChainIds = new Set(positions.map(({ chainId }) => chainId));
    const networkScans = rpcMetrics.map((rpcMetric) => ({
      chainId: Number(rpcMetric.labels?.chainId),
      chainName: rpcMetric.labels?.chainName ?? `Chain ${String(rpcMetric.labels?.chainId)}`,
      status: rpcMetric.status === 'error' ? 'error' as const : isStale ? 'stale' as const : 'ok' as const,
      hasPosition: positionChainIds.has(Number(rpcMetric.labels?.chainId)),
      observedAt: rpcMetric.observedAt,
    })).sort((left, right) => left.chainId - right.chainId);

    const successfulChainCount = networkScans.filter(({ status }) => status !== 'error').length;
    const failedChainCount = networkScans.filter(({ status }) => status === 'error').length;
    const noSupportedRpc = metrics.some((metric) => (
      metric.name === 'scan_status' && metric.value === false && metric.labels?.reason === 'no_supported_rpc'
    ));
    const positionAssetCount = positions.reduce((count, position) => count + position.assets.length, 0);

    return {
      monitorId,
      walletAddress: config.walletAddress,
      status: this.status({
        metricCount: metrics.length,
        noSupportedRpc,
        isStale,
        successfulChainCount,
        failedChainCount,
        positionChainCount: positions.length,
      }),
      observedAt,
      dataAgeSeconds,
      maxStaleSeconds: monitor.maxStaleSeconds,
      summary: {
        scannedChainCount: networkScans.length,
        successfulChainCount,
        failedChainCount,
        positionChainCount: positions.length,
        positionAssetCount: numericMetricValue(metrics, 'position_asset_count') || positionAssetCount,
      },
      networkScans,
      positions,
      error: noSupportedRpc ? {
        code: 'NO_SUPPORTED_RPC',
        message: 'No enabled RPC integration matches a supported Aave V3 network',
      } : null,
    };
  }

  private buildChainPosition(chainId: string, metrics: Metric[]): AaveChainPositionSnapshot {
    const healthFactor = valueByName(metrics, 'health_factor');
    const assetsByAddress = groupBy(
      metrics.filter((metric) => metric.labels?.assetAddress !== undefined),
      (metric) => metric.labels?.assetAddress,
    );
    const assets = [...assetsByAddress.entries()].map(([assetAddress, assetMetrics]) => ({
      symbol: assetMetrics[0]?.labels?.symbol ?? 'UNKNOWN',
      assetAddress,
      suppliedAmount: stringValue(valueByName(assetMetrics, 'supplied_amount')),
      stableDebtAmount: stringValue(valueByName(assetMetrics, 'stable_debt_amount')),
      variableDebtAmount: stringValue(valueByName(assetMetrics, 'variable_debt_amount')),
      totalDebtAmount: stringValue(valueByName(assetMetrics, 'total_debt_amount')),
      suppliedBase: stringValue(valueByName(assetMetrics, 'supplied_base')),
      debtBase: stringValue(valueByName(assetMetrics, 'debt_base')),
      usageAsCollateral: booleanValue(valueByName(assetMetrics, 'usage_as_collateral')),
    })).sort((left, right) => left.symbol.localeCompare(right.symbol));

    return {
      chainId: Number(chainId),
      chainName: healthFactor?.labels?.chainName ?? `Chain ${chainId}`,
      blockNumber: stringValue(valueByName(metrics, 'block_number')),
      observedAt: latestObservation(metrics) ?? healthFactor?.observedAt ?? new Date(0).toISOString(),
      baseCurrency: valueByName(metrics, 'total_collateral_base')?.unit ?? 'USD',
      account: {
        totalCollateralBase: stringValue(valueByName(metrics, 'total_collateral_base')),
        totalDebtBase: stringValue(valueByName(metrics, 'total_debt_base')),
        availableBorrowsBase: stringValue(valueByName(metrics, 'available_borrows_base')),
        liquidationThresholdPercent: stringValue(valueByName(metrics, 'liquidation_threshold_percent')),
        ltvPercent: stringValue(valueByName(metrics, 'ltv_percent')),
        healthFactor: stringValue(healthFactor),
      },
      assets,
    };
  }

  private status(input: {
    metricCount: number;
    noSupportedRpc: boolean;
    isStale: boolean;
    successfulChainCount: number;
    failedChainCount: number;
    positionChainCount: number;
  }): AavePositionSnapshotStatus {
    if (input.metricCount === 0) return 'warming_up';
    if (input.noSupportedRpc || (input.failedChainCount > 0 && input.successfulChainCount === 0)) return 'error';
    if (input.isStale) return 'stale';
    if (input.failedChainCount > 0) return 'partial';
    if (input.positionChainCount === 0) return 'empty';
    return 'ok';
  }
}
