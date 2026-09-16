import { UniswapPoolCatalogReader } from '../../adapters/uniswap/uniswap-pool-catalog-reader.js';
import type { UniswapPoolCatalogReaderOptions } from '../../adapters/uniswap/uniswap-pool-catalog-reader.js';
import { supportedUniswapV3Deployments } from '../../adapters/uniswap/uniswap-v3-position-reader.js';
import { supportedUniswapV4Deployments } from '../../adapters/uniswap/uniswap-v4-position-reader.js';
import { rpcIntegrationConfigSchema } from '../../api/schemas.js';
import type { ChainScanCursorRepository } from '../../db/repositories/chain-scan-cursor-repository.js';
import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import type { IntegrationNetworkHealthRepository } from '../../db/repositories/integration-network-health-repository.js';
import type { UniswapPoolRepository } from '../../db/repositories/uniswap-pool-repository.js';
import type { PollingScheduler } from '../scheduling/polling-scheduler.js';
import { isEvmRpcProvider } from './integration-catalog.js';
import { resolveEvmRpcRequest } from './evm-rpc-config.js';

export interface UniswapPoolCatalogReaderPort {
  latestBlock(signal?: AbortSignal): Promise<bigint>;
  scan(version: 'v3' | 'v4', fromBlock: bigint, toBlock: bigint, signal?: AbortSignal): ReturnType<UniswapPoolCatalogReader['scan']>;
}

export interface UniswapPoolCatalogReaderFactory {
  create(options: UniswapPoolCatalogReaderOptions): UniswapPoolCatalogReaderPort;
}

export class UniswapPoolIndexCoordinator {
  private readonly taskIds = new Set<string>();
  private readonly readerFactory: UniswapPoolCatalogReaderFactory;
  private readonly confirmationBlocks: bigint;
  private readonly reorgRewindBlocks: bigint;
  private readonly initialBlockChunkSize: bigint;
  private readonly maximumBlockChunkSize: bigint;
  private readonly minimumBlockChunkSize: bigint;
  private readonly maximumChunksPerRun: number;
  private readonly now: () => Date;

  public constructor(
    private readonly integrations: IntegrationRepository,
    private readonly networkHealth: IntegrationNetworkHealthRepository,
    private readonly pools: UniswapPoolRepository,
    private readonly cursors: ChainScanCursorRepository,
    private readonly scheduler: PollingScheduler,
    options: {
      fetch?: typeof globalThis.fetch; readerFactory?: UniswapPoolCatalogReaderFactory; onError?: (error: Error) => void;
      confirmationBlocks?: bigint; reorgRewindBlocks?: bigint; initialBlockChunkSize?: bigint;
      maximumBlockChunkSize?: bigint; minimumBlockChunkSize?: bigint; maximumChunksPerRun?: number; now?: () => Date;
    } = {},
  ) {
    this.readerFactory = options.readerFactory ?? { create: (readerOptions) => new UniswapPoolCatalogReader({
      ...readerOptions, ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }) };
    this.onError = options.onError ?? (() => undefined);
    this.confirmationBlocks = options.confirmationBlocks ?? 12n;
    this.reorgRewindBlocks = options.reorgRewindBlocks ?? 12n;
    this.initialBlockChunkSize = options.initialBlockChunkSize ?? 100_000n;
    this.maximumBlockChunkSize = options.maximumBlockChunkSize ?? 100_000n;
    this.minimumBlockChunkSize = options.minimumBlockChunkSize ?? 1n;
    this.maximumChunksPerRun = options.maximumChunksPerRun ?? 4;
    this.now = options.now ?? (() => new Date());
  }

  private readonly onError: (error: Error) => void;

  public reconcile(): void {
    const desired = new Set<string>();
    for (const integration of this.integrations.listRuntime()) {
      if (!integration.enabled || integration.type !== 'evm_rpc' || !isEvmRpcProvider(integration.provider)) continue;
      const config = rpcIntegrationConfigSchema.safeParse(integration.config);
      if (!config.success) continue;
      for (const chainId of config.data.chainIds.filter((id) => id === 1 || id === 4_663)) {
        for (const version of ['v3', 'v4'] as const) {
          const health = this.networkHealth.list().find((item) => item.integrationId === integration.id && item.chainId === chainId);
          if (health?.rpcStatus !== 'ok' || (version === 'v3' ? health.uniswapV3Status : health.uniswapV4Status) !== 'ok') continue;
          const id = this.taskId(integration.id, chainId, version);
          desired.add(id);
          this.scheduler.upsert({
            id, intervalMilliseconds: 20_000,
            run: async (signal) => this.sync(integration.id, chainId, version, signal),
          });
        }
      }
    }
    for (const id of this.taskIds) if (!desired.has(id)) this.scheduler.remove(id);
    this.taskIds.clear();
    for (const id of desired) this.taskIds.add(id);
  }

  public close(): void {
    for (const id of this.taskIds) this.scheduler.remove(id);
    this.taskIds.clear();
  }

  private taskId(integrationId: string, chainId: number, version: 'v3' | 'v4'): string {
    return `uniswap-pools:${integrationId}:${chainId}:${version}`;
  }

  private async sync(integrationId: string, chainId: number, version: 'v3' | 'v4', signal: AbortSignal): Promise<void> {
    try {
      const integration = this.integrations.getRuntime(integrationId);
      const config = rpcIntegrationConfigSchema.parse(integration.config);
      const resolved = resolveEvmRpcRequest(config, chainId);
      const reader = this.readerFactory.create({
        rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: chainId,
        timeoutMilliseconds: config.timeoutMilliseconds,
      });
      const deploymentBlock = version === 'v3'
        ? supportedUniswapV3Deployments.get(chainId)?.deploymentBlock
        : supportedUniswapV4Deployments.get(chainId)?.deploymentBlock;
      if (deploymentBlock === undefined) return;
      const latest = await reader.latestBlock(signal);
      const confirmed = latest > this.confirmationBlocks ? latest - this.confirmationBlocks : 0n;
      const key = `pools:${version}`;
      const saved = this.cursors.get(integrationId, 'uniswap', chainId, key);
      let highWater = saved;
      let from = saved === undefined ? deploymentBlock
        : (saved >= this.reorgRewindBlocks ? saved - this.reorgRewindBlocks + 1n : deploymentBlock);
      if (from < deploymentBlock) from = deploymentBlock;
      const storedState = this.pools.getIndexerState(integrationId, chainId, version);
      let chunkSize = storedState === undefined ? this.initialBlockChunkSize : BigInt(storedState.chunkSize);
      if (chunkSize > this.maximumBlockChunkSize) chunkSize = this.maximumBlockChunkSize;
      if (chunkSize < this.minimumBlockChunkSize) chunkSize = this.minimumBlockChunkSize;
      let chunks = 0;
      this.pools.saveIndexerState({ integrationId, chainId, version, status: 'running', lastErrorCode: null,
        lastAttemptAt: this.now().toISOString(), chunkSize });
      while (from <= confirmed && chunks < this.maximumChunksPerRun) {
        signal.throwIfAborted();
        const to = from + chunkSize - 1n < confirmed ? from + chunkSize - 1n : confirmed;
        await this.scanAdaptive(reader, integrationId, chainId, version, key, from, to, signal, (completed) => {
          if (highWater === undefined || completed > highWater) highWater = completed;
        });
        from = to + 1n;
        chunks += 1;
        chunkSize = chunkSize * 2n > this.maximumBlockChunkSize ? this.maximumBlockChunkSize : chunkSize * 2n;
      }
      this.pools.saveIndexerState({
        integrationId, chainId, version, status: highWater !== undefined && highWater >= confirmed ? 'ok' : 'running',
        lastErrorCode: null, lastAttemptAt: this.now().toISOString(), chunkSize,
      });
    } catch {
      if (!signal.aborted) {
        const previous = this.pools.getIndexerState(integrationId, chainId, version);
        const previousChunk = previous === undefined ? this.initialBlockChunkSize : BigInt(previous.chunkSize);
        const reduced = previousChunk / 2n < this.minimumBlockChunkSize ? this.minimumBlockChunkSize : previousChunk / 2n;
        this.pools.saveIndexerState({
          integrationId, chainId, version, status: 'error', lastErrorCode: 'INDEXER_PARTIAL_FAILURE',
          lastAttemptAt: this.now().toISOString(), chunkSize: reduced,
        });
        this.onError(new Error(`Uniswap ${version} pool index failed on chain ${chainId}`));
      }
    }
  }

  private async scanAdaptive(
    reader: UniswapPoolCatalogReaderPort,
    integrationId: string,
    chainId: number,
    version: 'v3' | 'v4',
    cursorKey: string,
    from: bigint,
    to: bigint,
    signal: AbortSignal,
    onProgress: (block: bigint) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    try {
      const items = await reader.scan(version, from, to, signal);
      signal.throwIfAborted();
      for (const item of items) this.savePool(integrationId, chainId, version, item);
      const current = this.cursors.get(integrationId, 'uniswap', chainId, cursorKey);
      const completed = current === undefined || to > current ? to : current;
      this.cursors.save(integrationId, 'uniswap', chainId, cursorKey, completed);
      onProgress(completed);
    } catch (error) {
      signal.throwIfAborted();
      const size = to - from + 1n;
      if (size <= this.minimumBlockChunkSize) throw error;
      const middle = from + (to - from) / 2n;
      await this.scanAdaptive(reader, integrationId, chainId, version, cursorKey, from, middle, signal, onProgress);
      await this.scanAdaptive(reader, integrationId, chainId, version, cursorKey, middle + 1n, to, signal, onProgress);
    }
  }

  private savePool(
    integrationId: string,
    chainId: number,
    version: 'v3' | 'v4',
    item: Awaited<ReturnType<UniswapPoolCatalogReaderPort['scan']>>[number],
  ): void {
    this.pools.saveTokenMetadata(chainId, item.token0.address, {
      symbol: item.token0.symbol, decimals: item.token0.decimals, status: item.token0.status,
    });
    this.pools.saveTokenMetadata(chainId, item.token1.address, {
      symbol: item.token1.symbol, decimals: item.token1.decimals, status: item.token1.status,
    });
    this.pools.upsert({
      integrationId, chainId, version, resourceId: item.resourceId.toLowerCase(),
      poolAddress: item.poolAddress?.toLowerCase() ?? null, poolId: item.poolId?.toLowerCase() ?? null,
      token0Address: item.token0.address.toLowerCase(), token0Symbol: item.token0.symbol,
      token0Decimals: item.token0.decimals, token0Native: item.token0.native,
      token1Address: item.token1.address.toLowerCase(), token1Symbol: item.token1.symbol,
      token1Decimals: item.token1.decimals, token1Native: item.token1.native,
      feeTier: item.feeTier, tickSpacing: item.tickSpacing,
      hooksAddress: item.hooksAddress?.toLowerCase() ?? null,
      discoveredAtBlock: item.discoveredAtBlock, updatedAt: this.now().toISOString(),
    });
  }
}
