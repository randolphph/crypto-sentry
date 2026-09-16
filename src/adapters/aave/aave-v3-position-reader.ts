import {
  AaveV3Arbitrum,
  AaveV3Base,
  AaveV3BNB,
  AaveV3Ethereum,
} from '@aave-dao/aave-address-book';
import { Decimal } from 'decimal.js';
import { getAddress } from 'viem';
import type { Address, PublicClient } from 'viem';

import { createEvmPublicClient } from '../evm/evm-rpc-client.js';

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;

const poolAbi = [{
  type: 'function',
  name: 'getUserAccountData',
  stateMutability: 'view',
  inputs: [{ name: 'user', type: 'address' }],
  outputs: [
    { name: 'totalCollateralBase', type: 'uint256' },
    { name: 'totalDebtBase', type: 'uint256' },
    { name: 'availableBorrowsBase', type: 'uint256' },
    { name: 'currentLiquidationThreshold', type: 'uint256' },
    { name: 'ltv', type: 'uint256' },
    { name: 'healthFactor', type: 'uint256' },
  ],
}] as const;

const dataProviderAbi = [{
  type: 'function',
  name: 'getUserReserveData',
  stateMutability: 'view',
  inputs: [
    { name: 'asset', type: 'address' },
    { name: 'user', type: 'address' },
  ],
  outputs: [
    { name: 'currentATokenBalance', type: 'uint256' },
    { name: 'currentStableDebt', type: 'uint256' },
    { name: 'currentVariableDebt', type: 'uint256' },
    { name: 'principalStableDebt', type: 'uint256' },
    { name: 'scaledVariableDebt', type: 'uint256' },
    { name: 'stableBorrowRate', type: 'uint256' },
    { name: 'liquidityRate', type: 'uint256' },
    { name: 'stableRateLastUpdated', type: 'uint40' },
    { name: 'usageAsCollateralEnabled', type: 'bool' },
  ],
}] as const;

const oracleAbi = [
  {
    type: 'function',
    name: 'BASE_CURRENCY_UNIT',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getAssetPrice',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

interface AddressBookAsset {
  decimals: number;
  UNDERLYING: string;
  A_TOKEN?: string;
  S_TOKEN?: string;
  V_TOKEN?: string;
}

export interface AaveV3Asset {
  symbol: string;
  decimals: number;
  underlyingAddress: Address;
  aTokenAddress?: Address | null;
  stableDebtTokenAddress?: Address | null;
  variableDebtTokenAddress?: Address | null;
}

export interface AaveV3Market {
  chainId: number;
  chainName: string;
  poolAddress: Address;
  poolAddressesProviderAddress: Address;
  dataProviderAddress: Address;
  oracleAddress: Address;
  baseCurrencySymbol: string;
  assets: AaveV3Asset[];
}

export interface AaveV3AssetPosition extends AaveV3Asset {
  supplied: string;
  stableDebt: string;
  variableDebt: string;
  totalDebt: string;
  suppliedBase: string;
  debtBase: string;
  usageAsCollateralEnabled: boolean;
}

export interface AaveV3Position {
  chainId: number;
  chainName: string;
  blockNumber: string;
  walletAddress: Address;
  baseCurrencySymbol: string;
  totalCollateralBase: string;
  totalDebtBase: string;
  availableBorrowsBase: string;
  liquidationThresholdPercent: string;
  ltvPercent: string;
  healthFactor: string;
  assets: AaveV3AssetPosition[];
}

type AddressBookMarket = {
  CHAIN_ID: number;
  POOL: string;
  AAVE_PROTOCOL_DATA_PROVIDER: string;
  ORACLE: string;
  ASSETS: Record<string, AddressBookAsset>;
  POOL_ADDRESSES_PROVIDER: string;
};

function marketFromAddressBook(chainName: string, market: AddressBookMarket): AaveV3Market {
  return {
    chainId: market.CHAIN_ID,
    chainName,
    poolAddress: getAddress(market.POOL),
    poolAddressesProviderAddress: getAddress(market.POOL_ADDRESSES_PROVIDER),
    dataProviderAddress: getAddress(market.AAVE_PROTOCOL_DATA_PROVIDER),
    oracleAddress: getAddress(market.ORACLE),
    baseCurrencySymbol: 'USD',
    assets: Object.entries(market.ASSETS).map(([symbol, asset]) => ({
      symbol,
      decimals: asset.decimals,
      underlyingAddress: getAddress(asset.UNDERLYING),
      aTokenAddress: asset.A_TOKEN === undefined ? null : getAddress(asset.A_TOKEN),
      stableDebtTokenAddress: asset.S_TOKEN === undefined ? null : getAddress(asset.S_TOKEN),
      variableDebtTokenAddress: asset.V_TOKEN === undefined ? null : getAddress(asset.V_TOKEN),
    })),
  };
}

export const supportedAaveV3Markets = new Map<number, AaveV3Market>([
  marketFromAddressBook('Ethereum', AaveV3Ethereum),
  marketFromAddressBook('Arbitrum', AaveV3Arbitrum),
  marketFromAddressBook('Base', AaveV3Base),
  marketFromAddressBook('BNB Chain', AaveV3BNB),
].map((market) => [market.chainId, market]));

function decimalRatio(value: bigint, divisor: bigint): string {
  return new Decimal(value.toString()).div(divisor.toString()).toSignificantDigits(30).toString();
}

function tokenAmount(value: bigint, decimals: number): string {
  return new Decimal(value.toString()).div(new Decimal(10).pow(decimals)).toSignificantDigits(30).toString();
}

function assetBaseValue(value: bigint, price: bigint, decimals: number, baseCurrencyUnit: bigint): string {
  return new Decimal(value.toString())
    .mul(price.toString())
    .div(new Decimal(10).pow(decimals))
    .div(baseCurrencyUnit.toString())
    .toSignificantDigits(30)
    .toString();
}

export interface AaveV3PositionReaderOptions {
  rpcUrl: string;
  expectedChainId: number;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  timeoutMilliseconds?: number;
  multicallBatchSizeBytes?: number;
  publicClient?: PublicClient;
}

export class AaveV3PositionReader {
  private readonly publicClient: PublicClient;

  public constructor(private readonly options: AaveV3PositionReaderOptions) {
    this.publicClient = options.publicClient ?? createEvmPublicClient(options);
  }

  public async read(walletAddress: string, signal?: AbortSignal): Promise<AaveV3Position | undefined> {
    const market = supportedAaveV3Markets.get(this.options.expectedChainId);
    if (market === undefined) throw new Error(`Aave V3 is not supported on chain ${this.options.expectedChainId}`);
    const wallet = getAddress(walletAddress);
    const chainId = await this.publicClient.getChainId();
    if (chainId !== market.chainId) {
      throw new Error(`EVM RPC chain ID mismatch: expected ${market.chainId}, received ${chainId}`);
    }
    signal?.throwIfAborted();
    const blockNumber = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    signal?.throwIfAborted();

    const [accountData, baseCurrencyUnit] = await Promise.all([
      this.publicClient.readContract({
        address: market.poolAddress,
        abi: poolAbi,
        functionName: 'getUserAccountData',
        args: [wallet],
        blockNumber,
      }),
      this.publicClient.readContract({
        address: market.oracleAddress,
        abi: oracleAbi,
        functionName: 'BASE_CURRENCY_UNIT',
        blockNumber,
      }),
    ]);
    signal?.throwIfAborted();

    const [
      totalCollateralBase,
      totalDebtBase,
      availableBorrowsBase,
      currentLiquidationThreshold,
      ltv,
      healthFactor,
    ] = accountData;
    if (totalCollateralBase === 0n && totalDebtBase === 0n) return undefined;

    const contracts = market.assets.flatMap((asset) => [
      {
        address: market.dataProviderAddress,
        abi: dataProviderAbi,
        functionName: 'getUserReserveData' as const,
        args: [asset.underlyingAddress, wallet] as const,
      },
      {
        address: market.oracleAddress,
        abi: oracleAbi,
        functionName: 'getAssetPrice' as const,
        args: [asset.underlyingAddress] as const,
      },
    ]);
    const results = await this.publicClient.multicall({
      allowFailure: true,
      batchSize: this.options.multicallBatchSizeBytes ?? 8_192,
      blockNumber,
      contracts,
      multicallAddress: MULTICALL3_ADDRESS,
    });
    signal?.throwIfAborted();

    const assets: AaveV3AssetPosition[] = [];
    for (const [index, asset] of market.assets.entries()) {
      const reserveResult = results[index * 2];
      const priceResult = results[index * 2 + 1];
      if (reserveResult?.status !== 'success' || priceResult?.status !== 'success') continue;
      const reserveData = reserveResult.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, boolean];
      const price = priceResult.result as bigint;
      const [supplied, stableDebt, variableDebt, , , , , , usageAsCollateralEnabled] = reserveData;
      const totalAssetDebt = stableDebt + variableDebt;
      if (supplied === 0n && totalAssetDebt === 0n) continue;
      assets.push({
        ...asset,
        supplied: tokenAmount(supplied, asset.decimals),
        stableDebt: tokenAmount(stableDebt, asset.decimals),
        variableDebt: tokenAmount(variableDebt, asset.decimals),
        totalDebt: tokenAmount(totalAssetDebt, asset.decimals),
        suppliedBase: assetBaseValue(supplied, price, asset.decimals, baseCurrencyUnit),
        debtBase: assetBaseValue(totalAssetDebt, price, asset.decimals, baseCurrencyUnit),
        usageAsCollateralEnabled,
      });
    }

    return {
      chainId: market.chainId,
      chainName: market.chainName,
      blockNumber: blockNumber.toString(),
      walletAddress: wallet,
      baseCurrencySymbol: market.baseCurrencySymbol,
      totalCollateralBase: decimalRatio(totalCollateralBase, baseCurrencyUnit),
      totalDebtBase: decimalRatio(totalDebtBase, baseCurrencyUnit),
      availableBorrowsBase: decimalRatio(availableBorrowsBase, baseCurrencyUnit),
      liquidationThresholdPercent: decimalRatio(currentLiquidationThreshold, 100n),
      ltvPercent: decimalRatio(ltv, 100n),
      healthFactor: decimalRatio(healthFactor, 10n ** 18n),
      assets,
    };
  }
}
