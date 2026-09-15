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
import { AaveV3PositionReader } from '../../adapters/aave/aave-v3-position-reader.js';
import { supportedUniswapV3Deployments } from '../../adapters/uniswap/uniswap-v3-position-reader.js';
import { supportedUniswapV4Deployments } from '../../adapters/uniswap/uniswap-v4-position-reader.js';
import {
  BINANCE_DEFAULT_CONFIG,
  INTEGRATION_CATALOG,
  evmNetworkName,
  isEvmRpcProvider,
} from './integration-catalog.js';

const ZERO_EVM_ADDRESS = '0x0000000000000000000000000000000000000000';

export class IntegrationOperationsService {
  public constructor(
    private readonly integrations: IntegrationRepository,
    private readonly markets: MarketRepository,
    private readonly networkHealth: IntegrationNetworkHealthRepository,
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
    private readonly webSocketFactory: MarketWebSocketFactory = createNodeMarketWebSocket,
  ) {}

  public catalog() {
    return INTEGRATION_CATALOG;
  }

  public readiness() {
    const integrations = this.integrations.listRuntime();
    const aaveNetworks = new Map<number, { chainId: number; name: string; ready: true; integrationIds: string[] }>();
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
            const current = aaveNetworks.get(chainId) ?? { chainId, name: evmNetworkName(chainId), ready: true, integrationIds: [] };
            current.integrationIds.push(integration.id);
            aaveNetworks.set(chainId, current);
          }
          if (chainId === 4_663 && health?.rpcStatus === 'ok' && (health.uniswapV3Status === 'ok' || health.uniswapV4Status === 'ok')) {
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
          ...(chainId === 4_663 ? { uniswapV3: 'unknown' as const, uniswapV4: 'unknown' as const } : {}),
        };
        let blockNumber: string | null = null;
        let errorResult: { code: string; message: string } | null = null;
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
          connectivity.aaveV3 = 'ok';
        }
        const uniswapV3 = chainId === 4_663 ? supportedUniswapV3Deployments.get(chainId) : undefined;
        const uniswapV4 = chainId === 4_663 ? supportedUniswapV4Deployments.get(chainId) : undefined;
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
            const available = capability === 'aaveV3' ? chainId === 1 : chainId === 4_663;
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
          error: errorResult,
        };
        this.networkHealth.replace({
          integrationId: integration.id,
          chainId,
          rpcStatus: connectivity.rpc,
          aaveV3Status: connectivity.aaveV3 ?? 'unknown',
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
