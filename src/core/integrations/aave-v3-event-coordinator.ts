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
  private readonly scheduledTargets = new Set<string>();
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
    const targets = new Map<string, { integrationId: string; chainId: number; intervalSeconds: number }>();
    for (const monitor of [...poolMonitors, ...accountMonitors]) {
      const key = this.targetKey(monitor.rpcIntegrationId, monitor.chainId);
      const current = targets.get(key);
      targets.set(key, {
        integrationId: monitor.rpcIntegrationId,
        chainId: monitor.chainId,
        intervalSeconds: Math.min(current?.intervalSeconds ?? Number.POSITIVE_INFINITY, monitor.intervalSeconds),
      });
    }
    for (const key of this.scheduledTargets) {
      if (targets.has(key)) continue;
      this.scheduler.remove(this.taskId(key));
      this.scheduledTargets.delete(key);
    }
    for (const [key, target] of targets) {
      this.scheduler.upsert({
        id: this.taskId(key),
        intervalMilliseconds: target.intervalSeconds * 1_000,
        run: async (signal) => this.scan(target.integrationId, target.chainId, signal),
      });
      this.scheduledTargets.add(key);
    }
  }

  public close(): void {
    for (const key of this.scheduledTargets) this.scheduler.remove(this.taskId(key));
    this.scheduledTargets.clear();
  }

  private targetKey(integrationId: string, chainId: number): string {
    return `${integrationId}:${chainId}`;
  }

  private taskId(key: string): string {
    return `aave-v3-events:${key}`;
  }

  private async scan(integrationId: string, chainId: number, signal: AbortSignal): Promise<void> {
    const integration = this.integrations.getRuntime(integrationId);
    if (!integration.enabled || integration.type !== 'evm_rpc') return;
    const config = rpcIntegrationConfigSchema.safeParse(integration.config);
    if (!config.success || !config.data.chainIds.includes(chainId)) return;
    const resolved = resolveEvmRpcRequest(config.data, chainId);
    const reader = this.readerFactory.create({
      rpcUrl: resolved.rpcUrl,
      headers: resolved.headers,
      expectedChainId: chainId,
      timeoutMilliseconds: config.data.timeoutMilliseconds,
    });
    try {
      const tip = await reader.latestBlock(signal);
      const confirmedTip = tip > this.confirmationBlocks ? tip - this.confirmationBlocks : 0n;
      const saved = this.cursors.get(integrationId, 'aave_v3_events', chainId, 'pool');
      let fromBlock = saved === undefined
        ? (confirmedTip > this.initialLookbackBlocks ? confirmedTip - this.initialLookbackBlocks : 0n)
        : (saved > this.reorgRewindBlocks ? saved - this.reorgRewindBlocks + 1n : 0n);
      while (fromBlock <= confirmedTip) {
        signal.throwIfAborted();
        const toBlock = fromBlock + this.blockChunkSize - 1n < confirmedTip
          ? fromBlock + this.blockChunkSize - 1n : confirmedTip;
        const events = await reader.scan(fromBlock, toBlock, signal);
        for (const event of events) await this.distribute(integrationId, chainId, event);
        this.cursors.save(integrationId, 'aave_v3_events', chainId, 'pool', toBlock);
        await this.emitProgress(integrationId, chainId, tip, confirmedTip, toBlock);
        fromBlock = toBlock + 1n;
      }
    } catch (error) {
      if (signal.aborted) return;
      this.onError(error instanceof Error ? error : new Error(String(error)));
      await this.emitFailure(integrationId, chainId);
    }
  }

  private async distribute(integrationId: string, chainId: number, event: AaveV3ChainEvent): Promise<void> {
    const eventLabels = labels(event);
    for (const monitor of this.monitors.listEnabledAavePoolMonitors()) {
      if (monitor.rpcIntegrationId !== integrationId || monitor.chainId !== chainId) continue;
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
      if (monitor.legacy || monitor.rpcIntegrationId !== integrationId || monitor.chainId !== chainId ||
        !participates(monitor.walletAddress, event)) continue;
      await this.metricPipeline.ingest({
        monitorId: monitor.monitorId, source: 'aave_v3', target: monitor.walletAddress,
        name: `account_${event.eventType}`, value: event.tokenAmount, unit: event.symbol,
        observedAt: event.observedAt, receivedAt: new Date().toISOString(), status: 'ok', kind: 'event',
        eventId: event.eventId, labels: eventLabels,
      });
    }
  }

  private async emitProgress(integrationId: string, chainId: number, tip: bigint, confirmedTip: bigint, scannedThrough: bigint): Promise<void> {
    const now = new Date().toISOString();
    for (const monitor of this.monitors.listEnabledAavePoolMonitors().filter(
      (item) => item.rpcIntegrationId === integrationId && item.chainId === chainId,
    )) {
      await this.metricPipeline.ingest({
        monitorId: monitor.monitorId, source: 'aave_v3', target: String(chainId), name: 'event_scan_status', value: true,
        observedAt: now, receivedAt: now, status: 'ok',
        labels: {
          chainId: String(chainId),
          chainTipBlock: tip.toString(),
          confirmedTipBlock: confirmedTip.toString(),
          scannedThroughBlock: scannedThrough.toString(),
          confirmationBlocks: this.confirmationBlocks.toString(),
        },
      });
    }
  }

  private async emitFailure(integrationId: string, chainId: number): Promise<void> {
    const now = new Date().toISOString();
    for (const monitor of this.monitors.listEnabledAavePoolMonitors().filter(
      (item) => item.rpcIntegrationId === integrationId && item.chainId === chainId,
    )) {
      await this.metricPipeline.ingest({
        monitorId: monitor.monitorId, source: 'aave_v3', target: String(chainId), name: 'event_scan_status', value: false,
        observedAt: now, receivedAt: now, status: 'error', labels: { chainId: String(chainId), reason: 'rpc_scan_failed' },
      });
    }
  }
}
