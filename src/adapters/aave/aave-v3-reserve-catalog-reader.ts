import { Decimal } from 'decimal.js';
import type { Address, PublicClient } from 'viem';

import { createEvmPublicClient } from '../evm/evm-rpc-client.js';
import { supportedAaveV3Markets } from './aave-v3-position-reader.js';

const configurationAbi = [{
  type: 'function', name: 'getReserveConfigurationData', stateMutability: 'view',
  inputs: [{ name: 'asset', type: 'address' }],
  outputs: [
    { name: 'decimals', type: 'uint256' }, { name: 'ltv', type: 'uint256' },
    { name: 'liquidationThreshold', type: 'uint256' }, { name: 'liquidationBonus', type: 'uint256' },
    { name: 'reserveFactor', type: 'uint256' }, { name: 'usageAsCollateralEnabled', type: 'bool' },
    { name: 'borrowingEnabled', type: 'bool' }, { name: 'stableBorrowRateEnabled', type: 'bool' },
    { name: 'isActive', type: 'bool' }, { name: 'isFrozen', type: 'bool' },
  ],
}] as const;
const oracleAbi = [
  { type: 'function', name: 'BASE_CURRENCY_UNIT', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getAssetPrice', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
const erc20Abi = [{ type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }] as const;

export interface AaveReserveCatalogItem {
  underlyingAsset: Address;
  symbol: string;
  name: string | null;
  decimals: number;
  aTokenAddress: Address | null;
  stableDebtTokenAddress: Address | null;
  variableDebtTokenAddress: Address | null;
  active: boolean;
  frozen: boolean;
  borrowingEnabled: boolean;
  usageAsCollateralEnabled: boolean;
  priceUsd: string | null;
  priceStatus: 'ok' | 'error';
  metadataStatus: 'ok' | 'partial';
}

export interface AaveReserveCatalog {
  chainId: 1;
  chainName: 'Ethereum';
  protocol: 'aave';
  version: 'v3';
  poolAddress: Address;
  poolAddressesProviderAddress: Address;
  items: AaveReserveCatalogItem[];
  blockNumber: string;
  observedAt: string;
  status: 'ok' | 'partial';
  error: null | { code: 'INDEXER_PARTIAL_FAILURE'; message: string };
}

export interface AaveReserveCatalogReaderOptions {
  rpcUrl: string;
  headers?: Record<string, string>;
  expectedChainId: number;
  timeoutMilliseconds?: number;
  fetch?: typeof globalThis.fetch;
  publicClient?: PublicClient;
  now?: () => Date;
}

export class AaveV3ReserveCatalogReader {
  private readonly publicClient: PublicClient;
  private readonly now: () => Date;

  public constructor(private readonly options: AaveReserveCatalogReaderOptions) {
    this.publicClient = options.publicClient ?? createEvmPublicClient(options);
    this.now = options.now ?? (() => new Date());
  }

  public async read(signal?: AbortSignal): Promise<AaveReserveCatalog> {
    const market = supportedAaveV3Markets.get(this.options.expectedChainId);
    if (market === undefined || market.chainId !== 1) throw new Error('Aave V3 reserve catalog is only available on Ethereum');
    const chainId = await this.publicClient.getChainId();
    if (chainId !== 1) throw new Error(`EVM RPC chain ID mismatch: expected 1, received ${chainId}`);
    signal?.throwIfAborted();
    const blockNumber = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    const baseUnit = await this.publicClient.readContract({
      address: market.oracleAddress, abi: oracleAbi, functionName: 'BASE_CURRENCY_UNIT', blockNumber,
    });
    const contracts = market.assets.flatMap((asset) => [
      { address: market.dataProviderAddress, abi: configurationAbi, functionName: 'getReserveConfigurationData' as const, args: [asset.underlyingAddress] as const },
      { address: market.oracleAddress, abi: oracleAbi, functionName: 'getAssetPrice' as const, args: [asset.underlyingAddress] as const },
      { address: asset.underlyingAddress, abi: erc20Abi, functionName: 'name' as const },
    ]);
    const results = await this.publicClient.multicall({ contracts, allowFailure: true, blockNumber });
    signal?.throwIfAborted();
    let partial = false;
    const items = market.assets.map((asset, index): AaveReserveCatalogItem => {
      const configuration = results[index * 3];
      const price = results[index * 3 + 1];
      const name = results[index * 3 + 2];
      if (configuration?.status !== 'success') partial = true;
      if (price?.status !== 'success') partial = true;
      if (name?.status !== 'success') partial = true;
      const config = configuration?.status === 'success'
        ? configuration.result as readonly [bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean]
        : undefined;
      return {
        underlyingAsset: asset.underlyingAddress,
        symbol: asset.symbol,
        name: name?.status === 'success' ? String(name.result) : null,
        decimals: asset.decimals,
        aTokenAddress: asset.aTokenAddress ?? null,
        stableDebtTokenAddress: asset.stableDebtTokenAddress ?? null,
        variableDebtTokenAddress: asset.variableDebtTokenAddress ?? null,
        active: config?.[8] ?? false,
        frozen: config?.[9] ?? false,
        borrowingEnabled: config?.[6] ?? false,
        usageAsCollateralEnabled: config?.[5] ?? false,
        priceUsd: price?.status === 'success'
          ? new Decimal(String(price.result)).div(String(baseUnit)).toSignificantDigits(30).toString()
          : null,
        priceStatus: price?.status === 'success' ? 'ok' : 'error',
        metadataStatus: name?.status === 'success' && configuration?.status === 'success' ? 'ok' : 'partial',
      };
    });
    return {
      chainId: 1, chainName: 'Ethereum', protocol: 'aave', version: 'v3',
      poolAddress: market.poolAddress, poolAddressesProviderAddress: market.poolAddressesProviderAddress,
      items, blockNumber: blockNumber.toString(), observedAt: this.now().toISOString(),
      status: partial ? 'partial' : 'ok',
      error: partial ? { code: 'INDEXER_PARTIAL_FAILURE', message: 'Some reserve metadata or prices could not be read' } : null,
    };
  }
}
