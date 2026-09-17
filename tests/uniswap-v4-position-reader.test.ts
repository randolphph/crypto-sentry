import { describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';

import {
  ROBINHOOD_UNISWAP_V4,
  UniswapV4PositionReader,
} from '../src/adapters/uniswap/uniswap-v4-position-reader.js';

const owner = '0x0000000000000000000000000000000000001234';
const weth = '0x0000000000000000000000000000000000000020';
const zero = '0x0000000000000000000000000000000000000000';

describe('UniswapV4PositionReader', () => {
  it('reads pool key, packed ticks, hooks, liquidity, and slot0 at one block', async () => {
    const tickLower = -120;
    const tickUpper = 180;
    const packedInfo = (BigInt.asUintN(24, BigInt(tickLower)) << 8n)
      | (BigInt.asUintN(24, BigInt(tickUpper)) << 32n);
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'ownerOf') return owner;
      if (functionName === 'getPoolAndPositionInfo') {
        return [{ currency0: zero, currency1: weth, fee: 3_000, tickSpacing: 60, hooks: zero }, packedInfo] as const;
      }
      if (functionName === 'getPositionLiquidity') return 1_000_000n;
      if (functionName === 'getSlot0') return [2n ** 96n, 10, 5, 3_000] as const;
      if (functionName === 'symbol') return 'WETH';
      if (functionName === 'decimals') return 18;
      throw new Error(`Unexpected function: ${functionName}`);
    });
    const publicClient = {
      getChainId: vi.fn(async () => 4_663),
      getBlockNumber: vi.fn(async () => 54_321n),
      readContract,
    } as unknown as PublicClient;
    const reader = new UniswapV4PositionReader({
      rpcUrl: 'https://rpc.example',
      expectedChainId: 4_663,
      publicClient,
    });

    const position = await reader.read('9');
    expect(position).toMatchObject({
      version: 'v4',
      chainId: 4_663,
      blockNumber: '54321',
      tokenId: '9',
      owner,
      positionManagerAddress: ROBINHOOD_UNISWAP_V4.positionManagerAddress,
      poolManagerAddress: ROBINHOOD_UNISWAP_V4.poolManagerAddress,
      stateViewAddress: ROBINHOOD_UNISWAP_V4.stateViewAddress,
      token0: { symbol: 'ETH', decimals: 18, native: true },
      token1: { symbol: 'WETH', decimals: 18, native: false },
      feeTier: 3_000,
      lpFee: 3_000,
      protocolFee: 5,
      tickSpacing: 60,
      hooks: zero,
      tickLower,
      tickUpper,
      currentTick: 10,
      liquidity: '1000000',
      inRange: true,
    });
    expect(position.poolId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(readContract).toHaveBeenCalledTimes(6);
    for (const [parameters] of readContract.mock.calls) {
      expect(parameters).toEqual(expect.objectContaining({ blockNumber: 54_321n }));
    }

    await Promise.all([
      reader.read('9', undefined, 54_321n),
      reader.read('9', undefined, 54_321n),
    ]);
    expect(publicClient.getChainId).toHaveBeenCalledTimes(1);
    // Same-token reads are coalesced when two monitors reach the same block.
    expect(readContract).toHaveBeenCalledTimes(6);
  });
});
