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
import { Decimal } from 'decimal.js';
import { supportedUniswapV3Deployments } from '../../adapters/uniswap/uniswap-v3-position-reader.js';
import { supportedUniswapV4Deployments } from '../../adapters/uniswap/uniswap-v4-position-reader.js';

type UniswapPosition = UniswapV3Position | UniswapV4Position;
type UniswapMonitor = ReturnType<MonitorRepository['listEnabledUniswapMonitors']>[number];
type UniswapVariant = UniswapMonitor['variants'][number];
const DEFAULT_CLOSED_POSITION_REFRESH_MILLISECONDS = 15 * 60 * 1_000;

export interface UniswapV3PositionReaderPort {
  discover(walletAddress: Address, signal?: AbortSignal): Promise<UniswapV3OwnedPositions>;
  read(tokenId: string, signal?: AbortSignal, blockNumber?: bigint): Promise<UniswapV3Position>;
}

export interface UniswapV3PositionReaderFactory {
  create(options: {
    rpcUrl: string;
    headers?: Record<string, string>;
    expectedChainId: number;
    timeoutMilliseconds: number;
    multicallBatchSizeBytes?: number;
  }): UniswapV3PositionReaderPort;
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
  closedPositionRefreshMilliseconds?: number;
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
  private readonly monitorVariantFingerprints = new Map<string, string>();
  private readonly v3Readers = new Map<string, UniswapV3PositionReaderPort>();
  private readonly v4Readers = new Map<string, UniswapV4PositionReaderPort>();
  private readonly v4OwnershipIndexers = new Map<string, UniswapV4OwnershipIndexerPort>();
  private readonly closedPositions = new Map<string, { position: UniswapPosition; refreshAt: number }>();
  private readonly readerFactory: UniswapV3PositionReaderFactory;
  private readonly v4ReaderFactory: UniswapV4PositionReaderFactory;
  private readonly v4OwnershipIndexerFactory: UniswapV4OwnershipIndexerFactory;
  private readonly now: () => Date;
  private readonly closedPositionRefreshMilliseconds: number;
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
    this.closedPositionRefreshMilliseconds = options.closedPositionRefreshMilliseconds
      ?? DEFAULT_CLOSED_POSITION_REFRESH_MILLISECONDS;
    this.onError = options.onError ?? (() => undefined);
  }

  public reconcile(): void {
    const monitors = this.monitors.listEnabledUniswapMonitors();
    const desiredIds = new Set(monitors.map(({ monitorId }) => monitorId));
    for (const monitorId of this.scheduledMonitorIds) {
      if (desiredIds.has(monitorId)) continue;
      this.scheduler.remove(this.taskId(monitorId));
      this.scheduler.remove(this.staleTaskId(monitorId));
      this.clearClosedPositions(monitorId);
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
    this.monitorVariantFingerprints.clear();
    this.closedPositions.clear();
    this.v3Readers.clear();
    this.v4Readers.clear();
    this.v4OwnershipIndexers.clear();
  }

  private taskId(monitorId: string): string {
    return `uniswap:${monitorId}`;
  }

  private staleTaskId(monitorId: string): string {
    return `uniswap-stale:${monitorId}`;
  }

  private closedPositionKey(monitorId: string, variant: UniswapVariant, tokenId: string): string {
    return `${monitorId}:${variant.chainId}:${variant.version}:${tokenId}`;
  }

  private clearClosedPositions(monitorId: string): void {
    const prefix = `${monitorId}:`;
    for (const key of this.closedPositions.keys()) {
      if (key.startsWith(prefix)) this.closedPositions.delete(key);
    }
  }

  private async scan(monitor: UniswapMonitor, signal: AbortSignal): Promise<void> {
    // Keep the last complete gauge snapshot available while the next RPC scan is in flight.
    // Clearing here made every HTTP snapshot observe an empty/partial intermediate state.
    const fingerprint = JSON.stringify({
      rpcIntegrationId: monitor.rpcIntegrationId,
      variants: monitor.variants,
      ...('walletAddress' in monitor ? { walletAddress: monitor.walletAddress } : { tokenId: monitor.tokenId }),
    });
    if (this.monitorVariantFingerprints.get(monitor.monitorId) !== fingerprint) {
      this.metricPipeline.forgetMonitor(monitor.monitorId);
      this.clearClosedPositions(monitor.monitorId);
      this.monitorVariantFingerprints.set(monitor.monitorId, fingerprint);
    }
    await Promise.all(monitor.variants.map(async (variant) => this.scanVariant(monitor, variant, signal)));
  }

  private async scanVariant(monitor: UniswapMonitor, variant: UniswapVariant, signal: AbortSignal): Promise<void> {
    const timestamp = this.now().toISOString();
    const target = 'walletAddress' in monitor ? monitor.walletAddress : monitor.tokenId;
    const baseLabels = {
      chainId: String(variant.chainId),
      chainName: (variant.version === 'v3'
        ? supportedUniswapV3Deployments.get(variant.chainId)?.chainName
        : supportedUniswapV4Deployments.get(variant.chainId)?.chainName) ?? `Chain ${variant.chainId}`,
      protocol: 'uniswap',
      version: variant.version,
      ...('walletAddress' in monitor ? { walletAddress: getAddress(monitor.walletAddress) } : {}),
    };
    try {
      const integration = this.integrations.getRuntime(monitor.rpcIntegrationId);
      const rpc = rpcIntegrationConfigSchema.parse(integration.config);
      if (!integration.enabled || integration.type !== 'evm_rpc') throw new Error('Configured RPC integration is unavailable');
      const resolved = resolveEvmRpcRequest(rpc, variant.chainId);
      const cacheKey = this.readerCacheKey(monitor.rpcIntegrationId, variant.chainId, variant.version,
        resolved.rpcUrl, resolved.headers, rpc.timeoutMilliseconds);
      const v3Reader = variant.version === 'v3' ? this.getV3Reader(cacheKey, {
        rpcUrl: resolved.rpcUrl,
        headers: resolved.headers,
        expectedChainId: variant.chainId,
        timeoutMilliseconds: rpc.timeoutMilliseconds,
        multicallBatchSizeBytes: rpc.multicallBatchSizeBytes,
      }) : undefined;
      const v4Reader = variant.version === 'v4' ? this.getV4Reader(cacheKey, {
        rpcUrl: resolved.rpcUrl,
        headers: resolved.headers,
        expectedChainId: variant.chainId,
        timeoutMilliseconds: rpc.timeoutMilliseconds,
      }) : undefined;
      const ownershipIndexer = variant.version === 'v4' ? this.getV4OwnershipIndexer(cacheKey, {
        rpcUrl: resolved.rpcUrl,
        headers: resolved.headers,
        expectedChainId: variant.chainId,
        integrationId: monitor.rpcIntegrationId,
        timeoutMilliseconds: rpc.timeoutMilliseconds,
      }) : undefined;

      const discovery = await this.discover(monitor, variant, signal, v3Reader, ownershipIndexer);
      const positions: UniswapPosition[] = [];
      const failures: string[] = [];
      for (const tokenId of discovery.tokenIds) {
        signal.throwIfAborted();
        try {
          const closedCacheKey = this.closedPositionKey(monitor.monitorId, variant, tokenId);
          const cachedClosed = this.closedPositions.get(closedCacheKey);
          const position = cachedClosed !== undefined && cachedClosed.refreshAt > this.now().getTime()
            ? cachedClosed.position
            : await this.readPosition(variant.version, tokenId, signal, discovery.blockNumber, v3Reader, v4Reader);
          if (new Decimal(position.liquidity).isZero()) {
            this.closedPositions.set(closedCacheKey, {
              position,
              refreshAt: this.now().getTime() + Math.max(0, this.closedPositionRefreshMilliseconds),
            });
          } else {
            this.closedPositions.delete(closedCacheKey);
          }
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
      if ('walletAddress' in monitor) {
        const valuations = positions.map((position) => {
          const amounts = this.positionAmounts(position);
          return this.positionValuation(position, amounts);
        });
        const valuedPositions = valuations.filter((valuation) => valuation !== null);
        const valuedFees = valuedPositions.filter((valuation) => valuation.feesValueUsd !== null);
        const aggregationLabels = {
          ...baseLabels,
          valuationCoverage: valuedPositions.length === 0 ? 'unavailable'
            : valuedPositions.length === positions.length ? 'full' : 'partial',
        };
        await this.metricPipeline.ingest(metric(
          monitor.monitorId, target, 'in_range_count', String(positions.filter((position) => position.inRange).length), timestamp,
          { status: scanStatus, unit: 'positions', labels: baseLabels },
        ));
        await this.metricPipeline.ingest(metric(
          monitor.monitorId, target, 'out_of_range_count',
          String(positions.filter((position) => !position.inRange && !new Decimal(position.liquidity).isZero()).length), timestamp,
          { status: scanStatus, unit: 'positions', labels: baseLabels },
        ));
        await this.metricPipeline.ingest(metric(
          monitor.monitorId, target, 'failed_position_count', String(failures.length), timestamp,
          { status: scanStatus, unit: 'positions', labels: baseLabels },
        ));
        if (valuedPositions.length > 0) {
          await this.metricPipeline.ingest(metric(
            monitor.monitorId, target, 'aggregate_value_usd',
            Decimal.sum(...valuedPositions.map((valuation) => valuation.positionValueUsd)).toSignificantDigits(30).toString(), timestamp,
            { status: scanStatus, unit: 'USD', labels: aggregationLabels },
          ));
        }
        if (valuedFees.length > 0) {
          await this.metricPipeline.ingest(metric(
            monitor.monitorId, target, 'aggregate_fees_usd',
            Decimal.sum(...valuedFees.map((valuation) => valuation.feesValueUsd as string)).toSignificantDigits(30).toString(), timestamp,
            { status: scanStatus, unit: 'USD', labels: aggregationLabels },
          ));
        }
      }
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
          'read_error',
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
    signal: AbortSignal,
    v3Reader?: UniswapV3PositionReaderPort,
    ownershipIndexer?: UniswapV4OwnershipIndexerPort,
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
      if (v3Reader === undefined) throw new Error('Uniswap V3 reader is unavailable');
      const result = await v3Reader.discover(walletAddress, signal);
      return { tokenIds: result.tokenIds, blockNumber: result.blockNumber, caughtUp: true };
    }
    if (ownershipIndexer === undefined) throw new Error('Uniswap V4 ownership indexer is unavailable');
    const result = await ownershipIndexer.sync(walletAddress, signal);
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
    signal: AbortSignal,
    blockNumber?: bigint,
    v3Reader?: UniswapV3PositionReaderPort,
    v4Reader?: UniswapV4PositionReaderPort,
  ): Promise<UniswapPosition> {
    if (version === 'v3') {
      if (v3Reader === undefined) throw new Error('Uniswap V3 reader is unavailable');
      return v3Reader.read(tokenId, signal, blockNumber);
    }
    if (v4Reader === undefined) throw new Error('Uniswap V4 reader is unavailable');
    return v4Reader.read(tokenId, signal, blockNumber);
  }

  private readerCacheKey(
    integrationId: string,
    chainId: number,
    version: 'v3' | 'v4',
    rpcUrl: string,
    headers: Record<string, string>,
    timeoutMilliseconds: number,
  ): string {
    const headerFingerprint = Object.entries(headers).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}:${value}`).join('|');
    return `${integrationId}:${chainId}:${version}:${timeoutMilliseconds}:${rpcUrl}:${headerFingerprint}`;
  }

  private getV3Reader(key: string, options: {
    rpcUrl: string;
    headers: Record<string, string>;
    expectedChainId: number;
    timeoutMilliseconds: number;
    multicallBatchSizeBytes: number;
  }): UniswapV3PositionReaderPort {
    const existing = this.v3Readers.get(key);
    if (existing !== undefined) return existing;
    const created = this.readerFactory.create(options);
    this.v3Readers.set(key, created);
    return created;
  }

  private getV4Reader(key: string, options: {
    rpcUrl: string; headers: Record<string, string>; expectedChainId: number; timeoutMilliseconds: number;
  }): UniswapV4PositionReaderPort {
    const existing = this.v4Readers.get(key);
    if (existing !== undefined) return existing;
    const created = this.v4ReaderFactory.create(options);
    this.v4Readers.set(key, created);
    return created;
  }

  private getV4OwnershipIndexer(key: string, options: {
    rpcUrl: string; headers: Record<string, string>; expectedChainId: number; integrationId: string; timeoutMilliseconds: number;
  }): UniswapV4OwnershipIndexerPort {
    const existing = this.v4OwnershipIndexers.get(key);
    if (existing !== undefined) return existing;
    const created = this.v4OwnershipIndexerFactory.create(options);
    this.v4OwnershipIndexers.set(key, created);
    return created;
  }

  private async emitPosition(
    monitorId: string,
    position: UniswapPosition,
    timestamp: string,
    monitorLabels: Record<string, string>,
  ): Promise<void> {
    const currentPrice = new Decimal('1.0001').pow(position.currentTick);
    const lowerPrice = new Decimal('1.0001').pow(position.tickLower);
    const upperPrice = new Decimal('1.0001').pow(position.tickUpper);
    const lowerDistancePercent = currentPrice.minus(lowerPrice).abs().div(currentPrice).mul(100);
    const upperDistancePercent = upperPrice.minus(currentPrice).abs().div(currentPrice).mul(100);
    const labels: Record<string, string> = {
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
      ['read_error', true, 'boolean'],
      ['position_owner', position.owner, 'address'],
      ['position_manager_address', position.positionManagerAddress, 'address'],
      ['block_number', position.blockNumber, 'block'],
      ['fee_tier', String(position.feeTier), 'hundredths_bps'],
      ['tick_lower', String(position.tickLower), 'tick'],
      ['tick_upper', String(position.tickUpper), 'tick'],
      ['current_tick', String(position.currentTick), 'tick'],
      ['liquidity', position.liquidity, 'liquidity'],
      ['in_range', position.inRange, 'boolean'],
      ['distance_to_lower_tick', String(position.currentTick - position.tickLower), 'tick'],
      ['distance_to_upper_tick', String(position.tickUpper - position.currentTick), 'tick'],
      ['distance_to_nearest_boundary_percent', Decimal.min(lowerDistancePercent, upperDistancePercent)
        .toSignificantDigits(30).toString(), 'percent'],
      ['position_closed', new Decimal(position.liquidity).isZero(), 'boolean'],
    ];
    const amounts = this.positionAmounts(position);
    values.push(
      ['token0_amount', amounts.token0, position.token0.symbol],
      ['token1_amount', amounts.token1, position.token1.symbol],
    );
    const valuation = this.positionValuation(position, amounts);
    if (valuation !== null) {
      values.push(['position_value_usd', valuation.positionValueUsd, 'USD']);
      if (valuation.feesValueUsd !== null) values.push(['fees_value_usd', valuation.feesValueUsd, 'USD']);
      labels.valuationStatus = 'ok';
      labels.valuationSource = 'onchain_stablecoin_pool';
      labels.valuationObservedAt = timestamp;
    } else {
      labels.valuationStatus = 'unavailable';
    }
    if (position.version === 'v3') {
      values.push(
        ['pool_address', position.poolAddress, 'address'],
        ['tokens_owed0', position.tokensOwed0, position.token0.symbol],
        ['tokens_owed1', position.tokensOwed1, position.token1.symbol],
        ['fees_owed_token0', position.tokensOwed0, position.token0.symbol],
        ['fees_owed_token1', position.tokensOwed1, position.token1.symbol],
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

  private positionAmounts(position: UniswapPosition): { token0: string; token1: string } {
    const liquidity = new Decimal(position.liquidity);
    const sqrtLower = new Decimal('1.0001').pow(new Decimal(position.tickLower).div(2));
    const sqrtUpper = new Decimal('1.0001').pow(new Decimal(position.tickUpper).div(2));
    const sqrtCurrent = new Decimal('1.0001').pow(new Decimal(position.currentTick).div(2));
    let raw0: Decimal;
    let raw1: Decimal;
    if (position.currentTick <= position.tickLower) {
      raw0 = liquidity.mul(sqrtUpper.minus(sqrtLower)).div(sqrtLower.mul(sqrtUpper));
      raw1 = new Decimal(0);
    } else if (position.currentTick >= position.tickUpper) {
      raw0 = new Decimal(0);
      raw1 = liquidity.mul(sqrtUpper.minus(sqrtLower));
    } else {
      raw0 = liquidity.mul(sqrtUpper.minus(sqrtCurrent)).div(sqrtCurrent.mul(sqrtUpper));
      raw1 = liquidity.mul(sqrtCurrent.minus(sqrtLower));
    }
    return {
      token0: raw0.div(new Decimal(10).pow(position.token0.decimals)).toSignificantDigits(30).toString(),
      token1: raw1.div(new Decimal(10).pow(position.token1.decimals)).toSignificantDigits(30).toString(),
    };
  }

  private positionValuation(
    position: UniswapPosition,
    amounts: { token0: string; token1: string },
  ): { positionValueUsd: string; feesValueUsd: string | null } | null {
    const stable = new Set(['USDC', 'USDT', 'DAI', 'USDS']);
    const ratio = new Decimal('1.0001').pow(position.currentTick)
      .mul(new Decimal(10).pow(position.token0.decimals - position.token1.decimals));
    let price0: Decimal;
    let price1: Decimal;
    if (stable.has(position.token1.symbol.toUpperCase())) {
      price0 = ratio; price1 = new Decimal(1);
    } else if (stable.has(position.token0.symbol.toUpperCase()) && !ratio.isZero()) {
      price0 = new Decimal(1); price1 = new Decimal(1).div(ratio);
    } else return null;
    const positionValueUsd = new Decimal(amounts.token0).mul(price0)
      .plus(new Decimal(amounts.token1).mul(price1)).toSignificantDigits(30).toString();
    if (position.version !== 'v3') return { positionValueUsd, feesValueUsd: null };
    const feesValueUsd = new Decimal(position.tokensOwed0).mul(price0)
      .plus(new Decimal(position.tokensOwed1).mul(price1)).toSignificantDigits(30).toString();
    return { positionValueUsd, feesValueUsd };
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
