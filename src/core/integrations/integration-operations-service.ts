import { BinanceRestClient, BinanceRestError } from '../../adapters/markets/binance/binance-rest-client.js';
import { EvmChainMismatchError, EvmRpcClient } from '../../adapters/evm/evm-rpc-client.js';
import {
  createNodeMarketWebSocket,
  testWebSocketConnectivity,
} from '../../adapters/markets/websocket/websocket-port.js';
import type { MarketWebSocketFactory } from '../../adapters/markets/websocket/websocket-port.js';
import { AppError } from '../../api/errors.js';
import { binanceIntegrationConfigSchema, rpcIntegrationConfigSchema } from '../../api/schemas.js';
import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import type { MarketRepository } from '../../db/repositories/market-repository.js';
import { AaveV3PositionReader, supportedAaveV3Markets } from '../../adapters/aave/aave-v3-position-reader.js';
import {
  BINANCE_DEFAULT_CONFIG,
  INTEGRATION_CATALOG,
  isEvmRpcProvider,
} from './integration-catalog.js';

const ZERO_EVM_ADDRESS = '0x0000000000000000000000000000000000000000';

export class IntegrationOperationsService {
  public constructor(
    private readonly integrations: IntegrationRepository,
    private readonly markets: MarketRepository,
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
    private readonly webSocketFactory: MarketWebSocketFactory = createNodeMarketWebSocket,
  ) {}

  public catalog() {
    return INTEGRATION_CATALOG;
  }

  public readiness() {
    const integrations = this.integrations.listRuntime();
    const rpcNetworks = new Map<number, { chainId: number; name: string; integrationIds: string[] }>();
    const binanceSources: Array<{
      integrationId: string;
      name: string;
      enabled: boolean;
      marketCount: number;
    }> = [];

    for (const integration of integrations) {
      if (integration.type === 'evm_rpc' && integration.enabled && isEvmRpcProvider(integration.provider)) {
        const parsed = rpcIntegrationConfigSchema.safeParse(integration.config);
        const market = parsed.success ? supportedAaveV3Markets.get(parsed.data.chainId) : undefined;
        if (parsed.success && market !== undefined) {
          const current = rpcNetworks.get(parsed.data.chainId) ?? {
            chainId: parsed.data.chainId,
            name: market.chainName,
            integrationIds: [],
          };
          current.integrationIds.push(integration.id);
          rpcNetworks.set(parsed.data.chainId, current);
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

    const networks = [...rpcNetworks.values()].sort((left, right) => left.chainId - right.chainId);
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
      try {
        const probe = await new EvmRpcClient({
          rpcUrl: config.rpcUrl,
          expectedChainId: config.chainId,
          fetch: this.fetchImplementation,
          timeoutMilliseconds: config.timeoutMilliseconds,
        }).testConnectivity();
        const supportsAaveV3 = supportedAaveV3Markets.has(config.chainId);
        if (supportsAaveV3) {
          await new AaveV3PositionReader({
            rpcUrl: config.rpcUrl,
            expectedChainId: config.chainId,
            fetch: this.fetchImplementation,
            timeoutMilliseconds: config.timeoutMilliseconds,
            multicallBatchSizeBytes: config.multicallBatchSizeBytes,
          }).read(ZERO_EVM_ADDRESS);
        }
        return {
          ok: true,
          provider: integration.provider,
          connectivity: {
            rpc: 'ok',
            ...(supportsAaveV3 ? { aaveV3: 'ok' } : {}),
          },
          ...probe,
        };
      } catch (error) {
        if (error instanceof EvmChainMismatchError) {
          throw new AppError(502, 'RPC_CHAIN_ID_MISMATCH', error.message, {
            chainId: `Expected ${error.expectedChainId}, received ${error.actualChainId}`,
          });
        }
        this.throwConnectionError(error, 'EVM RPC connection failed');
      }
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
