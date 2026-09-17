import { describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';

import {
  ROBINHOOD_UNISWAP_V3,
  UniswapV3PositionReader,
} from '../src/adapters/uniswap/uniswap-v3-position-reader.js';

const owner = '0x0000000000000000000000000000000000001234';
const token0 = '0x0000000000000000000000000000000000000010';
const token1 = '0x0000000000000000000000000000000000000020';
const pool = '0x0000000000000000000000000000000000000030';

describe('UniswapV3PositionReader', () => {
  it('discovers every V3 NFT owned by a wallet at one block', async () => {
    const readContract = vi.fn(async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName === 'balanceOf') return 2n;
      if (functionName === 'tokenOfOwnerByIndex') return (args[1] as bigint) === 0n ? 42n : 77n;
      throw new Error(`Unexpected function: ${functionName}`);
    });
    const publicClient = {
      getChainId: vi.fn(async () => 4_663),
      getBlockNumber: vi.fn(async () => 54_321n),
      readContract,
    } as unknown as PublicClient;
    const reader = new UniswapV3PositionReader({
      rpcUrl: 'https://rpc.example',
      expectedChainId: 4_663,
      publicClient,
    });

    await expect(reader.discover(owner)).resolves.toEqual({
      blockNumber: 54_321n,
      tokenIds: ['42', '77'],
    });
    expect(readContract).toHaveBeenCalledTimes(3);
    for (const [parameters] of readContract.mock.calls) {
      expect(parameters).toEqual(expect.objectContaining({ blockNumber: 54_321n }));
    }
  });

  it('batches token ids and reuses ownership discovery during the cache TTL', async () => {
    let now = 1_000;
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'balanceOf') return 2n;
      throw new Error(`Unexpected function: ${functionName}`);
    });
    const multicall = vi.fn(async () => [42n, 77n]);
    const publicClient = {
      getChainId: vi.fn(async () => 4_663),
      getBlockNumber: vi.fn(async () => 54_321n),
      readContract,
      multicall,
    } as unknown as PublicClient;
    const reader = new UniswapV3PositionReader({
      rpcUrl: 'https://rpc.example',
      expectedChainId: 4_663,
      publicClient,
      tokenIdCacheTtlMilliseconds: 300_000,
      now: () => now,
    });

    await expect(reader.discover(owner)).resolves.toEqual({ blockNumber: 54_321n, tokenIds: ['42', '77'] });
    now += 20_000;
    await expect(reader.discover(owner)).resolves.toEqual({ blockNumber: 54_321n, tokenIds: ['42', '77'] });
    expect(multicall).toHaveBeenCalledOnce();
    expect(readContract).toHaveBeenCalledOnce();
    expect(multicall).toHaveBeenCalledWith(expect.objectContaining({
      blockNumber: 54_321n,
      multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
      contracts: expect.any(Array) as unknown,
    }));

    now += 300_000;
    await reader.discover(owner);
    expect(multicall).toHaveBeenCalledTimes(2);
    expect(readContract).toHaveBeenCalledTimes(2);
  });

  it('reads a Robinhood Chain V3 NFT position at one fixed block', async () => {
    const readContract = vi.fn(async ({ functionName, address }: { functionName: string; address: string }) => {
      if (functionName === 'ownerOf') return owner;
      if (functionName === 'positions') {
        return [0n, owner, token0, token1, 500, -100, 100, 1_000_000n, 0n, 0n, 1_500_000n, 2_000_000_000_000_000_000n] as const;
      }
      if (functionName === 'getPool') return pool;
      if (functionName === 'slot0') return [2n ** 96n, 0, 0, 0, 0, 0, true] as const;
      if (functionName === 'decimals') return address.toLowerCase() === token0.toLowerCase() ? 6 : 18;
      if (functionName === 'symbol') return address.toLowerCase() === token0.toLowerCase() ? 'USDG' : 'WETH';
      throw new Error(`Unexpected function: ${functionName}`);
    });
    const publicClient = {
      getChainId: vi.fn(async () => 4_663),
      getBlockNumber: vi.fn(async () => 54_321n),
      readContract,
    } as unknown as PublicClient;
    const reader = new UniswapV3PositionReader({
      rpcUrl: 'https://rpc.example',
      expectedChainId: 4_663,
      publicClient,
    });

    await expect(reader.read('42')).resolves.toEqual({
      protocol: 'uniswap',
      version: 'v3',
      chainId: 4_663,
      chainName: 'Robinhood Chain',
      blockNumber: '54321',
      tokenId: '42',
      owner,
      positionManagerAddress: ROBINHOOD_UNISWAP_V3.positionManagerAddress,
      poolAddress: pool,
      token0: { address: token0, symbol: 'USDG', decimals: 6 },
      token1: { address: token1, symbol: 'WETH', decimals: 18 },
      feeTier: 500,
      tickLower: -100,
      tickUpper: 100,
      currentTick: 0,
      liquidity: '1000000',
      inRange: true,
      tokensOwed0: '1.5',
      tokensOwed1: '2',
    });
    expect(readContract).toHaveBeenCalledTimes(8);
    for (const [parameters] of readContract.mock.calls) {
      expect(parameters).toEqual(expect.objectContaining({ blockNumber: 54_321n }));
    }

    await Promise.all([
      reader.read('42', undefined, 54_321n),
      reader.read('42', undefined, 54_321n),
    ]);
    expect(publicClient.getChainId).toHaveBeenCalledTimes(1);
    // Two monitors consuming the same wallet/token share the current block result.
    expect(readContract).toHaveBeenCalledTimes(8);
  });

  it('rejects a mismatched RPC network', async () => {
    const publicClient = {
      getChainId: vi.fn(async () => 1),
    } as unknown as PublicClient;
    const reader = new UniswapV3PositionReader({
      rpcUrl: 'https://rpc.example',
      expectedChainId: 4_663,
      publicClient,
    });

    await expect(reader.read('42')).rejects.toThrow('expected 4663, received 1');
  });
});
