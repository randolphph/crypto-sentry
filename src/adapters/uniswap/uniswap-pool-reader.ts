import { Decimal } from 'decimal.js';
import { formatUnits, getAddress, parseAbi } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';

import { createEvmPublicClient } from '../evm/evm-rpc-client.js';
import { supportedUniswapV4Deployments } from './uniswap-v4-position-reader.js';

const v3Abi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)',
  'function liquidity() view returns (uint128)',
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
  'event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)',
  'event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)',
  'event Collect(address indexed owner,address recipient,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount0,uint128 amount1)',
]);
const v4Abi = parseAbi([
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
  'event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)',
]);
const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);
const erc20Abi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

export interface UniswapPoolTarget {
  chainId: number;
  version: 'v3' | 'v4';
  resourceId: string;
  poolAddress: string | null;
  poolId: string | null;
  token0Address: string;
  token0Symbol: string | null;
  token0Decimals: number | null;
  token1Address: string;
  token1Symbol: string | null;
  token1Decimals: number | null;
  feeTier: number;
  tickSpacing: number;
}

export interface UniswapPoolEvent {
  eventId: string;
  eventType: 'swap' | 'mint' | 'burn' | 'collect';
  blockNumber: string;
  transactionHash: string;
  logIndex: number;
  amount0: string | null;
  amount1: string | null;
  observedAt: string;
}

export interface UniswapPoolReadResult {
  blockNumber: string;
  currentTick: number;
  token0Price: string;
  token1Price: string;
  activeLiquidity: string;
  tvlToken0: string | null;
  tvlToken1: string | null;
  lpFee: string;
  protocolFee: string | null;
  events: UniswapPoolEvent[];
}

export class UniswapPoolReader {
  private readonly publicClient: PublicClient;
  private readonly blockTimestampCache = new Map<bigint, string>();
  public constructor(options: {
    rpcUrl: string; headers?: Record<string, string>; expectedChainId: number; timeoutMilliseconds?: number;
    fetch?: typeof globalThis.fetch; publicClient?: PublicClient;
  }) {
    this.publicClient = options.publicClient ?? createEvmPublicClient(options);
  }

  public async latestBlock(signal?: AbortSignal): Promise<bigint> {
    signal?.throwIfAborted();
    return this.publicClient.getBlockNumber({ cacheTime: 0 });
  }

  public async read(target: UniswapPoolTarget, fromBlock: bigint, toBlock: bigint, signal?: AbortSignal): Promise<UniswapPoolReadResult> {
    signal?.throwIfAborted();
    const chainId = await this.publicClient.getChainId();
    if (chainId !== target.chainId) throw new Error('RPC chain ID mismatch');
    if (target.token0Decimals === null || target.token1Decimals === null) throw new Error('Token decimals are unavailable');
    if (target.version === 'v3') return this.readV3(target, fromBlock, toBlock, signal);
    return this.readV4(target, fromBlock, toBlock, signal);
  }

  private prices(sqrtPriceX96: bigint, decimals0: number, decimals1: number) {
    const ratio = new Decimal(sqrtPriceX96.toString()).div(new Decimal(2).pow(96)).pow(2)
      .mul(new Decimal(10).pow(decimals0 - decimals1));
    return { token0Price: ratio.toSignificantDigits(30).toString(), token1Price: ratio.isZero() ? 'unavailable' : new Decimal(1).div(ratio).toSignificantDigits(30).toString() };
  }

  private async readV3(target: UniswapPoolTarget, fromBlock: bigint, toBlock: bigint, signal?: AbortSignal): Promise<UniswapPoolReadResult> {
    const pool = getAddress(target.poolAddress as Address);
    const [slot0, liquidity, balance0, balance1, logs] = await Promise.all([
      this.publicClient.readContract({ address: pool, abi: v3Abi, functionName: 'slot0', blockNumber: toBlock }),
      this.publicClient.readContract({ address: pool, abi: v3Abi, functionName: 'liquidity', blockNumber: toBlock }),
      this.publicClient.readContract({ address: getAddress(target.token0Address), abi: erc20Abi, functionName: 'balanceOf', args: [pool], blockNumber: toBlock }),
      this.publicClient.readContract({ address: getAddress(target.token1Address), abi: erc20Abi, functionName: 'balanceOf', args: [pool], blockNumber: toBlock }),
      this.publicClient.getLogs({ address: pool, events: v3Abi.filter((item) => item.type === 'event'), fromBlock, toBlock }),
    ]);
    signal?.throwIfAborted();
    const prices = this.prices(slot0[0], target.token0Decimals as number, target.token1Decimals as number);
    return {
      blockNumber: toBlock.toString(), currentTick: slot0[1], ...prices, activeLiquidity: liquidity.toString(),
      tvlToken0: formatUnits(balance0, target.token0Decimals as number), tvlToken1: formatUnits(balance1, target.token1Decimals as number),
      lpFee: String(target.feeTier), protocolFee: String(slot0[5]),
      events: await this.events(logs, target),
    };
  }

  private async readV4(target: UniswapPoolTarget, fromBlock: bigint, toBlock: bigint, signal?: AbortSignal): Promise<UniswapPoolReadResult> {
    const deployment = supportedUniswapV4Deployments.get(target.chainId);
    if (deployment === undefined) throw new Error('Uniswap V4 deployment is unavailable');
    const poolId = target.poolId as Hex;
    const [slot0, liquidity, logs] = await Promise.all([
      this.publicClient.readContract({ address: deployment.stateViewAddress, abi: stateViewAbi, functionName: 'getSlot0', args: [poolId], blockNumber: toBlock }),
      this.publicClient.readContract({ address: deployment.stateViewAddress, abi: stateViewAbi, functionName: 'getLiquidity', args: [poolId], blockNumber: toBlock }),
      this.publicClient.getLogs({ address: deployment.poolManagerAddress, events: v4Abi, fromBlock, toBlock }),
    ]);
    signal?.throwIfAborted();
    return {
      blockNumber: toBlock.toString(), currentTick: slot0[1],
      ...this.prices(slot0[0], target.token0Decimals as number, target.token1Decimals as number),
      activeLiquidity: liquidity.toString(), tvlToken0: null, tvlToken1: null,
      lpFee: String(slot0[3]), protocolFee: String(slot0[2]),
      events: await this.events(logs, target),
    };
  }

  private async events(logs: Array<Record<string, unknown>>, target: UniswapPoolTarget): Promise<UniswapPoolEvent[]> {
    const relevant = logs.filter((log) => {
      const args = log.args as Record<string, unknown> | undefined;
      return !(target.version === 'v4' && typeof args?.id === 'string' && args.id.toLowerCase() !== target.resourceId.toLowerCase());
    });
    const blockNumbers = [...new Set(relevant.flatMap((log) => typeof log.blockNumber === 'bigint' ? [log.blockNumber] : []))];
    for (let offset = 0; offset < blockNumbers.length; offset += 8) {
      await Promise.all(blockNumbers.slice(offset, offset + 8).map(async (blockNumber) => {
        if (this.blockTimestampCache.has(blockNumber)) return;
        const block = await this.publicClient.getBlock({ blockNumber });
        this.blockTimestampCache.set(blockNumber, new Date(Number(block.timestamp) * 1_000).toISOString());
      }));
    }
    return relevant.flatMap((log) => {
      const tx = log.transactionHash;
      const index = log.logIndex;
      const block = log.blockNumber;
      const name = log.eventName;
      const args = log.args as Record<string, unknown> | undefined;
      if (typeof tx !== 'string' || typeof index !== 'number' || typeof block !== 'bigint' || args === undefined || typeof name !== 'string') return [];
      let eventType: UniswapPoolEvent['eventType'];
      if (name === 'Swap') eventType = 'swap';
      else if (name === 'Mint') eventType = 'mint';
      else if (name === 'Burn') eventType = 'burn';
      else if (name === 'Collect') eventType = 'collect';
      else if (name === 'ModifyLiquidity' && typeof args.liquidityDelta === 'bigint') eventType = args.liquidityDelta >= 0n ? 'mint' : 'burn';
      else return [];
      const format = (value: unknown, decimals: number | null) => typeof value === 'bigint' && decimals !== null
        ? formatUnits(value < 0n ? -value : value, decimals) : null;
      return [{
        eventId: `${target.chainId}:${tx}:${index}`, eventType, blockNumber: block.toString(), transactionHash: tx,
        logIndex: index, amount0: format(args.amount0, target.token0Decimals), amount1: format(args.amount1, target.token1Decimals),
        observedAt: this.blockTimestampCache.get(block) as string,
      }];
    });
  }
}
