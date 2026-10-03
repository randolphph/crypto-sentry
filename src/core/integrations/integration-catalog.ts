import { ROBINHOOD_UNISWAP_V3, supportedUniswapV3Deployments } from '../../adapters/uniswap/uniswap-v3-position-reader.js';
import { supportedUniswapV4Deployments } from '../../adapters/uniswap/uniswap-v4-position-reader.js';
import { RULE_METRICS } from '../rules/rule-metric-catalog.js';
import { productAaveV3ChainIds, supportedAaveV3Markets } from '../../adapters/aave/aave-v3-position-reader.js';
import { supportedPancakeV3Deployments } from '../../adapters/pancake/pancake-v3-position-reader.js';

export const EVM_RPC_PROVIDERS = ['alchemy', 'infura', 'quicknode', 'custom'] as const;

export type EvmRpcProvider = (typeof EVM_RPC_PROVIDERS)[number];

export const BINANCE_DEFAULT_CONFIG = {
  restUrl: 'https://api.binance.com',
  futuresRestUrl: 'https://fapi.binance.com',
  spotWebsocketUrl: 'wss://stream.binance.com:9443',
  futuresWebsocketUrl: 'wss://fstream.binance.com/market',
} as const;

export const INTEGRATION_CATALOG = {
  samplingPresets: [
    { id: 'realtime', intervalSeconds: 5 },
    { id: 'standard', intervalSeconds: 20 },
    { id: 'economy', intervalSeconds: 60 },
  ],
  ruleMetrics: RULE_METRICS,
  marketData: {
    providers: [{
      id: 'binance',
      name: 'Binance',
      requiresCredentials: false,
      supportedMarketTypes: ['spot', 'perpetual'],
      defaultConfig: BINANCE_DEFAULT_CONFIG,
    }],
  },
  evmRpc: {
    providers: [
      { id: 'alchemy', name: 'Alchemy' },
      { id: 'infura', name: 'Infura' },
      { id: 'quicknode', name: 'QuickNode' },
      { id: 'custom', name: 'Custom RPC' },
    ],
    routingModes: [
      { id: 'fixed', name: '单链' },
      { id: 'url_template', name: 'URL 模板' },
      { id: 'header', name: 'Header 选链' },
      { id: 'query', name: 'Query 选链' },
    ],
    networks: [
      { chainId: 1, name: 'Ethereum', productEnabled: true, capabilities: { aaveV3: 'available', uniswapV3: 'available', uniswapV4: 'available' } },
      { chainId: 9_745, name: 'Plasma', productEnabled: true, capabilities: { aaveV3: 'available', uniswapV3: 'unsupported', uniswapV4: 'unsupported' } },
      { chainId: 42_161, name: 'Arbitrum', productEnabled: false, capabilities: { aaveV3: 'planned', uniswapV3: 'unsupported', uniswapV4: 'unsupported' } },
      { chainId: 8_453, name: 'Base', productEnabled: false, capabilities: { aaveV3: 'planned', uniswapV3: 'unsupported', uniswapV4: 'unsupported' } },
      { chainId: 56, name: 'BNB Chain', productEnabled: true, capabilities: { aaveV3: 'unsupported', uniswapV3: 'available', uniswapV4: 'available', pancakeV3: 'available' } },
      {
        chainId: ROBINHOOD_UNISWAP_V3.chainId,
        name: ROBINHOOD_UNISWAP_V3.chainName,
        productEnabled: true,
        capabilities: { aaveV3: 'unsupported', uniswapV3: 'available', uniswapV4: 'available' },
        defaultRpcUrl: ROBINHOOD_UNISWAP_V3.rpcUrl,
        explorerUrl: ROBINHOOD_UNISWAP_V3.explorerUrl,
      },
    ],
    configDefaults: {
      timeoutMilliseconds: 5_000,
      multicallBatchSizeBytes: 8_192,
    },
  },
  monitorTypes: [
    { id: 'market', status: 'available' },
    { id: 'aave_account', status: 'available', chainIds: productAaveV3ChainIds },
    { id: 'aave_pool', status: 'available', chainIds: productAaveV3ChainIds },
    { id: 'uniswap_position', status: 'available', chainIds: [1, 56, 4_663], versions: ['v3', 'v4'] },
    { id: 'uniswap_wallet', status: 'available', chainIds: [1, 56, 4_663], versions: ['v3', 'v4'] },
    { id: 'uniswap_pool', status: 'available', chainIds: [1, 56, 4_663], versions: ['v3', 'v4'] },
    { id: 'pancake_position', status: 'available', chainIds: [56], versions: ['v3'] },
    { id: 'pancake_wallet', status: 'available', chainIds: [56], versions: ['v3'] },
    { id: 'pancake_pool', status: 'available', chainIds: [56], versions: ['v3'] },
  ],
  aave: {
    deployments: [...supportedAaveV3Markets.values()].filter((market) => productAaveV3ChainIds.includes(market.chainId as 1 | 9_745)).map((market) => ({
      chainId: market.chainId,
      chainName: market.chainName,
      version: 'v3',
      poolAddress: market.poolAddress,
      poolAddressesProviderAddress: market.poolAddressesProviderAddress,
      dataProviderAddress: market.dataProviderAddress,
      oracleAddress: market.oracleAddress,
    })),
  },
  uniswap: {
    deployments: [
      ...[...supportedUniswapV3Deployments.values()].map((deployment) => ({
        chainId: deployment.chainId, chainName: deployment.chainName, version: 'v3' as const,
        factoryAddress: deployment.factoryAddress, positionManagerAddress: deployment.positionManagerAddress,
        deploymentBlock: deployment.deploymentBlock.toString(), explorerUrl: deployment.explorerUrl,
      })),
      ...[...supportedUniswapV4Deployments.values()].map((deployment) => ({
        chainId: deployment.chainId, chainName: deployment.chainName, version: 'v4' as const,
        poolManagerAddress: deployment.poolManagerAddress, positionManagerAddress: deployment.positionManagerAddress,
        stateViewAddress: deployment.stateViewAddress, deploymentBlock: deployment.deploymentBlock.toString(),
        explorerUrl: deployment.explorerUrl,
      })),
    ],
  },
  pancakeswap: {
    deployments: [...supportedPancakeV3Deployments.values()].map((deployment) => ({
      chainId: deployment.chainId, chainName: deployment.chainName, version: 'v3' as const,
      factoryAddress: deployment.factoryAddress, positionManagerAddress: deployment.positionManagerAddress,
      deploymentBlock: deployment.deploymentBlock.toString(), explorerUrl: deployment.explorerUrl,
    })),
    limitations: { stakedMasterChefPositions: false },
  },
} as const;

export function evmNetworkName(chainId: number): string {
  return INTEGRATION_CATALOG.evmRpc.networks.find((network) => network.chainId === chainId)?.name ?? `Chain ${chainId}`;
}

export function isEvmRpcProvider(value: string): value is EvmRpcProvider {
  return (EVM_RPC_PROVIDERS as readonly string[]).includes(value);
}
