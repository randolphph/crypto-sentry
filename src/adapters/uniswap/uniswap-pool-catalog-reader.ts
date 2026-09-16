import { getAddress, parseAbiItem } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';

import { createEvmPublicClient } from '../evm/evm-rpc-client.js';
import { supportedUniswapV3Deployments } from './uniswap-v3-position-reader.js';
import { supportedUniswapV4Deployments } from './uniswap-v4-position-reader.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const v3PoolCreated = parseAbiItem('event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)');
const v4Initialize = parseAbiItem('event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)');
const metadataAbi = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

export interface UniswapTokenMetadata {
  address: Address;
  symbol: string | null;
  decimals: number | null;
  native: boolean;
  status: 'ok' | 'error';
}

export interface DiscoveredUniswapPool {
  chainId: number;
  version: 'v3' | 'v4';
  resourceId: string;
  poolAddress: Address | null;
  poolId: Hex | null;
  token0: UniswapTokenMetadata;
  token1: UniswapTokenMetadata;
  feeTier: number;
  tickSpacing: number;
  hooksAddress: Address | null;
  discoveredAtBlock: string;
}

export interface UniswapPoolCatalogReaderOptions {
  rpcUrl: string;
  headers?: Record<string, string>;
  expectedChainId: number;
  timeoutMilliseconds?: number;
  fetch?: typeof globalThis.fetch;
  publicClient?: PublicClient;
}

export class UniswapPoolCatalogReader {
  private readonly publicClient: PublicClient;

  public constructor(private readonly options: UniswapPoolCatalogReaderOptions) {
    this.publicClient = options.publicClient ?? createEvmPublicClient(options);
  }

  public async latestBlock(signal?: AbortSignal): Promise<bigint> {
    signal?.throwIfAborted();
    return this.publicClient.getBlockNumber({ cacheTime: 0 });
  }

  public async scan(version: 'v3' | 'v4', fromBlock: bigint, toBlock: bigint, signal?: AbortSignal) {
    const chainId = await this.publicClient.getChainId();
    if (chainId !== this.options.expectedChainId) throw new Error('RPC chain ID mismatch');
    signal?.throwIfAborted();
    if (version === 'v3') {
      const deployment = supportedUniswapV3Deployments.get(chainId);
      if (deployment === undefined) throw new Error('Uniswap V3 deployment is unavailable');
      const logs = await this.publicClient.getLogs({
        address: deployment.factoryAddress, event: v3PoolCreated, fromBlock, toBlock, strict: true,
      });
      const items: DiscoveredUniswapPool[] = [];
      for (const log of logs) {
        signal?.throwIfAborted();
        if (log.blockNumber === null) continue;
        const [token0, token1] = await Promise.all([
          this.metadata(log.args.token0, toBlock), this.metadata(log.args.token1, toBlock),
        ]);
        items.push({
          chainId, version, resourceId: log.args.pool.toLowerCase(), poolAddress: getAddress(log.args.pool), poolId: null,
          token0, token1, feeTier: log.args.fee, tickSpacing: log.args.tickSpacing,
          hooksAddress: null, discoveredAtBlock: log.blockNumber.toString(),
        });
      }
      return items;
    }
    const deployment = supportedUniswapV4Deployments.get(chainId);
    if (deployment === undefined) throw new Error('Uniswap V4 deployment is unavailable');
    const logs = await this.publicClient.getLogs({
      address: deployment.poolManagerAddress, event: v4Initialize, fromBlock, toBlock, strict: true,
    });
    const items: DiscoveredUniswapPool[] = [];
    for (const log of logs) {
      signal?.throwIfAborted();
      if (log.blockNumber === null) continue;
      const [token0, token1] = await Promise.all([
        this.metadata(log.args.currency0, toBlock), this.metadata(log.args.currency1, toBlock),
      ]);
      items.push({
        chainId, version, resourceId: log.args.id.toLowerCase(), poolAddress: null, poolId: log.args.id,
        token0, token1, feeTier: log.args.fee, tickSpacing: log.args.tickSpacing,
        hooksAddress: getAddress(log.args.hooks), discoveredAtBlock: log.blockNumber.toString(),
      });
    }
    return items;
  }

  private async metadata(address: Address, blockNumber: bigint): Promise<UniswapTokenMetadata> {
    const normalized = getAddress(address);
    if (normalized.toLowerCase() === ZERO_ADDRESS) {
      return { address: normalized, symbol: 'ETH', decimals: 18, native: true, status: 'ok' };
    }
    try {
      const [symbol, decimals] = await Promise.all([
        this.publicClient.readContract({ address: normalized, abi: metadataAbi, functionName: 'symbol', blockNumber }),
        this.publicClient.readContract({ address: normalized, abi: metadataAbi, functionName: 'decimals', blockNumber }),
      ]);
      return { address: normalized, symbol, decimals, native: false, status: 'ok' };
    } catch {
      return { address: normalized, symbol: null, decimals: null, native: false, status: 'error' };
    }
  }
}
