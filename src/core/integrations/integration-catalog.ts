import { ROBINHOOD_UNISWAP_V3 } from '../../adapters/uniswap/uniswap-v3-position-reader.js';
import { ROBINHOOD_UNISWAP_V4 } from '../../adapters/uniswap/uniswap-v4-position-reader.js';

export const EVM_RPC_PROVIDERS = ['alchemy', 'infura', 'quicknode', 'custom'] as const;

export type EvmRpcProvider = (typeof EVM_RPC_PROVIDERS)[number];

export const BINANCE_DEFAULT_CONFIG = {
  restUrl: 'https://api.binance.com',
  futuresRestUrl: 'https://fapi.binance.com',
  spotWebsocketUrl: 'wss://stream.binance.com:9443',
  futuresWebsocketUrl: 'wss://fstream.binance.com/market',
} as const;

export const INTEGRATION_CATALOG = {
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
    networks: [
      { chainId: 1, name: 'Ethereum', protocols: ['aave_v3'] },
      { chainId: 42_161, name: 'Arbitrum', protocols: ['aave_v3'] },
      { chainId: 8_453, name: 'Base', protocols: ['aave_v3'] },
      { chainId: 56, name: 'BNB Chain', protocols: ['aave_v3'] },
      {
        chainId: ROBINHOOD_UNISWAP_V3.chainId,
        name: ROBINHOOD_UNISWAP_V3.chainName,
        protocols: ['uniswap_v3', 'uniswap_v4'],
        defaultRpcUrl: ROBINHOOD_UNISWAP_V3.rpcUrl,
        explorerUrl: ROBINHOOD_UNISWAP_V3.explorerUrl,
      },
    ],
    configDefaults: {
      timeoutMilliseconds: 5_000,
      multicallBatchSizeBytes: 8_192,
    },
  },
  uniswap: {
    deployments: [{
      chainId: ROBINHOOD_UNISWAP_V3.chainId,
      chainName: ROBINHOOD_UNISWAP_V3.chainName,
      version: 'v3',
      factoryAddress: ROBINHOOD_UNISWAP_V3.factoryAddress,
      positionManagerAddress: ROBINHOOD_UNISWAP_V3.positionManagerAddress,
      monitorInput: ['rpcIntegrationId', 'walletAddress'],
      legacyMonitorInput: ['rpcIntegrationId', 'tokenId'],
    }, {
      chainId: ROBINHOOD_UNISWAP_V4.chainId,
      chainName: ROBINHOOD_UNISWAP_V4.chainName,
      version: 'v4',
      poolManagerAddress: ROBINHOOD_UNISWAP_V4.poolManagerAddress,
      positionManagerAddress: ROBINHOOD_UNISWAP_V4.positionManagerAddress,
      stateViewAddress: ROBINHOOD_UNISWAP_V4.stateViewAddress,
      deploymentBlock: ROBINHOOD_UNISWAP_V4.deploymentBlock.toString(),
      monitorInput: ['rpcIntegrationId', 'walletAddress'],
      legacyMonitorInput: ['rpcIntegrationId', 'tokenId'],
    }],
  },
} as const;

export function isEvmRpcProvider(value: string): value is EvmRpcProvider {
  return (EVM_RPC_PROVIDERS as readonly string[]).includes(value);
}
