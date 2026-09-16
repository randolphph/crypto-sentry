import { BinanceRestClient, BinanceRestError } from '../../adapters/markets/binance/binance-rest-client.js';
import { EvmChainMismatchError, EvmRpcClient } from '../../adapters/evm/evm-rpc-client.js';
import {
  createNodeMarketWebSocket,
  testWebSocketConnectivity,
} from '../../adapters/markets/websocket/websocket-port.js';
import type { MarketWebSocketFactory } from '../../adapters/markets/websocket/websocket-port.js';
import { AppError } from '../../api/errors.js';
import { binanceIntegrationConfigSchema, rpcIntegrationConfigSchema } from '../../api/schemas.js';
import { resolveEvmRpcRequest } from './evm-rpc-config.js';
import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import type { MarketRepository } from '../../db/repositories/market-repository.js';
import type { IntegrationNetworkHealthRepository } from '../../db/repositories/integration-network-health-repository.js';
import type { UniswapPoolRepository } from '../../db/repositories/uniswap-pool-repository.js';
import type { ChainScanCursorRepository } from '../../db/repositories/chain-scan-cursor-repository.js';
import type { UniswapV4OwnershipRepository } from '../../db/repositories/uniswap-v4-ownership-repository.js';
import { UniswapV3PositionReader } from '../../adapters/uniswap/uniswap-v3-position-reader.js';
import { UniswapV4PositionReader } from '../../adapters/uniswap/uniswap-v4-position-reader.js';
import { UniswapV4OwnershipIndexer } from '../../adapters/uniswap/uniswap-v4-ownership-indexer.js';
import { getAddress } from 'viem';
import { AaveV3PositionReader } from '../../adapters/aave/aave-v3-position-reader.js';
import { AaveV3ReserveCatalogReader } from '../../adapters/aave/aave-v3-reserve-catalog-reader.js';
import type { AaveReserveCatalog } from '../../adapters/aave/aave-v3-reserve-catalog-reader.js';
import type { AaveReserveCatalogReaderOptions } from '../../adapters/aave/aave-v3-reserve-catalog-reader.js';
import { AaveV3EventReader } from '../../adapters/aave/aave-v3-event-reader.js';
import type { AaveV3EventReaderOptions } from '../../adapters/aave/aave-v3-event-reader.js';
import { supportedUniswapV3Deployments } from '../../adapters/uniswap/uniswap-v3-position-reader.js';
import { supportedUniswapV4Deployments } from '../../adapters/uniswap/uniswap-v4-position-reader.js';
import {
  BINANCE_DEFAULT_CONFIG,
  INTEGRATION_CATALOG,
  evmNetworkName,
  isEvmRpcProvider,
} from './integration-catalog.js';

const ZERO_EVM_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface AaveReserveCatalogReaderFactory {
  create(options: AaveReserveCatalogReaderOptions): { read(signal?: AbortSignal): Promise<AaveReserveCatalog> };
}

export interface AaveEventReaderFactory {
  create(options: AaveV3EventReaderOptions): {
    latestBlock(signal?: AbortSignal): Promise<bigint>;
    scan(fromBlock: bigint, toBlock: bigint, signal?: AbortSignal): Promise<unknown[]>;
  };
}

export class IntegrationOperationsService {
  private readonly aaveReserveCache = new Map<string, AaveReserveCatalog>();

  public constructor(
    private readonly integrations: IntegrationRepository,
    private readonly markets: MarketRepository,
    private readonly networkHealth: IntegrationNetworkHealthRepository,
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
    private readonly webSocketFactory: MarketWebSocketFactory = createNodeMarketWebSocket,
    private readonly aaveReserveReaderFactory: AaveReserveCatalogReaderFactory = {
      create: (options) => new AaveV3ReserveCatalogReader(options),
    },
    private readonly aaveEventReaderFactory: AaveEventReaderFactory = {
      create: (options) => new AaveV3EventReader(options),
    },
    private readonly uniswapPools?: UniswapPoolRepository,
    private readonly scanCursors?: ChainScanCursorRepository,
    private readonly uniswapV4Ownership?: UniswapV4OwnershipRepository,
  ) {}

  private readonly walletIndexJobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();

  public catalog() {
    return INTEGRATION_CATALOG;
  }

  public readiness() {
    const integrations = this.integrations.listRuntime();
    const aaveNetworks = new Map<number, {
      chainId: number; name: string; ready: true; integrationIds: string[];
      capabilities: { accountRead: true; reserveCatalog: true; eventLogs: true };
    }>();
    const uniswapNetworks = new Map<number, { chainId: number; name: string; versions: { v3: boolean; v4: boolean }; integrationIds: string[] }>();
    const binanceSources: Array<{
      integrationId: string;
      name: string;
      enabled: boolean;
      marketCount: number;
    }> = [];

    const healthByIntegration = new Map(this.networkHealth.list().map((health) => [`${health.integrationId}:${health.chainId}`, health]));
    for (const integration of integrations) {
      if (integration.type === 'evm_rpc' && integration.enabled && isEvmRpcProvider(integration.provider)) {
        const parsed = rpcIntegrationConfigSchema.safeParse(integration.config);
        if (!parsed.success) continue;
        for (const chainId of parsed.data.chainIds) {
          const health = healthByIntegration.get(`${integration.id}:${chainId}`);
          if (chainId === 1 && health?.rpcStatus === 'ok' && health.aaveV3Status === 'ok') {
            const current = aaveNetworks.get(chainId) ?? {
              chainId, name: evmNetworkName(chainId), ready: true, integrationIds: [],
              capabilities: { accountRead: true, reserveCatalog: true, eventLogs: true },
            };
            current.integrationIds.push(integration.id);
            aaveNetworks.set(chainId, current);
          }
          if ([1, 4_663].includes(chainId) && health?.rpcStatus === 'ok' && (health.uniswapV3Status === 'ok' || health.uniswapV4Status === 'ok')) {
            const current = uniswapNetworks.get(chainId) ?? {
              chainId,
              name: evmNetworkName(chainId),
              versions: { v3: false, v4: false },
              integrationIds: [],
            };
            current.versions.v3 ||= health.uniswapV3Status === 'ok';
            current.versions.v4 ||= health.uniswapV4Status === 'ok';
            current.integrationIds.push(integration.id);
            uniswapNetworks.set(chainId, current);
          }
        }
      }
      if (integration.type === 'market_data' && integration.provider === 'binance') {
        binanceSources.push({
          integrationId: integration.id,
          name: integration.name,
          enabled: integration.enabled,
          marketCount: this.markets.list(integration.id).length,
        });
      }
    }

    const networks = [...aaveNetworks.values()].sort((left, right) => left.chainId - right.chainId);
    const uniswap = [...uniswapNetworks.values()].sort((left, right) => left.chainId - right.chainId);
    return {
      aave: {
        ready: networks.length > 0,
        configuredNetworkCount: networks.length,
        networks,
      },
      binance: {
        ready: binanceSources.some((source) => source.enabled && source.marketCount > 0),
        sources: binanceSources,
      },
      uniswap: {
        ready: uniswap.length > 0,
        configuredNetworkCount: uniswap.length,
        networks: uniswap,
      },
    };
  }

  public ensureDefaultBinance() {
    const existing = this.integrations.listRuntime().find((integration) => (
      integration.type === 'market_data' && integration.provider === 'binance'
    ));
    if (existing !== undefined) {
      return { created: false, integration: this.integrations.get(existing.id) };
    }
    const integration = this.integrations.create({
      name: 'Binance Public Market Data',
      type: 'market_data',
      provider: 'binance',
      enabled: true,
      config: { ...BINANCE_DEFAULT_CONFIG },
    });
    return { created: true, integration };
  }

  public async test(id: string) {
    const integration = this.integrations.getRuntime(id);
    if (!integration.enabled) {
      throw new AppError(409, 'INTEGRATION_DISABLED', 'Enable the integration before using it');
    }
    if (integration.type === 'evm_rpc' && isEvmRpcProvider(integration.provider)) {
      const config = rpcIntegrationConfigSchema.parse(integration.config);
      const networks = await Promise.all(config.chainIds.map(async (chainId) => {
        const connectivity: Record<string, 'ok' | 'error' | 'unknown'> = {
          rpc: 'unknown',
          ...(chainId === 1 ? { aaveV3: 'unknown' as const } : {}),
          ...([1, 4_663].includes(chainId) ? { uniswapV3: 'unknown' as const, uniswapV4: 'unknown' as const } : {}),
        };
        let blockNumber: string | null = null;
        let errorResult: { code: string; message: string } | null = null;
        const aaveCapabilities = { accountRead: 'unknown' as const, reserveCatalog: 'unknown' as const, eventLogs: 'unknown' as const } as {
          accountRead: 'ok' | 'error' | 'unknown'; reserveCatalog: 'ok' | 'error' | 'unknown'; eventLogs: 'ok' | 'error' | 'unknown';
        };
        try {
          const resolved = resolveEvmRpcRequest(config, chainId);
        const rpcClient = new EvmRpcClient({
          rpcUrl: resolved.rpcUrl,
          headers: resolved.headers,
          expectedChainId: chainId,
          fetch: this.fetchImplementation,
          timeoutMilliseconds: config.timeoutMilliseconds,
        });
        const probe = await rpcClient.testConnectivity();
        blockNumber = probe.blockNumber;
        connectivity.rpc = 'ok';
        const supportsAaveV3 = chainId === 1;
        if (supportsAaveV3) {
          await new AaveV3PositionReader({
            rpcUrl: resolved.rpcUrl,
            headers: resolved.headers,
            expectedChainId: chainId,
            fetch: this.fetchImplementation,
            timeoutMilliseconds: config.timeoutMilliseconds,
            multicallBatchSizeBytes: config.multicallBatchSizeBytes,
          }).read(ZERO_EVM_ADDRESS);
          aaveCapabilities.accountRead = 'ok';
          try {
            await this.aaveReserveReaderFactory.create({
              rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: chainId,
              fetch: this.fetchImplementation, timeoutMilliseconds: config.timeoutMilliseconds,
            }).read();
            aaveCapabilities.reserveCatalog = 'ok';
          } catch {
            aaveCapabilities.reserveCatalog = 'error';
          }
          try {
            const reader = this.aaveEventReaderFactory.create({
              rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: chainId,
              fetch: this.fetchImplementation, timeoutMilliseconds: config.timeoutMilliseconds,
            });
            const latest = await reader.latestBlock();
            await reader.scan(latest, latest);
            aaveCapabilities.eventLogs = 'ok';
          } catch {
            aaveCapabilities.eventLogs = 'error';
          }
          connectivity.aaveV3 = Object.values(aaveCapabilities).every((status) => status === 'ok') ? 'ok' : 'error';
          if (connectivity.aaveV3 === 'error') throw new Error('Aave capability probe failed');
        }
        const uniswapV3 = supportedUniswapV3Deployments.get(chainId);
        const uniswapV4 = supportedUniswapV4Deployments.get(chainId);
        if (uniswapV3 !== undefined) {
          const [factoryCode, positionManagerCode] = await Promise.all([
            rpcClient.publicClient.getBytecode({ address: uniswapV3.factoryAddress }),
            rpcClient.publicClient.getBytecode({ address: uniswapV3.positionManagerAddress }),
          ]);
          if (factoryCode === undefined || factoryCode === '0x' || positionManagerCode === undefined || positionManagerCode === '0x') {
            throw new Error('Official Uniswap V3 contracts are unavailable through this RPC');
          }
          connectivity.uniswapV3 = 'ok';
        }
        if (uniswapV4 !== undefined) {
          const codes = await Promise.all([
            rpcClient.publicClient.getBytecode({ address: uniswapV4.poolManagerAddress }),
            rpcClient.publicClient.getBytecode({ address: uniswapV4.positionManagerAddress }),
            rpcClient.publicClient.getBytecode({ address: uniswapV4.stateViewAddress }),
          ]);
          if (codes.some((code) => code === undefined || code === '0x')) {
            throw new Error('Official Uniswap V4 contracts are unavailable through this RPC');
          }
          connectivity.uniswapV4 = 'ok';
        }
      } catch (error) {
        if (error instanceof EvmChainMismatchError) {
          connectivity.rpc = 'error';
          errorResult = { code: 'RPC_CHAIN_ID_MISMATCH', message: `Expected chain ${error.expectedChainId}, received chain ${error.actualChainId}` };
        } else {
          if (connectivity.rpc !== 'ok') connectivity.rpc = 'error';
          for (const capability of ['aaveV3', 'uniswapV3', 'uniswapV4'] as const) {
            if (connectivity[capability] === 'ok') continue;
            const available = capability === 'aaveV3'
              ? chainId === 1
              : capability === 'uniswapV3'
                ? supportedUniswapV3Deployments.has(chainId)
                : supportedUniswapV4Deployments.has(chainId);
            if (available) connectivity[capability] = 'error';
          }
          const code = error instanceof Error && ['RPC_ROUTING_CONFIG_INVALID', 'RPC_CHAIN_UNSUPPORTED'].includes(error.message)
            ? error.message
            : 'RPC_CONNECTION_FAILED';
          errorResult = { code, message: code === 'RPC_CONNECTION_FAILED' ? 'RPC or protocol capability test failed' : 'RPC routing configuration is invalid' };
        }
      }
        const result = {
          chainId,
          chainName: evmNetworkName(chainId),
          ok: errorResult === null,
          blockNumber,
          connectivity,
          ...(chainId === 1 ? { aaveCapabilities } : {}),
          error: errorResult,
        };
        this.networkHealth.replace({
          integrationId: integration.id,
          chainId,
          rpcStatus: connectivity.rpc,
          aaveV3Status: connectivity.aaveV3 ?? 'unknown',
          aaveAccountReadStatus: aaveCapabilities.accountRead,
          aaveReserveCatalogStatus: aaveCapabilities.reserveCatalog,
          aaveEventLogsStatus: aaveCapabilities.eventLogs,
          uniswapV3Status: connectivity.uniswapV3 ?? 'unknown',
          uniswapV4Status: connectivity.uniswapV4 ?? 'unknown',
          blockNumber,
          errorCode: errorResult?.code ?? null,
          testedAt: new Date().toISOString(),
        });
        return result;
      }));
      return { ok: networks.every((network) => network.ok), provider: integration.provider, networks };
    }
    const { client, config } = this.binanceContext(id);
    try {
      await Promise.all([
        client.testConnectivity(),
        testWebSocketConnectivity(config.spotWebsocketUrl, this.webSocketFactory),
        testWebSocketConnectivity(config.futuresWebsocketUrl, this.webSocketFactory),
      ]);
      return {
        ok: true,
        provider: 'binance',
        connectivity: {
          spot: { rest: 'ok', websocket: 'ok' },
          perpetual: { rest: 'ok', websocket: 'ok' },
        },
      };
    } catch (error) {
      this.throwConnectionError(error, 'Binance integration connection failed');
    }
  }

  public invalidateTestResults(integrationId: string): void {
    this.networkHealth.removeIntegration(integrationId);
    this.aaveReserveCache.delete(integrationId);
  }

  public async aaveReserves(id: string, chainId: number): Promise<AaveReserveCatalog & { stale: boolean }> {
    if (chainId !== 1) throw new AppError(400, 'RPC_CHAIN_UNSUPPORTED', 'Aave reserve catalog is only available for Ethereum');
    const integration = this.integrations.getRuntime(id);
    if (!integration.enabled || integration.type !== 'evm_rpc') {
      throw new AppError(409, 'PROTOCOL_NOT_READY', 'An enabled EVM RPC integration is required');
    }
    const health = this.networkHealth.list().find((item) => item.integrationId === id && item.chainId === chainId);
    if (health?.rpcStatus !== 'ok' || health.aaveReserveCatalogStatus !== 'ok') {
      throw new AppError(409, 'RESOURCE_CATALOG_NOT_READY', 'Test the Ethereum Aave capability before loading reserves');
    }
    const cached = this.aaveReserveCache.get(id);
    if (cached !== undefined && Date.now() - Date.parse(cached.observedAt) < 60_000) return { ...cached, stale: false };
    try {
      const config = rpcIntegrationConfigSchema.parse(integration.config);
      const resolved = resolveEvmRpcRequest(config, chainId);
      const catalog = await this.aaveReserveReaderFactory.create({
        rpcUrl: resolved.rpcUrl,
        headers: resolved.headers,
        expectedChainId: chainId,
        fetch: this.fetchImplementation,
        timeoutMilliseconds: config.timeoutMilliseconds,
      }).read();
      this.aaveReserveCache.set(id, catalog);
      return { ...catalog, stale: false };
    } catch {
      if (cached !== undefined) return {
        ...cached,
        stale: true,
        status: 'partial',
        error: { code: 'INDEXER_PARTIAL_FAILURE', message: 'Serving stale reserve catalog after an RPC failure' },
      };
      throw new AppError(502, 'RESOURCE_CATALOG_NOT_READY', 'Aave reserve catalog could not be read');
    }
  }

  public async syncMarkets(id: string) {
    const { client } = this.binanceContext(id);
    try {
      const discovered = await client.discoverMarkets();
      this.markets.replace(id, discovered);
      const spot = discovered.filter((market) => market.marketType === 'spot').length;
      const perpetual = discovered.length - spot;
      return { synchronizedAt: new Date().toISOString(), total: discovered.length, spot, perpetual };
    } catch (error) {
      this.throwConnectionError(error, 'Binance integration connection failed');
    }
  }

  public uniswapPoolCatalog(id: string, input: {
    chainId: number; version: 'v3' | 'v4'; q?: string | undefined; limit: number; cursor?: string | undefined;
  }) {
    if (this.uniswapPools === undefined || this.scanCursors === undefined) {
      throw new AppError(409, 'RESOURCE_CATALOG_NOT_READY', 'Uniswap pool index is not configured');
    }
    const integration = this.integrations.getRuntime(id);
    if (!integration.enabled || integration.type !== 'evm_rpc') {
      throw new AppError(409, 'PROTOCOL_NOT_READY', 'An enabled EVM RPC integration is required');
    }
    const config = rpcIntegrationConfigSchema.parse(integration.config);
    if (!config.chainIds.includes(input.chainId)) throw new AppError(400, 'RPC_CHAIN_UNSUPPORTED', 'RPC does not cover the selected chain');
    if (![1, 4_663].includes(input.chainId)) throw new AppError(409, 'PROTOCOL_NOT_READY', 'Uniswap is not enabled on this chain');
    const health = this.networkHealth.list().find((item) => item.integrationId === id && item.chainId === input.chainId);
    const capability = input.version === 'v3' ? health?.uniswapV3Status : health?.uniswapV4Status;
    if (health?.rpcStatus !== 'ok' || capability !== 'ok') {
      throw new AppError(409, 'RESOURCE_CATALOG_NOT_READY', 'Test the selected Uniswap network and version before loading pools');
    }
    const result = this.uniswapPools.list({
      integrationId: id, chainId: input.chainId, version: input.version, limit: input.limit,
      ...(input.q === undefined ? {} : { q: input.q }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    const scanned = this.scanCursors.get(id, 'uniswap', input.chainId, `pools:${input.version}`);
    const chainTip = health.blockNumber === null ? undefined : BigInt(health.blockNumber);
    const caughtUp = scanned !== undefined && chainTip !== undefined && scanned >= (chainTip > 12n ? chainTip - 12n : 0n);
    const partial = result.items.some((item) => item.token0Symbol === null || item.token1Symbol === null ||
      item.token0Decimals === null || item.token1Decimals === null);
    return {
      status: scanned === undefined || !caughtUp ? 'warming_up' : partial ? 'partial' : 'ok',
      discovery: {
        caughtUp,
        scannedThroughBlock: scanned?.toString() ?? null,
        chainTipBlock: chainTip?.toString() ?? null,
      },
      items: result.items.map((item) => ({
        chainId: item.chainId, chainName: evmNetworkName(item.chainId), version: item.version,
        poolAddress: item.poolAddress, poolId: item.poolId,
        token0: { address: item.token0Address, symbol: item.token0Symbol, decimals: item.token0Decimals, native: item.token0Native },
        token1: { address: item.token1Address, symbol: item.token1Symbol, decimals: item.token1Decimals, native: item.token1Native },
        feeTier: item.feeTier, tickSpacing: item.tickSpacing, hooksAddress: item.hooksAddress,
      })),
      nextCursor: result.nextCursor,
      error: partial ? { code: 'INDEXER_PARTIAL_FAILURE', message: 'Some token metadata is unavailable' } : null,
    };
  }

  public async uniswapWalletPositions(id: string, input: {
    chainId: number; version: 'v3' | 'v4'; walletAddress: string; limit: number; cursor?: string | undefined; q?: string | undefined;
  }) {
    const integration = this.integrations.getRuntime(id);
    if (!integration.enabled || integration.type !== 'evm_rpc') throw new AppError(409, 'PROTOCOL_NOT_READY', 'Enabled EVM RPC is required');
    const config = rpcIntegrationConfigSchema.parse(integration.config);
    if (!config.chainIds.includes(input.chainId)) throw new AppError(400, 'RPC_CHAIN_UNSUPPORTED', 'RPC does not cover the selected chain');
    const health = this.networkHealth.list().find((item) => item.integrationId === id && item.chainId === input.chainId);
    const capability = input.version === 'v3' ? health?.uniswapV3Status : health?.uniswapV4Status;
    if (health?.rpcStatus !== 'ok' || capability !== 'ok') throw new AppError(409, 'PROTOCOL_NOT_READY', 'Test this Uniswap capability first');
    const resolved = resolveEvmRpcRequest(config, input.chainId);
    const wallet = getAddress(input.walletAddress);
    let tokenIds: string[] = [];
    let caughtUp = true;
    let scannedThroughBlock: string | null = null;
    const chainTipBlock = health.blockNumber;
    if (input.version === 'v3') {
      try {
        const discovered = await new UniswapV3PositionReader({
          rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: input.chainId,
          fetch: this.fetchImplementation, timeoutMilliseconds: config.timeoutMilliseconds,
        }).discover(wallet);
        tokenIds = discovered.tokenIds;
        scannedThroughBlock = discovered.blockNumber.toString();
      } catch {
        throw new AppError(502, 'INDEXER_PARTIAL_FAILURE', 'Uniswap V3 wallet discovery failed');
      }
    } else {
      if (this.uniswapV4Ownership === undefined) throw new AppError(409, 'INDEXER_WARMING_UP', 'V4 ownership index is unavailable');
      const deployment = supportedUniswapV4Deployments.get(input.chainId);
      if (deployment === undefined) throw new AppError(409, 'PROTOCOL_NOT_READY', 'V4 deployment is unavailable');
      const key = { integrationId: id, walletAddress: wallet, positionManagerAddress: deployment.positionManagerAddress };
      tokenIds = this.uniswapV4Ownership.listOwnedTokenIds(key);
      const checkpoint = this.uniswapV4Ownership.getLastScannedBlock(key);
      scannedThroughBlock = checkpoint?.toString() ?? null;
      caughtUp = checkpoint !== undefined && chainTipBlock !== null && checkpoint >= BigInt(chainTipBlock) - 12n;
      this.startWalletIndexJob(id, input.chainId, wallet, resolved, config.timeoutMilliseconds);
    }
    const query = input.q?.toLowerCase();
    const after = input.cursor === undefined ? undefined : BigInt(input.cursor);
    const filtered = tokenIds.filter((tokenId) => (after === undefined || BigInt(tokenId) > after) &&
      (query === undefined || tokenId.includes(query)));
    const page = filtered.slice(0, input.limit);
    const reader = input.version === 'v3'
      ? new UniswapV3PositionReader({ rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: input.chainId,
        fetch: this.fetchImplementation, timeoutMilliseconds: config.timeoutMilliseconds })
      : new UniswapV4PositionReader({ rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: input.chainId,
        fetch: this.fetchImplementation, timeoutMilliseconds: config.timeoutMilliseconds });
    const results = await Promise.allSettled(page.map(async (tokenId) => reader.read(tokenId)));
    const items = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const failedPositionCount = results.length - items.length;
    return {
      status: !caughtUp ? 'warming_up' : failedPositionCount > 0 ? 'partial' : items.length === 0 ? 'empty' : 'ok',
      discovery: { caughtUp, scannedThroughBlock, chainTipBlock }, items,
      failedPositionCount,
      nextCursor: filtered.length > input.limit ? page.at(-1) ?? null : null,
      error: failedPositionCount > 0 ? { code: 'INDEXER_PARTIAL_FAILURE', message: 'Some positions could not be read' } : null,
    };
  }

  public async close(): Promise<void> {
    for (const job of this.walletIndexJobs.values()) job.controller.abort();
    await Promise.allSettled([...this.walletIndexJobs.values()].map((job) => job.promise));
    this.walletIndexJobs.clear();
  }

  private startWalletIndexJob(
    integrationId: string,
    chainId: number,
    walletAddress: `0x${string}`,
    resolved: { rpcUrl: string; headers: Record<string, string> },
    timeoutMilliseconds: number,
  ): void {
    if (this.uniswapV4Ownership === undefined) return;
    const jobKey = `${integrationId}:${chainId}:${walletAddress.toLowerCase()}`;
    if (this.walletIndexJobs.has(jobKey)) return;
    const controller = new AbortController();
    const promise = new UniswapV4OwnershipIndexer({
      rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: chainId, integrationId,
      repository: this.uniswapV4Ownership, fetch: this.fetchImplementation, timeoutMilliseconds,
      maximumChunksPerSync: 1,
    }).sync(walletAddress, controller.signal).then(() => undefined).catch(() => undefined).finally(() => {
      this.walletIndexJobs.delete(jobKey);
    });
    this.walletIndexJobs.set(jobKey, { controller, promise });
  }

  public listMarkets(id: string) {
    this.requireBinance(id);
    return { items: this.markets.list(id) };
  }

  private binanceContext(id: string) {
    const integration = this.requireBinance(id);
    if (!integration.enabled) {
      throw new AppError(409, 'INTEGRATION_DISABLED', 'Enable the integration before using it');
    }
    const config = binanceIntegrationConfigSchema.parse(integration.config);
    return {
      config,
      client: new BinanceRestClient({
        spotRestUrl: config.restUrl,
        futuresRestUrl: config.futuresRestUrl,
        fetch: this.fetchImplementation,
      }),
    };
  }

  private requireBinance(id: string) {
    const integration = this.integrations.getRuntime(id);
    if (integration.type !== 'market_data' || integration.provider !== 'binance') {
      throw new AppError(409, 'ADAPTER_NOT_READY', 'This integration adapter is not available in the current development stage');
    }
    return integration;
  }

  private throwConnectionError(error: unknown, fallback: string): never {
    const message = error instanceof BinanceRestError || error instanceof Error
      ? error.message
      : fallback;
    throw new AppError(502, 'INTEGRATION_CONNECTION_FAILED', message);
  }
}
