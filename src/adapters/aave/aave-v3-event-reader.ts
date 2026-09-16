import { Decimal } from 'decimal.js';
import { getAddress, parseAbi } from 'viem';
import type { Address, PublicClient } from 'viem';

import { createEvmPublicClient } from '../evm/evm-rpc-client.js';
import { supportedAaveV3Markets } from './aave-v3-position-reader.js';

const eventAbi = parseAbi([
  'event Supply(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referralCode)',
  'event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)',
  'event Borrow(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint8 interestRateMode,uint256 borrowRate,uint16 indexed referralCode)',
  'event Repay(address indexed reserve,address indexed user,address indexed repayer,uint256 amount,bool useATokens)',
  'event LiquidationCall(address indexed collateralAsset,address indexed debtAsset,address indexed user,uint256 debtToCover,uint256 liquidatedCollateralAmount,address liquidator,bool receiveAToken)',
]);
const oracleAbi = [
  { type: 'function', name: 'BASE_CURRENCY_UNIT', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getAssetPrice', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export type AaveEventType = 'supply' | 'withdraw' | 'borrow' | 'repay' | 'liquidation';

export interface AaveV3ChainEvent {
  eventId: string;
  eventType: AaveEventType;
  chainId: 1;
  blockNumber: string;
  transactionHash: string;
  logIndex: number;
  observedAt: string;
  reserveAssetAddress: Address;
  symbol: string;
  tokenAmount: string;
  usdAmount: string | null;
  valuationStatus: 'ok' | 'unavailable' | 'error';
  user: Address | null;
  onBehalfOf: Address | null;
  repayer: Address | null;
  to: Address | null;
  liquidator: Address | null;
  collateralAssetAddress: Address | null;
  collateralSymbol: string | null;
  collateralTokenAmount: string | null;
  collateralUsdAmount: string | null;
}

export interface AaveV3EventReaderOptions {
  rpcUrl: string;
  headers?: Record<string, string>;
  expectedChainId: number;
  timeoutMilliseconds?: number;
  fetch?: typeof globalThis.fetch;
  publicClient?: PublicClient;
}

function tokenAmount(value: bigint, decimals: number): string {
  return new Decimal(value.toString()).div(new Decimal(10).pow(decimals)).toSignificantDigits(30).toString();
}

function addressArgument(args: Record<string, unknown>, name: string): Address | null {
  const value = args[name];
  return typeof value === 'string' ? getAddress(value) : null;
}

export class AaveV3EventReader {
  private readonly publicClient: PublicClient;
  private readonly blockTimestampCache = new Map<bigint, string>();

  public constructor(private readonly options: AaveV3EventReaderOptions) {
    this.publicClient = options.publicClient ?? createEvmPublicClient(options);
  }

  public async latestBlock(signal?: AbortSignal): Promise<bigint> {
    signal?.throwIfAborted();
    return this.publicClient.getBlockNumber({ cacheTime: 0 });
  }

  public async scan(fromBlock: bigint, toBlock: bigint, signal?: AbortSignal): Promise<AaveV3ChainEvent[]> {
    const market = supportedAaveV3Markets.get(this.options.expectedChainId);
    if (market === undefined || market.chainId !== 1) throw new Error('Aave V3 events are only available on Ethereum');
    signal?.throwIfAborted();
    const [logs, baseUnit] = await Promise.all([
      this.publicClient.getLogs({ address: market.poolAddress, events: eventAbi, fromBlock, toBlock }),
      this.publicClient.readContract({ address: market.oracleAddress, abi: oracleAbi, functionName: 'BASE_CURRENCY_UNIT', blockNumber: toBlock }),
    ]);
    const blockNumbers = [...new Set(logs.flatMap((log) => log.blockNumber === null ? [] : [log.blockNumber]))];
    for (let offset = 0; offset < blockNumbers.length; offset += 8) {
      await Promise.all(blockNumbers.slice(offset, offset + 8).map(async (blockNumber) => {
        if (this.blockTimestampCache.has(blockNumber)) return;
        const block = await this.publicClient.getBlock({ blockNumber });
        this.blockTimestampCache.set(blockNumber, new Date(Number(block.timestamp) * 1_000).toISOString());
      }));
    }
    const assets = new Map(market.assets.map((asset) => [asset.underlyingAddress.toLowerCase(), asset]));
    const eventAssets = new Set<Address>();
    for (const log of logs) {
      const args = log.args as Record<string, unknown>;
      for (const name of ['reserve', 'debtAsset', 'collateralAsset']) {
        const address = addressArgument(args, name);
        if (address !== null) eventAssets.add(address);
      }
    }
    const priceEntries = await Promise.all([...eventAssets].map(async (address) => {
      try {
        const price = await this.publicClient.readContract({
          address: market.oracleAddress, abi: oracleAbi, functionName: 'getAssetPrice', args: [address], blockNumber: toBlock,
        });
        return [address.toLowerCase(), price] as const;
      } catch {
        return [address.toLowerCase(), null] as const;
      }
    }));
    const prices = new Map(priceEntries);
    return logs.flatMap((log): AaveV3ChainEvent[] => {
      if (log.transactionHash === null || log.logIndex === null || log.eventName === undefined || log.blockNumber === null) return [];
      const args = log.args as Record<string, unknown>;
      const eventType = log.eventName === 'LiquidationCall' ? 'liquidation' : log.eventName.toLowerCase() as AaveEventType;
      const reserve = addressArgument(args, eventType === 'liquidation' ? 'debtAsset' : 'reserve');
      if (reserve === null) return [];
      const asset = assets.get(reserve.toLowerCase());
      if (asset === undefined) return [];
      const rawAmount = args[eventType === 'liquidation' ? 'debtToCover' : 'amount'];
      if (typeof rawAmount !== 'bigint') return [];
      const formatted = tokenAmount(rawAmount, asset.decimals);
      const price = prices.get(reserve.toLowerCase());
      const usdAmount = price === null || price === undefined ? null : new Decimal(formatted)
        .mul(price.toString()).div(baseUnit.toString()).toSignificantDigits(30).toString();
      const collateralAddress = eventType === 'liquidation' ? addressArgument(args, 'collateralAsset') : null;
      const collateralAsset = collateralAddress === null ? undefined : assets.get(collateralAddress.toLowerCase());
      const collateralRaw = args.liquidatedCollateralAmount;
      const collateralAmount = collateralAsset !== undefined && typeof collateralRaw === 'bigint'
        ? tokenAmount(collateralRaw, collateralAsset.decimals) : null;
      const collateralPrice = collateralAddress === null ? undefined : prices.get(collateralAddress.toLowerCase());
      const collateralUsd = collateralAmount === null || collateralPrice === null || collateralPrice === undefined
        ? null : new Decimal(collateralAmount).mul(collateralPrice.toString()).div(baseUnit.toString()).toSignificantDigits(30).toString();
      return [{
        eventId: `1:${log.transactionHash}:${log.logIndex}`,
        eventType,
        chainId: 1,
        blockNumber: String(log.blockNumber),
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        observedAt: this.blockTimestampCache.get(log.blockNumber) as string,
        reserveAssetAddress: reserve,
        symbol: asset.symbol,
        tokenAmount: formatted,
        usdAmount,
        valuationStatus: usdAmount === null ? 'unavailable' : 'ok',
        user: addressArgument(args, 'user'),
        onBehalfOf: addressArgument(args, 'onBehalfOf'),
        repayer: addressArgument(args, 'repayer'),
        to: addressArgument(args, 'to'),
        liquidator: addressArgument(args, 'liquidator'),
        collateralAssetAddress: collateralAddress,
        collateralSymbol: collateralAsset?.symbol ?? null,
        collateralTokenAmount: collateralAmount,
        collateralUsdAmount: collateralUsd,
      }];
    });
  }
}
