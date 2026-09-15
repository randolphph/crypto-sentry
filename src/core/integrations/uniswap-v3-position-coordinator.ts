import { UniswapV3PositionReader } from '../../adapters/uniswap/uniswap-v3-position-reader.js';
import type { UniswapV3Position } from '../../adapters/uniswap/uniswap-v3-position-reader.js';
import { rpcIntegrationConfigSchema } from '../../api/schemas.js';
import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import type { Metric } from '../metrics/metric.js';
import type { MetricPipeline } from '../metrics/metric-pipeline.js';
import type { PollingScheduler } from '../scheduling/polling-scheduler.js';

export interface UniswapV3PositionReaderPort {
  read(tokenId: string, signal?: AbortSignal): Promise<UniswapV3Position>;
}

export interface UniswapV3PositionReaderFactory {
  create(options: {
    rpcUrl: string;
    expectedChainId: number;
    timeoutMilliseconds: number;
  }): UniswapV3PositionReaderPort;
}

export interface UniswapV3PositionCoordinatorOptions {
  fetch?: typeof globalThis.fetch;
  readerFactory?: UniswapV3PositionReaderFactory;
  now?: () => Date;
  onError?: (error: Error) => void;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function metric(
  monitorId: string,
  tokenId: string,
  name: string,
  value: string | boolean,
  observedAt: string,
  options: Pick<Metric, 'status' | 'unit' | 'labels'>,
): Metric {
  return {
    monitorId,
    source: 'uniswap_v3',
    target: tokenId,
    name,
    value,
    observedAt,
    receivedAt: observedAt,
    ...options,
  };
}

export class UniswapV3PositionCoordinator {
  private readonly scheduledMonitorIds = new Set<string>();
  private readonly readerFactory: UniswapV3PositionReaderFactory;
  private readonly now: () => Date;
  private readonly onError: (error: Error) => void;

  public constructor(
    private readonly integrations: IntegrationRepository,
    private readonly monitors: MonitorRepository,
    private readonly metricPipeline: MetricPipeline,
    private readonly scheduler: PollingScheduler,
    options: UniswapV3PositionCoordinatorOptions = {},
  ) {
    this.readerFactory = options.readerFactory ?? {
      create: (readerOptions) => new UniswapV3PositionReader({
        ...readerOptions,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
    };
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => undefined);
  }

  public reconcile(): void {
    const monitors = this.monitors.listEnabledUniswapV3Monitors();
    const desiredIds = new Set(monitors.map(({ monitorId }) => monitorId));
    for (const monitorId of this.scheduledMonitorIds) {
      if (desiredIds.has(monitorId)) continue;
      this.scheduler.remove(this.taskId(monitorId));
      this.scheduler.remove(this.staleTaskId(monitorId));
      this.scheduledMonitorIds.delete(monitorId);
    }
    for (const monitor of monitors) {
      this.scheduler.upsert({
        id: this.taskId(monitor.monitorId),
        intervalMilliseconds: monitor.intervalSeconds * 1_000,
        run: async (signal) => this.scan(monitor, signal),
      });
      this.scheduler.upsert({
        id: this.staleTaskId(monitor.monitorId),
        intervalMilliseconds: Math.min(30_000, Math.max(5_000, monitor.maxStaleSeconds * 500)),
        run: async (signal) => this.checkStale(
          monitor.monitorId,
          monitor.tokenId,
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
    return `uniswap-v3:${monitorId}`;
  }

  private staleTaskId(monitorId: string): string {
    return `uniswap-v3-stale:${monitorId}`;
  }

  private async scan(
    monitor: ReturnType<MonitorRepository['listEnabledUniswapV3Monitors']>[number],
    signal: AbortSignal,
  ): Promise<void> {
    const timestamp = this.now().toISOString();
    const baseLabels = {
      chainId: String(monitor.chainId),
      chainName: 'Robinhood Chain',
      protocol: monitor.protocol,
      version: monitor.version,
      tokenId: monitor.tokenId,
    };
    try {
      const integration = this.integrations.getRuntime(monitor.rpcIntegrationId);
      const rpc = rpcIntegrationConfigSchema.parse(integration.config);
      if (!integration.enabled || integration.type !== 'evm_rpc') throw new Error('Configured RPC integration is unavailable');
      if (rpc.chainId !== monitor.chainId) {
        throw new Error(`EVM RPC chain ID mismatch: expected ${monitor.chainId}, received ${rpc.chainId}`);
      }
      const position = await this.readerFactory.create({
        rpcUrl: rpc.rpcUrl,
        expectedChainId: monitor.chainId,
        timeoutMilliseconds: rpc.timeoutMilliseconds,
      }).read(monitor.tokenId, signal);
      if (signal.aborted) return;
      this.metricPipeline.forgetMonitor(monitor.monitorId);
      await this.emitPosition(monitor.monitorId, position, timestamp);
    } catch (error) {
      if (signal.aborted) return;
      const failure = toError(error);
      this.onError(failure);
      const previousLabels = this.metricPipeline.list(monitor.monitorId)
        .find((candidate) => candidate.source === 'uniswap_v3' && candidate.name === 'read_status')
        ?.labels;
      await this.metricPipeline.ingest(metric(
        monitor.monitorId,
        monitor.tokenId,
        'read_status',
        false,
        timestamp,
        { status: 'error', labels: { ...previousLabels, ...baseLabels } },
      ));
    }
  }

  private async emitPosition(monitorId: string, position: UniswapV3Position, timestamp: string): Promise<void> {
    const labels = {
      chainId: String(position.chainId),
      chainName: position.chainName,
      protocol: position.protocol,
      version: position.version,
      tokenId: position.tokenId,
      token0Address: position.token0.address,
      token0Symbol: position.token0.symbol,
      token0Decimals: String(position.token0.decimals),
      token1Address: position.token1.address,
      token1Symbol: position.token1.symbol,
      token1Decimals: String(position.token1.decimals),
    };
    const values: Array<[string, string | boolean, string]> = [
      ['read_status', true, 'boolean'],
      ['position_owner', position.owner, 'address'],
      ['position_manager_address', position.positionManagerAddress, 'address'],
      ['pool_address', position.poolAddress, 'address'],
      ['block_number', position.blockNumber, 'block'],
      ['fee_tier', String(position.feeTier), 'hundredths_bps'],
      ['tick_lower', String(position.tickLower), 'tick'],
      ['tick_upper', String(position.tickUpper), 'tick'],
      ['current_tick', String(position.currentTick), 'tick'],
      ['liquidity', position.liquidity, 'liquidity'],
      ['in_range', position.inRange, 'boolean'],
      ['tokens_owed0', position.tokensOwed0, position.token0.symbol],
      ['tokens_owed1', position.tokensOwed1, position.token1.symbol],
    ];
    for (const [name, value, unit] of values) {
      await this.metricPipeline.ingest(metric(monitorId, position.tokenId, name, value, timestamp, {
        status: 'ok', unit, labels,
      }));
    }
  }

  private async checkStale(
    monitorId: string,
    tokenId: string,
    maxStaleSeconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const latestSuccessful = this.metricPipeline.list(monitorId)
      .filter((candidate) => candidate.source === 'uniswap_v3' && candidate.status === 'ok')
      .reduce<Metric | undefined>((latest, candidate) => (
        latest === undefined || Date.parse(candidate.observedAt) > Date.parse(latest.observedAt) ? candidate : latest
      ), undefined);
    if (latestSuccessful === undefined) return;
    const ageSeconds = Math.max(0, (this.now().getTime() - Date.parse(latestSuccessful.observedAt)) / 1_000);
    if (ageSeconds <= maxStaleSeconds) return;
    const timestamp = this.now().toISOString();
    await this.metricPipeline.ingest(metric(
      monitorId,
      tokenId,
      'data_age_seconds',
      String(ageSeconds),
      timestamp,
      { status: 'stale', unit: 'seconds' },
    ));
  }
}
