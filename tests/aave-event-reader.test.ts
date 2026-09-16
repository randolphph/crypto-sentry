import { describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';

import { AaveV3EventReader } from '../src/adapters/aave/aave-v3-event-reader.js';
import { supportedAaveV3Markets } from '../src/adapters/aave/aave-v3-position-reader.js';

describe('AaveV3EventReader event timestamps', () => {
  it('uses each event block timestamp and caches repeated block reads', async () => {
    const reserve = supportedAaveV3Markets.get(1)?.assets[0];
    if (reserve === undefined) throw new Error('Missing reserve fixture');
    const log = (blockNumber: bigint, index: number) => ({
      blockNumber, transactionHash: `0x${String(index + 1).padStart(64, '0')}`, logIndex: index,
      eventName: 'Supply', args: {
        reserve: reserve.underlyingAddress,
        user: '0x0000000000000000000000000000000000001234',
        onBehalfOf: '0x0000000000000000000000000000000000001234', amount: 1_000_000n,
      },
    });
    const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
      timestamp: blockNumber === 10n ? 1_000n : 2_000n,
    }));
    const publicClient = {
      getLogs: vi.fn(async () => [log(10n, 0), log(10n, 1), log(11n, 2)]),
      getBlock,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => (
        functionName === 'BASE_CURRENCY_UNIT' ? 100_000_000n : 100_000_000n
      )),
    } as unknown as PublicClient;
    const reader = new AaveV3EventReader({ rpcUrl: 'https://rpc.invalid', expectedChainId: 1, publicClient });

    const first = await reader.scan(10n, 11n);
    const second = await reader.scan(10n, 11n);

    expect(first.map((event) => event.observedAt)).toEqual([
      '1970-01-01T00:16:40.000Z', '1970-01-01T00:16:40.000Z', '1970-01-01T00:33:20.000Z',
    ]);
    expect(second.map((event) => event.observedAt)).toEqual(first.map((event) => event.observedAt));
    expect(getBlock).toHaveBeenCalledTimes(2);
  });
});
