import { rpcIntegrationConfigSchema } from '../../api/schemas.js';
import { AaveV3EventReader } from '../../adapters/aave/aave-v3-event-reader.js';
import type { AaveV3ChainEvent, AaveV3EventReaderOptions } from '../../adapters/aave/aave-v3-event-reader.js';
import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import type { ChainScanCursorRepository } from '../../db/repositories/chain-scan-cursor-repository.js';
import type { MetricPipeline } from '../metrics/metric-pipeline.js';
import type { PollingScheduler } from '../scheduling/polling-scheduler.js';
import { resolveEvmRpcRequest } from './evm-rpc-config.js';

export interface AaveV3EventReaderPort {
  latestBlock(signal?: AbortSignal): Promise<bigint>;
  scan(fromBlock: bigint, toBlock: bigint, signal?: AbortSignal): Promise<AaveV3ChainEvent[]>;
}

export interface AaveV3EventReaderFactory {
  create(options: AaveV3EventReaderOptions): AaveV3EventReaderPort;
}

export interface AaveV3EventCoordinatorOptions {
  fetch?: typeof globalThis.fetch;
  readerFactory?: AaveV3EventReaderFactory;
  confirmationBlocks?: bigint;
  reorgRewindBlocks?: bigint;
  initialLookbackBlocks?: bigint;
  blockChunkSize?: bigint;
  onError?: (error: Error) => void;
}

function labels(event: AaveV3ChainEvent): Record<string, string> {
  return {
    eventType: event.eventType,
    chainId: String(event.chainId),
    reserveAssetAddress: event.reserveAssetAddress,
    symbol: event.symbol,
    blockNumber: event.blockNumber,
    transactionHash: event.transactionHash,
    logIndex: String(event.logIndex),
    valuationStatus: event.valuationStatus,
    ...(event.user === null ? {} : { user: event.user }),
    ...(event.onBehalfOf === null ? {} : { onBehalfOf: event.onBehalfOf }),
    ...(event.repayer === null ? {} : { repayer: event.repayer }),
    ...(event.to === null ? {} : { to: event.to }),
    ...(event.liquidator === null ? {} : { liquidator: event.liquidator }),
    ...(event.collateralAssetAddress === null ? {} : { collateralAssetAddress: event.collateralAssetAddress }),
    ...(event.collateralSymbol === null ? {} : { collateralSymbol: event.collateralSymbol }),
    ...(event.collateralTokenAmount === null ? {} : { collateralTokenAmount: event.collateralTokenAmount }),
    ...(event.collateralUsdAmount === null ? {} : { collateralUsdAmount: event.collateralUsdAmount }),
  };
}

function participates(walletAddress: string, event: AaveV3ChainEvent): boolean {
  const wallet = walletAddress.toLowerCase();
  return [event.user, event.onBehalfOf, event.repayer, event.to, event.liquidator]
    .some((address) => address?.toLowerCase() === wallet);
}

export class AaveV3EventCoordinator {
  private readonly scheduledIntegrationIds = new Set<string>();
  private readonly readerFactory: AaveV3EventReaderFactory;
  private readonly confirmationBlocks: bigint;
  private readonly reorgRewindBlocks: bigint;
  private readonly initialLookbackBlocks: bigint;
  private readonly blockChunkSize: bigint;
  private readonly onError: (error: Error) => void;

  public constructor(
    private readonly integrations: IntegrationRepository,
    private readonly monitors: MonitorRepository,
    private readonly cursors: ChainScanCursorRepository,
    private readonly metricPipeline: MetricPipeline,
    private readonly scheduler: PollingScheduler,
    options: AaveV3EventCoordinatorOptions = {},
  ) {
    this.readerFactory = options.readerFactory ?? {
      create: (readerOptions) => new AaveV3EventReader({
        ...readerOptions,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
    };
    this.confirmationBlocks = options.confirmationBlocks ?? 12n;
    this.reorgRewindBlocks = options.reorgRewindBlocks ?? 12n;
    this.initialLookbackBlocks = options.initialLookbackBlocks ?? 2_000n;
    this.blockChunkSize = options.blockChunkSize ?? 2_000n;
    this.onError = options.onError ?? (() => undefined);
  }

  public reconcile(): void {
    const poolMonitors = this.monitors.listEnabledAavePoolMonitors();
    const accountMonitors = this.monitors.listEnabledAaveMonitors().flatMap((monitor) => (
      monitor.legacy ? [] : [monitor]
    ));
    const integrationIds = new Set([
      ...poolMonitors.map((monitor) => monitor.rpcIntegrationId),
      ...accountMonitors.map((monitor) => monitor.rpcIntegrationId),
    ]);
    for (const id of this.scheduledIntegrationIds) {
      if (integrationIds.has(id)) continue;
      this.scheduler.remove(this.taskId(id));
      this.scheduledIntegrationIds.delete(id);
    }
    for (const integrationId of integrationIds) {
      const intervals = [
        ...poolMonitors.filter((monitor) => monitor.rpcIntegrationId === integrationId).map((monitor) => monitor.intervalSeconds),
        ...accountMonitors.filter((monitor) => monitor.rpcIntegrationId === integrationId).map((monitor) => monitor.intervalSeconds),
      ];
      this.scheduler.upsert({
        id: this.taskId(integrationId),
        intervalMilliseconds: Math.min(...intervals) * 1_000,
        run: async (signal) => this.scan(integrationId, signal),
      });
      this.scheduledIntegrationIds.add(integrationId);
    }
  }

  public close(): void {
    for (const integrationId of this.scheduledIntegrationIds) this.scheduler.remove(this.taskId(integrationId));
    this.scheduledIntegrationIds.clear();
  }

  private taskId(integrationId: string): string {
    return `aave-v3-events:${integrationId}`;
  }

  private async scan(integrationId: string, signal: AbortSignal): Promise<void> {
    const integration = this.integrations.getRuntime(integrationId);
    if (!integration.enabled || integration.type !== 'evm_rpc') return;
    const config = rpcIntegrationConfigSchema.safeParse(integration.config);
    if (!config.success || !config.data.chainIds.includes(1)) return;
    const resolved = resolveEvmRpcRequest(config.data, 1);
    const reader = this.readerFactory.create({
      rpcUrl: resolved.rpcUrl,
      headers: resolved.headers,
      expectedChainId: 1,
      timeoutMilliseconds: config.data.timeoutMilliseconds,
    });
    try {
      const tip = await reader.latestBlock(signal);
      const confirmedTip = tip > this.confirmationBlocks ? tip - this.confirmationBlocks : 0n;
      const saved = this.cursors.get(integrationId, 'aave_v3_events', 1, 'pool');
      let fromBlock = saved === undefined
        ? (confirmedTip > this.initialLookbackBlocks ? confirmedTip - this.initialLookbackBlocks : 0n)
        : (saved > this.reorgRewindBlocks ? saved - this.reorgRewindBlocks + 1n : 0n);
      while (fromBlock <= confirmedTip) {
        signal.throwIfAborted();
        const toBlock = fromBlock + this.blockChunkSize - 1n < confirmedTip
          ? fromBlock + this.blockChunkSize - 1n : confirmedTip;
        const events = await reader.scan(fromBlock, toBlock, signal);
        for (const event of events) await this.distribute(integrationId, event);
        this.cursors.save(integrationId, 'aave_v3_events', 1, 'pool', toBlock);
        await this.emitProgress(integrationId, tip, toBlock);
        fromBlock = toBlock + 1n;
      }
    } catch (error) {
      if (!signal.aborted) this.onError(error instanceof Error ? error : new Error(String(error)));
      await this.emitFailure(integrationId);
    }
  }

  private async distribute(integrationId: string, event: AaveV3ChainEvent): Promise<void> {
    const eventLabels = labels(event);
    for (const monitor of this.monitors.listEnabledAavePoolMonitors()) {
      if (monitor.rpcIntegrationId !== integrationId) continue;
      if (monitor.reserveAssetAddresses.length > 0 && !monitor.reserveAssetAddresses.some(
        (address) => address.toLowerCase() === event.reserveAssetAddress.toLowerCase(),
      )) continue;
      await this.metricPipeline.ingest({
        monitorId: monitor.monitorId, source: 'aave_v3', target: event.reserveAssetAddress,
        name: 'aave_event_amount_token', value: event.tokenAmount, unit: event.symbol,
        observedAt: event.observedAt, receivedAt: new Date().toISOString(), status: 'ok', kind: 'event',
        eventId: event.eventId, labels: eventLabels,
      });
      if (event.usdAmount !== null) await this.metricPipeline.ingest({
        monitorId: monitor.monitorId, source: 'aave_v3', target: event.reserveAssetAddress,
        name: 'aave_event_amount_usd', value: event.usdAmount, unit: 'USD',
        observedAt: event.observedAt, receivedAt: new Date().toISOString(), status: 'ok', kind: 'event',
        eventId: event.eventId, labels: eventLabels,
      });
    }
    for (const monitor of this.monitors.listEnabledAaveMonitors()) {
      if (monitor.legacy || monitor.rpcIntegrationId !== integrationId || !participates(monitor.walletAddress, event)) continue;
      await this.metricPipeline.ingest({
        monitorId: monitor.monitorId, source: 'aave_v3', target: monitor.walletAddress,
        name: `account_${event.eventType}`, value: event.tokenAmount, unit: event.symbol,
        observedAt: event.observedAt, receivedAt: new Date().toISOString(), status: 'ok', kind: 'event',
        eventId: event.eventId, labels: eventLabels,
      });
    }
  }

  private async emitProgress(integrationId: string, tip: bigint, scannedThrough: bigint): Promise<void> {
    const now = new Date().toISOString();
    for (const monitor of this.monitors.listEnabledAavePoolMonitors().filter((item) => item.rpcIntegrationId === integrationId)) {
      await this.metricPipeline.ingest({
        monitorId: monitor.monitorId, source: 'aave_v3', target: 'ethereum', name: 'event_scan_status', value: true,
        observedAt: now, receivedAt: now, status: 'ok',
        labels: { chainId: '1', chainTipBlock: tip.toString(), scannedThroughBlock: scannedThrough.toString() },
      });
    }
  }

  private async emitFailure(integrationId: string): Promise<void> {
    const now = new Date().toISOString();
    for (const monitor of this.monitors.listEnabledAavePoolMonitors().filter((item) => item.rpcIntegrationId === integrationId)) {
      await this.metricPipeline.ingest({
        monitorId: monitor.monitorId, source: 'aave_v3', target: 'ethereum', name: 'event_scan_status', value: false,
        observedAt: now, receivedAt: now, status: 'error', labels: { chainId: '1', reason: 'rpc_scan_failed' },
      });
    }
  }
}
