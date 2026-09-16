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

  public constructor(
    private readonly integrations: IntegrationRepository,
    private readonly networkHealth: IntegrationNetworkHealthRepository,
    private readonly pools: UniswapPoolRepository,
    private readonly cursors: ChainScanCursorRepository,
    private readonly scheduler: PollingScheduler,
    options: { fetch?: typeof globalThis.fetch; readerFactory?: UniswapPoolCatalogReaderFactory; onError?: (error: Error) => void } = {},
  ) {
    this.readerFactory = options.readerFactory ?? { create: (readerOptions) => new UniswapPoolCatalogReader({
      ...readerOptions, ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }) };
    this.onError = options.onError ?? (() => undefined);
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
      const confirmed = latest > 12n ? latest - 12n : 0n;
      const key = `pools:${version}`;
      const saved = this.cursors.get(integrationId, 'uniswap', chainId, key);
      let from = saved === undefined ? deploymentBlock : (saved > 12n ? saved - 11n : deploymentBlock);
      let chunks = 0;
      while (from <= confirmed && chunks < 4) {
        const to = from + 99_999n < confirmed ? from + 99_999n : confirmed;
        const items = await reader.scan(version, from, to, signal);
        for (const item of items) {
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
            discoveredAtBlock: item.discoveredAtBlock, updatedAt: new Date().toISOString(),
          });
        }
        this.cursors.save(integrationId, 'uniswap', chainId, key, to);
        from = to + 1n;
        chunks += 1;
      }
    } catch {
      if (!signal.aborted) this.onError(new Error(`Uniswap ${version} pool index failed on chain ${chainId}`));
    }
  }
}
