import { rpcIntegrationConfigSchema } from '../../api/schemas.js';
import { AaveV3PositionReader, supportedAaveV3Markets } from '../../adapters/aave/aave-v3-position-reader.js';
import type { AaveV3Position } from '../../adapters/aave/aave-v3-position-reader.js';
import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import type { Metric } from '../metrics/metric.js';
import type { MetricPipeline } from '../metrics/metric-pipeline.js';
import type { PollingScheduler } from '../scheduling/polling-scheduler.js';

export interface AaveV3PositionReaderPort {
  read(walletAddress: string, signal?: AbortSignal): Promise<AaveV3Position | undefined>;
}

export interface AaveV3PositionReaderFactory {
  create(options: { rpcUrl: string; expectedChainId: number }): AaveV3PositionReaderPort;
}

export interface AaveV3PositionCoordinatorOptions {
  fetch?: typeof globalThis.fetch;
  readerFactory?: AaveV3PositionReaderFactory;
  now?: () => Date;
  onError?: (error: Error) => void;
}

interface RpcEndpoint {
  rpcUrl: string;
  chainId: number;
}

interface ChainScanResult {
  chainId: number;
  position?: AaveV3Position | undefined;
  error?: Error | undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function metric(
  monitorId: string,
  target: string,
  name: string,
  value: string | boolean,
  observedAt: string,
  options: Pick<Metric, 'status' | 'unit' | 'labels'>,
): Metric {
  return {
    monitorId,
    source: 'aave_v3',
    target,
    name,
    value,
    observedAt,
    receivedAt: observedAt,
    ...options,
  };
}

export class AaveV3PositionCoordinator {
  private readonly scheduledMonitorIds = new Set<string>();
  private readonly readerFactory: AaveV3PositionReaderFactory;
  private readonly now: () => Date;
  private readonly onError: (error: Error) => void;

  public constructor(
    private readonly integrations: IntegrationRepository,
    private readonly monitors: MonitorRepository,
    private readonly metricPipeline: MetricPipeline,
    private readonly scheduler: PollingScheduler,
    options: AaveV3PositionCoordinatorOptions = {},
  ) {
    this.readerFactory = options.readerFactory ?? {
      create: ({ rpcUrl, expectedChainId }) => new AaveV3PositionReader({
        rpcUrl,
        expectedChainId,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
    };
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => undefined);
  }

  public reconcile(): void {
    const enabledMonitors = this.monitors.listEnabledAaveMonitors();
    const desiredIds = new Set(enabledMonitors.map(({ monitorId }) => monitorId));
    for (const monitorId of this.scheduledMonitorIds) {
      if (desiredIds.has(monitorId)) continue;
      this.scheduler.remove(this.taskId(monitorId));
      this.scheduledMonitorIds.delete(monitorId);
    }
    for (const monitor of enabledMonitors) {
      this.scheduler.upsert({
        id: this.taskId(monitor.monitorId),
        intervalMilliseconds: monitor.intervalSeconds * 1_000,
        run: async (signal) => this.scan(monitor.monitorId, monitor.walletAddress, signal),
      });
      this.scheduledMonitorIds.add(monitor.monitorId);
    }
  }

  public close(): void {
    for (const monitorId of this.scheduledMonitorIds) this.scheduler.remove(this.taskId(monitorId));
    this.scheduledMonitorIds.clear();
  }

  private taskId(monitorId: string): string {
    return `aave-v3:${monitorId}`;
  }

  private rpcEndpoints(): Map<number, RpcEndpoint[]> {
    const endpoints = new Map<number, RpcEndpoint[]>();
    for (const integration of this.integrations.listRuntime()) {
      if (!integration.enabled || integration.type !== 'evm_rpc' || integration.provider !== 'custom') continue;
      const parsed = rpcIntegrationConfigSchema.safeParse(integration.config);
      if (!parsed.success || !supportedAaveV3Markets.has(parsed.data.chainId)) continue;
      const chainEndpoints = endpoints.get(parsed.data.chainId) ?? [];
      chainEndpoints.push(parsed.data);
      endpoints.set(parsed.data.chainId, chainEndpoints);
    }
    return endpoints;
  }

  private async scan(monitorId: string, walletAddress: string, signal: AbortSignal): Promise<void> {
    const endpoints = this.rpcEndpoints();
    const timestamp = this.now().toISOString();
    this.metricPipeline.forgetMonitor(monitorId);
    if (endpoints.size === 0) {
      await this.metricPipeline.ingest(metric(
        monitorId,
        walletAddress,
        'scan_status',
        false,
        timestamp,
        { status: 'error', labels: { reason: 'no_supported_rpc' } },
      ));
      return;
    }

    const results = await Promise.all([...endpoints.entries()].map(async ([chainId, candidates]) => {
      return this.scanChain(chainId, candidates, walletAddress, signal);
    }));
    if (signal.aborted) return;

    let positionChainCount = 0;
    let positionAssetCount = 0;
    for (const result of results) {
      const market = supportedAaveV3Markets.get(result.chainId);
      if (market === undefined) continue;
      const chainLabels = { chainId: String(result.chainId), chainName: market.chainName };
      if (result.error !== undefined) {
        this.onError(new Error(`Aave V3 scan failed on ${market.chainName}`));
        await this.metricPipeline.ingest(metric(
          monitorId,
          walletAddress,
          'rpc_status',
          false,
          timestamp,
          { status: 'error', labels: chainLabels },
        ));
        continue;
      }
      await this.metricPipeline.ingest(metric(
        monitorId,
        walletAddress,
        'rpc_status',
        true,
        timestamp,
        { status: 'ok', labels: chainLabels },
      ));
      if (result.position === undefined) continue;
      positionChainCount += 1;
      positionAssetCount += result.position.assets.length;
      await this.emitPosition(monitorId, result.position, timestamp);
    }

    const scanFailed = results.some(({ error }) => error !== undefined);
    await this.metricPipeline.ingest(metric(
      monitorId,
      walletAddress,
      'position_chain_count',
      String(positionChainCount),
      timestamp,
      { status: scanFailed ? 'error' : 'ok', unit: 'chains' },
    ));
    await this.metricPipeline.ingest(metric(
      monitorId,
      walletAddress,
      'position_asset_count',
      String(positionAssetCount),
      timestamp,
      { status: scanFailed ? 'error' : 'ok', unit: 'assets' },
    ));
  }

  private async scanChain(
    chainId: number,
    endpoints: RpcEndpoint[],
    walletAddress: string,
    signal: AbortSignal,
  ): Promise<ChainScanResult> {
    let lastError: Error | undefined;
    for (const endpoint of endpoints) {
      if (signal.aborted) return { chainId, error: new Error('Aave V3 scan aborted') };
      try {
        const position = await this.readerFactory.create({
          rpcUrl: endpoint.rpcUrl,
          expectedChainId: endpoint.chainId,
        }).read(walletAddress, signal);
        return { chainId, position };
      } catch (error) {
        lastError = toError(error);
      }
    }
    return { chainId, error: lastError ?? new Error('No RPC endpoint was available') };
  }

  private async emitPosition(monitorId: string, position: AaveV3Position, timestamp: string): Promise<void> {
    const target = `${position.walletAddress}@${position.chainId}`;
    const chainLabels = { chainId: String(position.chainId), chainName: position.chainName };
    const aggregates: Array<[string, string, string]> = [
      ['total_collateral_base', position.totalCollateralBase, position.baseCurrencySymbol],
      ['total_debt_base', position.totalDebtBase, position.baseCurrencySymbol],
      ['available_borrows_base', position.availableBorrowsBase, position.baseCurrencySymbol],
      ['liquidation_threshold_percent', position.liquidationThresholdPercent, 'percent'],
      ['ltv_percent', position.ltvPercent, 'percent'],
      ['health_factor', position.healthFactor, 'ratio'],
    ];
    for (const [name, value, unit] of aggregates) {
      await this.metricPipeline.ingest(metric(monitorId, target, name, value, timestamp, {
        status: 'ok', unit, labels: chainLabels,
      }));
    }
    for (const asset of position.assets) {
      const labels = {
        ...chainLabels,
        symbol: asset.symbol,
        assetAddress: asset.underlyingAddress,
      };
      const assetMetrics: Array<[string, string | boolean, string]> = [
        ['supplied_amount', asset.supplied, asset.symbol],
        ['stable_debt_amount', asset.stableDebt, asset.symbol],
        ['variable_debt_amount', asset.variableDebt, asset.symbol],
        ['total_debt_amount', asset.totalDebt, asset.symbol],
        ['supplied_base', asset.suppliedBase, position.baseCurrencySymbol],
        ['debt_base', asset.debtBase, position.baseCurrencySymbol],
        ['usage_as_collateral', asset.usageAsCollateralEnabled, 'boolean'],
      ];
      for (const [name, value, unit] of assetMetrics) {
        await this.metricPipeline.ingest(metric(monitorId, target, name, value, timestamp, {
          status: 'ok', unit, labels,
        }));
      }
    }
  }
}
