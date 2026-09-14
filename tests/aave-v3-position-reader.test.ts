import { describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';

import {
  AaveV3PositionReader,
  supportedAaveV3Markets,
} from '../src/adapters/aave/aave-v3-position-reader.js';

const walletAddress = '0x0000000000000000000000000000000000001234';

function reserveData(
  supplied: bigint,
  stableDebt: bigint,
  variableDebt: bigint,
  collateralEnabled = true,
) {
  return [supplied, stableDebt, variableDebt, 0n, 0n, 0n, 0n, 0, collateralEnabled] as const;
}

describe('AaveV3PositionReader', () => {
  it('reads aggregate risk and per-asset balances using official market addresses', async () => {
    const market = supportedAaveV3Markets.get(1);
    expect(market).toBeDefined();
    const firstAsset = market?.assets[0];
    expect(firstAsset).toBeDefined();
    const multicall = vi.fn(async () => market?.assets.flatMap((_asset, index) => [
      { status: 'success', result: index === 0 ? reserveData(2n * 10n ** 18n, 10n ** 17n, 4n * 10n ** 17n) : reserveData(0n, 0n, 0n) },
      { status: 'success', result: index === 0 ? 2_000n * 10n ** 8n : 0n },
    ]));
    const publicClient = {
      getChainId: vi.fn(async () => 1),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'BASE_CURRENCY_UNIT') return 10n ** 8n;
        return [5_000n * 10n ** 8n, 1_000n * 10n ** 8n, 2_500n * 10n ** 8n, 8_250n, 7_500n, 15n * 10n ** 17n] as const;
      }),
      multicall,
    } as unknown as PublicClient;
    const reader = new AaveV3PositionReader({
      rpcUrl: 'https://rpc.example',
      expectedChainId: 1,
      publicClient,
    });

    await expect(reader.read(walletAddress)).resolves.toMatchObject({
      chainId: 1,
      chainName: 'Ethereum',
      totalCollateralBase: '5000',
      totalDebtBase: '1000',
      availableBorrowsBase: '2500',
      liquidationThresholdPercent: '82.5',
      ltvPercent: '75',
      healthFactor: '1.5',
      assets: [{
        symbol: firstAsset?.symbol,
        supplied: '2',
        stableDebt: '0.1',
        variableDebt: '0.4',
        totalDebt: '0.5',
        suppliedBase: '4000',
        debtBase: '1000',
        usageAsCollateralEnabled: true,
      }],
    });
    expect(multicall).toHaveBeenCalledOnce();
  });

  it('skips reserve calls when the address has no position on a chain', async () => {
    const multicall = vi.fn();
    const publicClient = {
      getChainId: vi.fn(async () => 8453),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'BASE_CURRENCY_UNIT') return 10n ** 8n;
        return [0n, 0n, 0n, 0n, 0n, 0n] as const;
      }),
      multicall,
    } as unknown as PublicClient;
    const reader = new AaveV3PositionReader({
      rpcUrl: 'https://rpc.example',
      expectedChainId: 8453,
      publicClient,
    });

    await expect(reader.read(walletAddress)).resolves.toBeUndefined();
    expect(multicall).not.toHaveBeenCalled();
  });
});
