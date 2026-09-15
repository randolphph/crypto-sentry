import { getAddress } from 'viem';
import type { Address } from 'viem';

import { UniswapV3PositionReader } from '../../adapters/uniswap/uniswap-v3-position-reader.js';
import type { UniswapV3OwnedPositions, UniswapV3Position } from '../../adapters/uniswap/uniswap-v3-position-reader.js';
import { UniswapV4OwnershipIndexer } from '../../adapters/uniswap/uniswap-v4-ownership-indexer.js';
import type { UniswapV4OwnershipSyncResult } from '../../adapters/uniswap/uniswap-v4-ownership-indexer.js';
import { UniswapV4PositionReader } from '../../adapters/uniswap/uniswap-v4-position-reader.js';
import type { UniswapV4Position } from '../../adapters/uniswap/uniswap-v4-position-reader.js';
import { rpcIntegrationConfigSchema } from '../../api/schemas.js';
import { resolveEvmRpcRequest } from './evm-rpc-config.js';
import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import type { UniswapV4OwnershipRepository } from '../../db/repositories/uniswap-v4-ownership-repository.js';
import type { Metric } from '../metrics/metric.js';
import type { MetricPipeline } from '../metrics/metric-pipeline.js';
import type { PollingScheduler } from '../scheduling/polling-scheduler.js';

type UniswapPosition = UniswapV3Position | UniswapV4Position;
type UniswapMonitor = ReturnType<MonitorRepository['listEnabledUniswapMonitors']>[number];
type UniswapVariant = UniswapMonitor['variants'][number];

export interface UniswapV3PositionReaderPort {
  discover(walletAddress: Address, signal?: AbortSignal): Promise<UniswapV3OwnedPositions>;
  read(tokenId: string, signal?: AbortSignal, blockNumber?: bigint): Promise<UniswapV3Position>;
}

export interface UniswapV3PositionReaderFactory {
  create(options: { rpcUrl: string; headers?: Record<string, string>; expectedChainId: number; timeoutMilliseconds: number }): UniswapV3PositionReaderPort;
}

export interface UniswapV4PositionReaderPort {
  read(tokenId: string, signal?: AbortSignal, blockNumber?: bigint): Promise<UniswapV4Position>;
}

export interface UniswapV4PositionReaderFactory {
  create(options: { rpcUrl: string; headers?: Record<string, string>; expectedChainId: number; timeoutMilliseconds: number }): UniswapV4PositionReaderPort;
}

export interface UniswapV4OwnershipIndexerPort {
  sync(walletAddress: Address, signal?: AbortSignal): Promise<UniswapV4OwnershipSyncResult>;
}

export interface UniswapV4OwnershipIndexerFactory {
  create(options: {
    rpcUrl: string;
    expectedChainId: number;
    integrationId: string;
    timeoutMilliseconds: number;
    headers?: Record<string, string>;
  }): UniswapV4OwnershipIndexerPort;
}

export interface UniswapV3PositionCoordinatorOptions {
  fetch?: typeof globalThis.fetch;
  readerFactory?: UniswapV3PositionReaderFactory;
  v4ReaderFactory?: UniswapV4PositionReaderFactory;
  v4OwnershipIndexerFactory?: UniswapV4OwnershipIndexerFactory;
  now?: () => Date;
  onError?: (error: Error) => void;
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
    source: 'uniswap',
    target,
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
  private readonly v4ReaderFactory: UniswapV4PositionReaderFactory;
  private readonly v4OwnershipIndexerFactory: UniswapV4OwnershipIndexerFactory;
  private readonly now: () => Date;
  private readonly onError: (error: Error) => void;

  public constructor(
    private readonly integrations: IntegrationRepository,
    private readonly monitors: MonitorRepository,
    private readonly ownership: UniswapV4OwnershipRepository,
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
    this.v4ReaderFactory = options.v4ReaderFactory ?? {
      create: (readerOptions) => new UniswapV4PositionReader({
        ...readerOptions,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
    };
    this.v4OwnershipIndexerFactory = options.v4OwnershipIndexerFactory ?? {
      create: (indexerOptions) => new UniswapV4OwnershipIndexer({
        ...indexerOptions,
        repository: this.ownership,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
    };
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => undefined);
  }

  public reconcile(): void {
    const monitors = this.monitors.listEnabledUniswapMonitors();
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
        run: async (signal) => this.checkStale(monitor, signal),
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
    return `uniswap:${monitorId}`;
  }

  private staleTaskId(monitorId: string): string {
    return `uniswap-stale:${monitorId}`;
  }

  private async scan(monitor: UniswapMonitor, signal: AbortSignal): Promise<void> {
    this.metricPipeline.forgetMonitor(monitor.monitorId);
    await Promise.all(monitor.variants.map(async (variant) => this.scanVariant(monitor, variant, signal)));
  }

  private async scanVariant(monitor: UniswapMonitor, variant: UniswapVariant, signal: AbortSignal): Promise<void> {
    const timestamp = this.now().toISOString();
    const target = 'walletAddress' in monitor ? monitor.walletAddress : monitor.tokenId;
    const baseLabels = {
      chainId: String(variant.chainId),
      chainName: 'Robinhood Chain',
      protocol: 'uniswap',
      version: variant.version,
      ...('walletAddress' in monitor ? { walletAddress: getAddress(monitor.walletAddress) } : {}),
    };
    try {
      const integration = this.integrations.getRuntime(monitor.rpcIntegrationId);
      const rpc = rpcIntegrationConfigSchema.parse(integration.config);
      if (!integration.enabled || integration.type !== 'evm_rpc') throw new Error('Configured RPC integration is unavailable');
      const resolved = resolveEvmRpcRequest(rpc, variant.chainId);

      const discovery = await this.discover(monitor, variant, resolved.rpcUrl, resolved.headers, rpc.timeoutMilliseconds, signal);
      const positions: UniswapPosition[] = [];
      const failures: string[] = [];
      for (const tokenId of discovery.tokenIds) {
        signal.throwIfAborted();
        try {
          const position = await this.readPosition(
            variant.version,
            tokenId,
            resolved.rpcUrl,
            resolved.headers,
            variant.chainId,
            rpc.timeoutMilliseconds,
            signal,
            discovery.blockNumber,
          );
          if ('walletAddress' in monitor && position.owner.toLowerCase() !== monitor.walletAddress.toLowerCase()) continue;
          positions.push(position);
        } catch {
          failures.push(tokenId);
          this.onError(new Error(`Uniswap ${variant.version} position read failed on chain ${variant.chainId}`));
        }
      }
      signal.throwIfAborted();
      const scanStatus = failures.length > 0 ? 'error' : discovery.caughtUp ? 'ok' : 'warming_up';
      await this.metricPipeline.ingest(metric(
        monitor.monitorId,
        target,
        'scan_status',
        failures.length === 0,
        timestamp,
        { status: scanStatus, labels: baseLabels },
      ));
      await this.metricPipeline.ingest(metric(
        monitor.monitorId,
        target,
        'position_count',
        String(positions.length),
        timestamp,
        { status: scanStatus, unit: 'positions', labels: baseLabels },
      ));
      await this.metricPipeline.ingest(metric(
        monitor.monitorId,
        target,
        'discovery_caught_up',
        discovery.caughtUp,
        timestamp,
        { status: discovery.caughtUp ? 'ok' : 'warming_up', labels: baseLabels },
      ));
      if (discovery.scannedThroughBlock !== undefined) {
        await this.metricPipeline.ingest(metric(
          monitor.monitorId,
          target,
          'discovery_scanned_block',
          discovery.scannedThroughBlock.toString(),
          timestamp,
          { status: discovery.caughtUp ? 'ok' : 'warming_up', unit: 'block', labels: baseLabels },
        ));
      }
      if (discovery.chainTipBlock !== undefined) {
        await this.metricPipeline.ingest(metric(
          monitor.monitorId,
          target,
          'discovery_chain_tip_block',
          discovery.chainTipBlock.toString(),
          timestamp,
          { status: discovery.caughtUp ? 'ok' : 'warming_up', unit: 'block', labels: baseLabels },
        ));
      }
      for (const position of positions) await this.emitPosition(monitor.monitorId, position, timestamp, baseLabels);
      for (const tokenId of failures) {
        await this.metricPipeline.ingest(metric(
          monitor.monitorId,
          tokenId,
          'read_status',
          false,
          timestamp,
          { status: 'error', labels: { ...baseLabels, tokenId } },
        ));
      }
    } catch {
      if (signal.aborted) return;
      this.onError(new Error(`Uniswap ${variant.version} scan failed on chain ${variant.chainId}`));
      const previousLabels = this.metricPipeline.list(monitor.monitorId)
        .find((candidate) => candidate.source === 'uniswap' && candidate.name === 'scan_status')
        ?.labels;
      await this.metricPipeline.ingest(metric(
        monitor.monitorId,
        target,
        'scan_status',
        false,
        timestamp,
        { status: 'error', labels: { ...previousLabels, ...baseLabels } },
      ));
    }
  }

  private async discover(
    monitor: UniswapMonitor,
    variant: UniswapVariant,
    rpcUrl: string,
    headers: Record<string, string>,
    timeoutMilliseconds: number,
    signal: AbortSignal,
  ): Promise<{
    tokenIds: string[];
    blockNumber?: bigint;
    scannedThroughBlock?: bigint;
    chainTipBlock?: bigint;
    caughtUp: boolean;
  }> {
    if ('tokenId' in monitor) return { tokenIds: [monitor.tokenId], caughtUp: true };
    const walletAddress = getAddress(monitor.walletAddress);
    if (variant.version === 'v3') {
      const result = await this.readerFactory.create({
        rpcUrl,
        headers,
        expectedChainId: variant.chainId,
        timeoutMilliseconds,
      }).discover(walletAddress, signal);
      return { tokenIds: result.tokenIds, blockNumber: result.blockNumber, caughtUp: true };
    }
    const result = await this.v4OwnershipIndexerFactory.create({
      rpcUrl,
      headers,
      expectedChainId: variant.chainId,
      integrationId: monitor.rpcIntegrationId,
      timeoutMilliseconds,
    }).sync(walletAddress, signal);
    return {
      tokenIds: result.tokenIds,
      blockNumber: result.scannedThroughBlock,
      scannedThroughBlock: result.scannedThroughBlock,
      chainTipBlock: result.chainTipBlock,
      caughtUp: result.caughtUp,
    };
  }

  private async readPosition(
    version: 'v3' | 'v4',
    tokenId: string,
    rpcUrl: string,
    headers: Record<string, string>,
    chainId: number,
    timeoutMilliseconds: number,
    signal: AbortSignal,
    blockNumber?: bigint,
  ): Promise<UniswapPosition> {
    const options = { rpcUrl, headers, expectedChainId: chainId, timeoutMilliseconds };
    return version === 'v3'
      ? this.readerFactory.create(options).read(tokenId, signal, blockNumber)
      : this.v4ReaderFactory.create(options).read(tokenId, signal, blockNumber);
  }

  private async emitPosition(
    monitorId: string,
    position: UniswapPosition,
    timestamp: string,
    monitorLabels: Record<string, string>,
  ): Promise<void> {
    const labels = {
      ...monitorLabels,
      tokenId: position.tokenId,
      token0Address: position.token0.address,
      token0Symbol: position.token0.symbol,
      token0Decimals: String(position.token0.decimals),
      token0Native: String('native' in position.token0 && position.token0.native),
      token1Address: position.token1.address,
      token1Symbol: position.token1.symbol,
      token1Decimals: String(position.token1.decimals),
      token1Native: String('native' in position.token1 && position.token1.native),
    };
    const values: Array<[string, string | boolean, string]> = [
      ['read_status', true, 'boolean'],
      ['position_owner', position.owner, 'address'],
      ['position_manager_address', position.positionManagerAddress, 'address'],
      ['block_number', position.blockNumber, 'block'],
      ['fee_tier', String(position.feeTier), 'hundredths_bps'],
      ['tick_lower', String(position.tickLower), 'tick'],
      ['tick_upper', String(position.tickUpper), 'tick'],
      ['current_tick', String(position.currentTick), 'tick'],
      ['liquidity', position.liquidity, 'liquidity'],
      ['in_range', position.inRange, 'boolean'],
    ];
    if (position.version === 'v3') {
      values.push(
        ['pool_address', position.poolAddress, 'address'],
        ['tokens_owed0', position.tokensOwed0, position.token0.symbol],
        ['tokens_owed1', position.tokensOwed1, position.token1.symbol],
      );
    } else {
      values.push(
        ['pool_id', position.poolId, 'bytes32'],
        ['pool_manager_address', position.poolManagerAddress, 'address'],
        ['state_view_address', position.stateViewAddress, 'address'],
        ['lp_fee', String(position.lpFee), 'hundredths_bps'],
        ['protocol_fee', String(position.protocolFee), 'hundredths_bps'],
        ['tick_spacing', String(position.tickSpacing), 'tick'],
        ['hooks_address', position.hooks, 'address'],
      );
    }
    for (const [name, value, unit] of values) {
      await this.metricPipeline.ingest(metric(monitorId, position.tokenId, name, value, timestamp, {
        status: 'ok', unit, labels,
      }));
    }
  }

  private async checkStale(monitor: UniswapMonitor, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const latestSuccessful = this.metricPipeline.list(monitor.monitorId)
      .filter((candidate) => candidate.source === 'uniswap' && candidate.status === 'ok')
      .reduce<Metric | undefined>((latest, candidate) => (
        latest === undefined || Date.parse(candidate.observedAt) > Date.parse(latest.observedAt) ? candidate : latest
      ), undefined);
    if (latestSuccessful === undefined) return;
    const ageSeconds = Math.max(0, (this.now().getTime() - Date.parse(latestSuccessful.observedAt)) / 1_000);
    if (ageSeconds <= monitor.maxStaleSeconds) return;
    const timestamp = this.now().toISOString();
    const target = 'walletAddress' in monitor ? monitor.walletAddress : monitor.tokenId;
    await this.metricPipeline.ingest(metric(
      monitor.monitorId,
      target,
      'data_age_seconds',
      String(ageSeconds),
      timestamp,
      { status: 'stale', unit: 'seconds' },
    ));
  }
}
