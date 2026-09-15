import { rpcIntegrationConfigSchema } from '../../api/schemas.js';
import { AaveV3PositionReader, supportedAaveV3Markets } from '../../adapters/aave/aave-v3-position-reader.js';
import type { AaveV3Position } from '../../adapters/aave/aave-v3-position-reader.js';
import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import { isEvmRpcProvider } from './integration-catalog.js';
import type { Metric } from '../metrics/metric.js';
import type { MetricPipeline } from '../metrics/metric-pipeline.js';
import type { PollingScheduler } from '../scheduling/polling-scheduler.js';

export interface AaveV3PositionReaderPort {
  read(walletAddress: string, signal?: AbortSignal): Promise<AaveV3Position | undefined>;
}

export interface AaveV3PositionReaderFactory {
  create(options: {
    rpcUrl: string;
    expectedChainId: number;
    timeoutMilliseconds: number;
    multicallBatchSizeBytes: number;
  }): AaveV3PositionReaderPort;
}

export interface AaveV3PositionCoordinatorOptions {
  fetch?: typeof globalThis.fetch;
  readerFactory?: AaveV3PositionReaderFactory;
  now?: () => Date;
  onError?: (error: Error) => void;
  maximumAttemptsPerEndpoint?: number;
  retryBaseDelayMilliseconds?: number;
  circuitBreakerFailureThreshold?: number;
  circuitBreakerCooldownMilliseconds?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface RpcEndpoint {
  id: string;
  rpcUrl: string;
  chainId: number;
  timeoutMilliseconds: number;
  multicallBatchSizeBytes: number;
}

interface ChainScanResult {
  chainId: number;
  position?: AaveV3Position | undefined;
  error?: Error | undefined;
}

interface CircuitState {
  consecutiveFailures: number;
  openUntil: number;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Aave V3 retry aborted', { cause: signal.reason }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aave V3 retry aborted', { cause: signal.reason }));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
  private readonly maximumAttemptsPerEndpoint: number;
  private readonly retryBaseDelayMilliseconds: number;
  private readonly circuitBreakerFailureThreshold: number;
  private readonly circuitBreakerCooldownMilliseconds: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly circuits = new Map<string, CircuitState>();

  public constructor(
    private readonly integrations: IntegrationRepository,
    private readonly monitors: MonitorRepository,
    private readonly metricPipeline: MetricPipeline,
    private readonly scheduler: PollingScheduler,
    options: AaveV3PositionCoordinatorOptions = {},
  ) {
    this.readerFactory = options.readerFactory ?? {
      create: (readerOptions) => new AaveV3PositionReader({
        ...readerOptions,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
    };
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => undefined);
    this.maximumAttemptsPerEndpoint = options.maximumAttemptsPerEndpoint ?? 2;
    this.retryBaseDelayMilliseconds = options.retryBaseDelayMilliseconds ?? 250;
    this.circuitBreakerFailureThreshold = options.circuitBreakerFailureThreshold ?? 3;
    this.circuitBreakerCooldownMilliseconds = options.circuitBreakerCooldownMilliseconds ?? 60_000;
    this.sleep = options.sleep ?? abortableSleep;
  }

  public reconcile(): void {
    this.circuits.clear();
    const enabledMonitors = this.monitors.listEnabledAaveMonitors();
    const desiredIds = new Set(enabledMonitors.map(({ monitorId }) => monitorId));
    for (const monitorId of this.scheduledMonitorIds) {
      if (desiredIds.has(monitorId)) continue;
      this.scheduler.remove(this.taskId(monitorId));
      this.scheduler.remove(this.staleTaskId(monitorId));
      this.scheduledMonitorIds.delete(monitorId);
    }
    for (const monitor of enabledMonitors) {
      this.scheduler.upsert({
        id: this.taskId(monitor.monitorId),
        intervalMilliseconds: monitor.intervalSeconds * 1_000,
        run: async (signal) => this.scan(monitor.monitorId, monitor.walletAddress, signal),
      });
      this.scheduler.upsert({
        id: this.staleTaskId(monitor.monitorId),
        intervalMilliseconds: Math.min(30_000, Math.max(5_000, monitor.maxStaleSeconds * 500)),
        run: async (signal) => this.checkStale(
          monitor.monitorId,
          monitor.walletAddress,
          monitor.maxStaleSeconds,
          signal,
        ),
      });
      this.scheduledMonitorIds.add(monitor.monitorId);
    }
  }

  public close(): void {
    for (const monitorId of this.scheduledMonitorIds) {
      this.scheduler.remove(this.taskId(monitorId));
      this.scheduler.remove(this.staleTaskId(monitorId));
    }
    this.scheduledMonitorIds.clear();
  }

  private taskId(monitorId: string): string {
    return `aave-v3:${monitorId}`;
  }

  private staleTaskId(monitorId: string): string {
    return `aave-v3-stale:${monitorId}`;
  }

  private rpcEndpoints(): Map<number, RpcEndpoint[]> {
    const endpoints = new Map<number, RpcEndpoint[]>();
    for (const integration of this.integrations.listRuntime()) {
      if (!integration.enabled || integration.type !== 'evm_rpc' || !isEvmRpcProvider(integration.provider)) continue;
      const parsed = rpcIntegrationConfigSchema.safeParse(integration.config);
      if (!parsed.success || !supportedAaveV3Markets.has(parsed.data.chainId)) continue;
      const chainEndpoints = endpoints.get(parsed.data.chainId) ?? [];
      chainEndpoints.push({ id: integration.id, ...parsed.data });
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
      if (this.isCircuitOpen(endpoint.id)) continue;
      signal.throwIfAborted();
      const reader = this.readerFactory.create({
        rpcUrl: endpoint.rpcUrl,
        expectedChainId: endpoint.chainId,
        timeoutMilliseconds: endpoint.timeoutMilliseconds,
        multicallBatchSizeBytes: endpoint.multicallBatchSizeBytes,
      });
      try {
        const position = await this.readWithRetry(reader, walletAddress, signal);
        this.circuits.delete(endpoint.id);
        return { chainId, position };
      } catch (error) {
        signal.throwIfAborted();
        lastError = toError(error);
        this.recordEndpointFailure(endpoint.id);
      }
    }
    return { chainId, error: lastError ?? new Error('All RPC endpoints are temporarily unavailable') };
  }

  private async readWithRetry(
    reader: AaveV3PositionReaderPort,
    walletAddress: string,
    signal: AbortSignal,
  ): Promise<AaveV3Position | undefined> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.maximumAttemptsPerEndpoint; attempt += 1) {
      signal.throwIfAborted();
      try {
        return await reader.read(walletAddress, signal);
      } catch (error) {
        signal.throwIfAborted();
        lastError = toError(error);
        if (attempt < this.maximumAttemptsPerEndpoint) {
          await this.sleep(this.retryBaseDelayMilliseconds * 2 ** (attempt - 1), signal);
        }
      }
    }
    throw lastError ?? new Error('Aave V3 RPC request failed');
  }

  private isCircuitOpen(endpointId: string): boolean {
    const circuit = this.circuits.get(endpointId);
    return circuit !== undefined && circuit.openUntil > this.now().getTime();
  }

  private recordEndpointFailure(endpointId: string): void {
    const current = this.circuits.get(endpointId) ?? { consecutiveFailures: 0, openUntil: 0 };
    const consecutiveFailures = current.consecutiveFailures + 1;
    this.circuits.set(endpointId, {
      consecutiveFailures,
      openUntil: consecutiveFailures >= this.circuitBreakerFailureThreshold
        ? this.now().getTime() + this.circuitBreakerCooldownMilliseconds
        : 0,
    });
  }

  private async checkStale(
    monitorId: string,
    walletAddress: string,
    maxStaleSeconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const latestSuccessful = this.metricPipeline.list(monitorId)
      .filter((candidate) => candidate.source === 'aave_v3' && candidate.status === 'ok')
      .reduce<Metric | undefined>((latest, candidate) => (
        latest === undefined || Date.parse(candidate.observedAt) > Date.parse(latest.observedAt) ? candidate : latest
      ), undefined);
    if (latestSuccessful === undefined) return;
    const ageSeconds = Math.max(0, (this.now().getTime() - Date.parse(latestSuccessful.observedAt)) / 1_000);
    if (ageSeconds <= maxStaleSeconds) return;
    const timestamp = this.now().toISOString();
    await this.metricPipeline.ingest(metric(
      monitorId,
      walletAddress,
      'data_age_seconds',
      String(ageSeconds),
      timestamp,
      { status: 'stale', unit: 'seconds' },
    ));
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
      ['block_number', position.blockNumber, 'block'],
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
