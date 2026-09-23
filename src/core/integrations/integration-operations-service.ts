import { BinanceRestClient, BinanceRestError } from '../../adapters/markets/binance/binance-rest-client.js';
import {
  discoverTelegramChats,
  sendTelegramMessage,
  TelegramApiError,
} from '../../adapters/notifications/telegram-client.js';
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
import type { UniswapV3Position } from '../../adapters/uniswap/uniswap-v3-position-reader.js';
import type { UniswapV4Position } from '../../adapters/uniswap/uniswap-v4-position-reader.js';
import {
  BINANCE_DEFAULT_CONFIG,
  INTEGRATION_CATALOG,
  evmNetworkName,
  isEvmRpcProvider,
} from './integration-catalog.js';
import type {
  UniswapV3PositionReaderPort,
  UniswapV3PositionReaderFactory,
  UniswapV4PositionReaderPort,
  UniswapV4PositionReaderFactory,
} from './uniswap-v3-position-coordinator.js';

const ZERO_EVM_ADDRESS = '0x0000000000000000000000000000000000000000';
const WALLET_POSITION_RESPONSE_CACHE_TTL_MILLISECONDS = 10_000;

type UniswapWalletPosition = UniswapV3Position | UniswapV4Position;
type UniswapWalletPositionsResult = {
  status: 'warming_up' | 'partial' | 'empty' | 'ok';
  discovery: { caughtUp: boolean; scannedThroughBlock: string | null; chainTipBlock: string | null };
  items: UniswapWalletPosition[];
  failedPositionCount: number;
  nextCursor: string | null;
  error: { code: string; message: string } | null;
};

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
  private readonly uniswapV3ReaderFactory: UniswapV3PositionReaderFactory;
  private readonly uniswapV4ReaderFactory: UniswapV4PositionReaderFactory;
  private readonly uniswapV3Readers = new Map<string, UniswapV3PositionReaderPort>();
  private readonly uniswapV4Readers = new Map<string, UniswapV4PositionReaderPort>();
  private readonly walletPositionResponses = new Map<string, {
    expiresAt: number;
    result: UniswapWalletPositionsResult;
  }>();
  private readonly walletPositionInflight = new Map<string, Promise<UniswapWalletPositionsResult>>();
  private readonly walletPositionReads = new Map<string, {
    expiresAt: number;
    position: UniswapWalletPosition;
  }>();
  private readonly walletPositionReadInflight = new Map<string, Promise<UniswapWalletPosition>>();

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
    uniswapV3ReaderFactory?: UniswapV3PositionReaderFactory,
    uniswapV4ReaderFactory?: UniswapV4PositionReaderFactory,
  ) {
    this.uniswapV3ReaderFactory = uniswapV3ReaderFactory ?? {
      create: (options) => new UniswapV3PositionReader({ ...options, fetch: this.fetchImplementation }),
    };
    this.uniswapV4ReaderFactory = uniswapV4ReaderFactory ?? {
      create: (options) => new UniswapV4PositionReader({ ...options, fetch: this.fetchImplementation }),
    };
  }

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

  public async discoverTelegram(botToken: string) {
    try {
      const result = await discoverTelegramChats(botToken, this.fetchImplementation);
      if (result.webhookActive) {
        throw new AppError(
          409,
          'TELEGRAM_WEBHOOK_ACTIVE',
          'This bot has an active webhook; use a dedicated bot or enter the Chat ID manually',
        );
      }
      return { bot: result.bot, chats: result.chats };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (!(error instanceof TelegramApiError)) {
        throw new AppError(502, 'TELEGRAM_UNAVAILABLE', 'Telegram discovery failed');
      }
      const statusCode = error.code === 'TELEGRAM_UNAUTHORIZED' ? 401
        : error.code === 'TELEGRAM_FORBIDDEN' ? 403
          : error.code === 'TELEGRAM_BAD_REQUEST' ? 400
            : error.code === 'TELEGRAM_RATE_LIMITED' ? 429 : 502;
      throw new AppError(
        statusCode,
        error.code,
        error.message,
        error.retryAfterSeconds === undefined ? undefined : { retryAfterSeconds: String(error.retryAfterSeconds) },
      );
    }
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
    if (integration.type === 'notification' && integration.provider === 'telegram') {
      const config = integration.config;
      if (typeof config.botToken !== 'string' || typeof config.chatId !== 'string') {
        throw new AppError(400, 'INVALID_REQUEST', 'Telegram configuration is invalid');
      }
      const result = await sendTelegramMessage(
        { botToken: config.botToken, chatId: config.chatId },
        'CryptoSentry Telegram connection test',
        this.fetchImplementation,
      );
      return result.ok
        ? { ok: true, provider: 'telegram', delivery: { status: 'sent' } }
        : { ok: false, provider: 'telegram', delivery: { status: 'failed' }, error: { code: result.code, message: result.message } };
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
        const capabilityErrors: Record<string, { code: string; message: string } | null> = {};
        const aaveCapabilities = { accountRead: 'unknown' as const, reserveCatalog: 'unknown' as const, eventLogs: 'unknown' as const } as {
          accountRead: 'ok' | 'error' | 'unknown'; reserveCatalog: 'ok' | 'error' | 'unknown'; eventLogs: 'ok' | 'error' | 'unknown';
        };
        let resolved: ReturnType<typeof resolveEvmRpcRequest> | undefined;
        let rpcClient: EvmRpcClient | undefined;
        try {
          resolved = resolveEvmRpcRequest(config, chainId);
          rpcClient = new EvmRpcClient({
            rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: chainId,
            fetch: this.fetchImplementation, timeoutMilliseconds: config.timeoutMilliseconds,
          });
          const probe = await rpcClient.testConnectivity();
          blockNumber = probe.blockNumber;
          connectivity.rpc = 'ok';
          capabilityErrors.rpc = null;
        } catch (error) {
          connectivity.rpc = 'error';
          const mismatch = error instanceof EvmChainMismatchError;
          const routingCode = error instanceof Error && ['RPC_ROUTING_CONFIG_INVALID', 'RPC_CHAIN_UNSUPPORTED'].includes(error.message)
            ? error.message : null;
          errorResult = mismatch
            ? { code: 'RPC_CHAIN_ID_MISMATCH', message: `Expected chain ${error.expectedChainId}, received chain ${error.actualChainId}` }
            : routingCode === null
              ? { code: 'RPC_CONNECTION_FAILED', message: 'RPC connectivity test failed' }
              : { code: routingCode, message: 'RPC routing configuration is invalid' };
          capabilityErrors.rpc = errorResult;
        }

        if (connectivity.rpc === 'ok' && resolved !== undefined && rpcClient !== undefined) {
          const probe = async (name: string, run: () => Promise<void>): Promise<'ok' | 'error'> => {
            try {
              await run();
              capabilityErrors[name] = null;
              return 'ok';
            } catch {
              capabilityErrors[name] = { code: 'PROTOCOL_NOT_READY', message: `${name} capability test failed` };
              return 'error';
            }
          };
          if (chainId === 1) {
            aaveCapabilities.accountRead = await probe('aaveAccountRead', async () => {
              await new AaveV3PositionReader({
                rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: chainId,
                fetch: this.fetchImplementation, timeoutMilliseconds: config.timeoutMilliseconds,
                multicallBatchSizeBytes: config.multicallBatchSizeBytes,
              }).read(ZERO_EVM_ADDRESS);
            });
            aaveCapabilities.reserveCatalog = await probe('aaveReserveCatalog', async () => {
              await this.aaveReserveReaderFactory.create({
                rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: chainId,
                fetch: this.fetchImplementation, timeoutMilliseconds: config.timeoutMilliseconds,
              }).read();
            });
            aaveCapabilities.eventLogs = await probe('aaveEventLogs', async () => {
              const reader = this.aaveEventReaderFactory.create({
                rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: chainId,
                fetch: this.fetchImplementation, timeoutMilliseconds: config.timeoutMilliseconds,
              });
              const latest = await reader.latestBlock();
              await reader.scan(latest, latest);
            });
            connectivity.aaveV3 = Object.values(aaveCapabilities).every((status) => status === 'ok') ? 'ok' : 'error';
          }
          const uniswapV3 = supportedUniswapV3Deployments.get(chainId);
          if (uniswapV3 !== undefined) connectivity.uniswapV3 = await probe('uniswapV3', async () => {
            const codes = await Promise.all([
              rpcClient.publicClient.getBytecode({ address: uniswapV3.factoryAddress }),
              rpcClient.publicClient.getBytecode({ address: uniswapV3.positionManagerAddress }),
            ]);
            if (codes.some((code) => code === undefined || code === '0x')) throw new Error('contract unavailable');
          });
          const uniswapV4 = supportedUniswapV4Deployments.get(chainId);
          if (uniswapV4 !== undefined) connectivity.uniswapV4 = await probe('uniswapV4', async () => {
            const codes = await Promise.all([
              rpcClient.publicClient.getBytecode({ address: uniswapV4.poolManagerAddress }),
              rpcClient.publicClient.getBytecode({ address: uniswapV4.positionManagerAddress }),
              rpcClient.publicClient.getBytecode({ address: uniswapV4.stateViewAddress }),
            ]);
            if (codes.some((code) => code === undefined || code === '0x')) throw new Error('contract unavailable');
          });
          const applicable = Object.entries(connectivity).filter(([name]) => name !== 'rpc');
          if (applicable.some(([, status]) => status === 'error')) {
            errorResult = { code: 'RPC_PARTIAL_FAILURE', message: 'One or more protocol capability tests failed' };
          }
        }
        const result = {
          chainId,
          chainName: evmNetworkName(chainId),
          ok: errorResult === null,
          blockNumber,
          connectivity,
          ...(chainId === 1 ? { aaveCapabilities } : {}),
          capabilityErrors,
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
    this.clearUniswapWalletCaches(integrationId);
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
    const indexer = this.uniswapPools.getIndexerState(id, input.chainId, input.version);
    const indexerFailed = indexer?.status === 'error';
    return {
      status: indexerFailed ? 'partial' : scanned === undefined || !caughtUp ? 'warming_up' : partial ? 'partial' : 'ok',
      discovery: {
        caughtUp,
        scannedThroughBlock: scanned?.toString() ?? null,
        chainTipBlock: chainTip?.toString() ?? null,
        lastAttemptAt: indexer?.lastAttemptAt ?? null,
        lastError: indexer?.lastErrorCode ?? null,
      },
      items: result.items.map((item) => ({
        chainId: item.chainId, chainName: evmNetworkName(item.chainId), version: item.version,
        poolAddress: item.poolAddress, poolId: item.poolId,
        token0: { address: item.token0Address, symbol: item.token0Symbol, decimals: item.token0Decimals, native: item.token0Native },
        token1: { address: item.token1Address, symbol: item.token1Symbol, decimals: item.token1Decimals, native: item.token1Native },
        feeTier: item.feeTier, tickSpacing: item.tickSpacing, hooksAddress: item.hooksAddress,
      })),
      nextCursor: result.nextCursor,
      error: indexerFailed
        ? { code: 'INDEXER_PARTIAL_FAILURE', message: 'Pool indexing is retrying after a provider log-range failure' }
        : partial ? { code: 'INDEXER_PARTIAL_FAILURE', message: 'Some token metadata is unavailable' } : null,
    };
  }

  public async uniswapWalletPositions(id: string, input: {
    chainId: number; version: 'v3' | 'v4'; walletAddress: string; limit: number; cursor?: string | undefined; q?: string | undefined;
  }): Promise<UniswapWalletPositionsResult> {
    // The Dashboard can refresh the list and detail panes at the same time. Deduplicate
    // identical requests so both panes share one discovery/read operation instead of
    // creating another burst of RPC calls.
    const cacheKey = JSON.stringify([
      id, input.chainId, input.version, input.walletAddress.toLowerCase(), input.limit,
      input.cursor ?? null, input.q ?? null,
    ]);
    const cached = this.walletPositionResponses.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.result;
    const inflight = this.walletPositionInflight.get(cacheKey);
    if (inflight !== undefined) return inflight;
    const request = this.loadUniswapWalletPositions(id, input);
    this.walletPositionInflight.set(cacheKey, request);
    try {
      const result = await request;
      this.walletPositionResponses.set(cacheKey, {
        expiresAt: Date.now() + WALLET_POSITION_RESPONSE_CACHE_TTL_MILLISECONDS,
        result,
      });
      return result;
    } finally {
      this.walletPositionInflight.delete(cacheKey);
    }
  }

  private async loadUniswapWalletPositions(id: string, input: {
    chainId: number; version: 'v3' | 'v4'; walletAddress: string; limit: number; cursor?: string | undefined; q?: string | undefined;
  }): Promise<UniswapWalletPositionsResult> {
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
    const readerOptions = {
      rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: input.chainId,
      timeoutMilliseconds: config.timeoutMilliseconds,
      multicallBatchSizeBytes: config.multicallBatchSizeBytes,
    };
    const readerKey = `${id}:${input.chainId}:${input.version}`;
    if (input.version === 'v3') {
      try {
        const reader = this.getUniswapV3Reader(readerKey, readerOptions);
        const discovered = await reader.discover(wallet);
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
    const after = input.cursor === undefined ? undefined : BigInt(input.cursor);
    const candidates = tokenIds.filter((tokenId) => after === undefined || BigInt(tokenId) > after)
      .sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0);
    const reader = input.version === 'v3'
      ? this.getUniswapV3Reader(readerKey, readerOptions)
      : this.getUniswapV4Reader(readerKey, readerOptions);
    const results: Array<PromiseSettledResult<Awaited<ReturnType<typeof reader.read>>>> = [];
    // Keep wallet discovery below provider burst limits. The reader itself performs
    // a small Promise.all for metadata, so eight concurrent positions can fan out
    // into dozens of HTTP RPC requests at once.
    const readConcurrency = 2;
    for (let offset = 0; offset < candidates.length; offset += readConcurrency) {
      const batch = candidates.slice(offset, offset + readConcurrency);
      results.push(...await Promise.allSettled(batch.map(async (tokenId) => (
        this.readWalletPosition(`${readerKey}:${tokenId}`, tokenId, reader)
      ))));
    }
    const readable = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const failedPositionCount = results.length - readable.length;
    const query = input.q?.trim().toLowerCase();
    const matches = readable.filter((position) => {
      if (query === undefined || query.length === 0) return true;
      const pair = `${position.token0.symbol}/${position.token1.symbol}`;
      const resources = position.version === 'v3' ? [position.poolAddress] : [position.poolId];
      return [position.tokenId, position.token0.symbol, position.token1.symbol, position.token0.address,
        position.token1.address, pair, `${position.token1.symbol}/${position.token0.symbol}`, ...resources]
        .some((value) => value.toLowerCase().includes(query));
    });
    const items = matches.slice(0, input.limit);
    return {
      status: !caughtUp ? 'warming_up' : failedPositionCount > 0 ? 'partial' : items.length === 0 ? 'empty' : 'ok',
      discovery: { caughtUp, scannedThroughBlock, chainTipBlock }, items,
      failedPositionCount,
      nextCursor: matches.length > input.limit ? items.at(-1)?.tokenId ?? null : null,
      error: failedPositionCount > 0 ? { code: 'INDEXER_PARTIAL_FAILURE', message: 'Some positions could not be read' } : null,
    };
  }

  public async close(): Promise<void> {
    for (const job of this.walletIndexJobs.values()) job.controller.abort();
    await Promise.allSettled([...this.walletIndexJobs.values()].map((job) => job.promise));
    this.walletIndexJobs.clear();
    this.uniswapV3Readers.clear();
    this.uniswapV4Readers.clear();
    this.walletPositionResponses.clear();
    this.walletPositionInflight.clear();
    this.walletPositionReads.clear();
    this.walletPositionReadInflight.clear();
  }

  private getUniswapV3Reader(
    key: string,
    options: {
      rpcUrl: string;
      headers?: Record<string, string>;
      expectedChainId: number;
      timeoutMilliseconds: number;
      multicallBatchSizeBytes: number;
    },
  ): UniswapV3PositionReaderPort {
    const existing = this.uniswapV3Readers.get(key);
    if (existing !== undefined) return existing;
    const reader = this.uniswapV3ReaderFactory.create(options);
    this.uniswapV3Readers.set(key, reader);
    return reader;
  }

  private getUniswapV4Reader(
    key: string,
    options: {
      rpcUrl: string;
      headers?: Record<string, string>;
      expectedChainId: number;
      timeoutMilliseconds: number;
    },
  ): UniswapV4PositionReaderPort {
    const existing = this.uniswapV4Readers.get(key);
    if (existing !== undefined) return existing;
    const reader = this.uniswapV4ReaderFactory.create(options);
    this.uniswapV4Readers.set(key, reader);
    return reader;
  }

  private clearUniswapWalletCaches(integrationId: string): void {
    for (const key of this.uniswapV3Readers.keys()) {
      if (key.startsWith(`${integrationId}:`)) this.uniswapV3Readers.delete(key);
    }
    for (const key of this.uniswapV4Readers.keys()) {
      if (key.startsWith(`${integrationId}:`)) this.uniswapV4Readers.delete(key);
    }
    for (const key of this.walletPositionResponses.keys()) {
      if (key.startsWith(`["${integrationId}"`)) this.walletPositionResponses.delete(key);
    }
    for (const key of this.walletPositionInflight.keys()) {
      if (key.startsWith(`["${integrationId}"`)) this.walletPositionInflight.delete(key);
    }
    for (const key of this.walletPositionReads.keys()) {
      if (key.startsWith(`${integrationId}:`)) this.walletPositionReads.delete(key);
    }
    for (const key of this.walletPositionReadInflight.keys()) {
      if (key.startsWith(`${integrationId}:`)) this.walletPositionReadInflight.delete(key);
    }
  }

  private async readWalletPosition(
    cacheKey: string,
    tokenId: string,
    reader: UniswapV3PositionReaderPort | UniswapV4PositionReaderPort,
  ): Promise<UniswapWalletPosition> {
    const cached = this.walletPositionReads.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.position;
    const inflight = this.walletPositionReadInflight.get(cacheKey);
    if (inflight !== undefined) return inflight;
    const request = reader.read(tokenId);
    this.walletPositionReadInflight.set(cacheKey, request);
    try {
      const position = await request;
      this.walletPositionReads.set(cacheKey, {
        expiresAt: Date.now() + WALLET_POSITION_RESPONSE_CACHE_TTL_MILLISECONDS,
        position,
      });
      return position;
    } finally {
      this.walletPositionReadInflight.delete(cacheKey);
    }
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
