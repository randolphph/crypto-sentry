import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';

import { BSC_PANCAKE_V3 } from '../src/adapters/pancake/pancake-v3-position-reader.js';
import { UniswapPoolReader } from '../src/adapters/uniswap/uniswap-pool-reader.js';
import { BSC_UNISWAP_V3 } from '../src/adapters/uniswap/uniswap-v3-position-reader.js';

const pool = '0x0000000000000000000000000000000000000030' as const;
const token0 = '0x0000000000000000000000000000000000000010' as const;
const token1 = '0x0000000000000000000000000000000000000020' as const;

function client(factory: string): PublicClient {
  return {
    getChainId: async () => 56,
    readContract: async (request: { functionName: string; address: string }) => {
      if (request.functionName === 'factory') return factory;
      if (request.functionName === 'token0') return token0;
      if (request.functionName === 'token1') return token1;
      if (request.functionName === 'fee') return 2_500;
      if (request.functionName === 'tickSpacing') return 50;
      if (request.functionName === 'symbol') return request.address.toLowerCase() === token0.toLowerCase() ? 'USDT' : 'WBNB';
      if (request.functionName === 'decimals') return 18;
      throw new Error(`Unexpected function ${request.functionName}`);
    },
  } as unknown as PublicClient;
}

describe('PancakeSwap V3 pool identity validation', () => {
  it('accepts a pool created by the official BSC factory', async () => {
    const reader = new UniswapPoolReader({
      rpcUrl: 'https://bsc.example', expectedChainId: 56, publicClient: client(BSC_PANCAKE_V3.factoryAddress),
      expectedV3FactoryAddress: BSC_PANCAKE_V3.factoryAddress,
    });
    await expect(reader.describeV3(pool)).resolves.toMatchObject({
      chainId: 56, poolAddress: pool, token0Symbol: 'USDT', token1Symbol: 'WBNB', feeTier: 2_500,
    });
  });

  it('rejects a pool from another factory', async () => {
    const reader = new UniswapPoolReader({
      rpcUrl: 'https://bsc.example', expectedChainId: 56,
      publicClient: client('0x0000000000000000000000000000000000000099'),
      expectedV3FactoryAddress: BSC_PANCAKE_V3.factoryAddress,
    });
    await expect(reader.describeV3(pool)).rejects.toThrow('expected protocol factory');
  });

  it('keeps Uniswap V3 and PancakeSwap V3 pools separate on BNB Chain', async () => {
    const uniswapReader = new UniswapPoolReader({
      rpcUrl: 'https://bsc.example', expectedChainId: 56,
      publicClient: client(BSC_UNISWAP_V3.factoryAddress),
      expectedV3FactoryAddress: BSC_UNISWAP_V3.factoryAddress,
    });
    await expect(uniswapReader.describeV3(pool)).resolves.toMatchObject({ chainId: 56, poolAddress: pool });

    const pancakePoolAsUniswap = new UniswapPoolReader({
      rpcUrl: 'https://bsc.example', expectedChainId: 56,
      publicClient: client(BSC_PANCAKE_V3.factoryAddress),
      expectedV3FactoryAddress: BSC_UNISWAP_V3.factoryAddress,
    });
    await expect(pancakePoolAsUniswap.describeV3(pool)).rejects.toThrow('expected protocol factory');
  });
});
