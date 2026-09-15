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
    ],
    configDefaults: {
      timeoutMilliseconds: 5_000,
      multicallBatchSizeBytes: 8_192,
    },
  },
} as const;

export function isEvmRpcProvider(value: string): value is EvmRpcProvider {
  return (EVM_RPC_PROVIDERS as readonly string[]).includes(value);
}
