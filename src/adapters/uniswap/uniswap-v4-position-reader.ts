import { encodeAbiParameters, getAddress, keccak256 } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';

import { createEvmPublicClient } from '../evm/evm-rpc-client.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const DEFAULT_OWNERSHIP_CACHE_TTL_MILLISECONDS = 5 * 60 * 1_000;
const DEFAULT_SHARED_READ_CACHE_TTL_MILLISECONDS = 5_000;

const positionManagerAbi = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: 'owner', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getPoolAndPositionInfo',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        name: 'poolKey',
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      { name: 'info', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getPositionLiquidity',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: 'liquidity', type: 'uint128' }],
  },
] as const;

const stateViewAbi = [{
  type: 'function',
  name: 'getSlot0',
  stateMutability: 'view',
  inputs: [{ name: 'poolId', type: 'bytes32' }],
  outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' },
    { name: 'tick', type: 'int24' },
    { name: 'protocolFee', type: 'uint24' },
    { name: 'lpFee', type: 'uint24' },
  ],
}] as const;

const erc20MetadataAbi = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

const poolKeyAbi = [{
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
}] as const;

export interface UniswapV4Deployment {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  deploymentBlock: bigint;
  poolManagerAddress: Address;
  positionManagerAddress: Address;
  stateViewAddress: Address;
}

export const ROBINHOOD_UNISWAP_V4: UniswapV4Deployment = {
  chainId: 4_663,
  chainName: 'Robinhood Chain',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorerUrl: 'https://robinhoodchain.blockscout.com',
  deploymentBlock: 9_073n,
  poolManagerAddress: getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951'),
  positionManagerAddress: getAddress('0x58daec3116aae6d93017baaea7749052e8a04fa7'),
  stateViewAddress: getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'),
};

export const ETHEREUM_UNISWAP_V4: UniswapV4Deployment = {
  chainId: 1,
  chainName: 'Ethereum',
  rpcUrl: '',
  explorerUrl: 'https://etherscan.io',
  deploymentBlock: 21_688_329n,
  poolManagerAddress: getAddress('0x000000000004444c5dc75cb358380d2e3de08a90'),
  positionManagerAddress: getAddress('0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e'),
  stateViewAddress: getAddress('0x7ffe42c4a5deea5b0fec41c94c136cf115597227'),
};

export const supportedUniswapV4Deployments = new Map<number, UniswapV4Deployment>([
  [ETHEREUM_UNISWAP_V4.chainId, ETHEREUM_UNISWAP_V4],
  [ROBINHOOD_UNISWAP_V4.chainId, ROBINHOOD_UNISWAP_V4],
]);

export interface UniswapV4Position {
  protocol: 'uniswap';
  version: 'v4';
  chainId: number;
  chainName: string;
  blockNumber: string;
  tokenId: string;
  owner: Address;
  positionManagerAddress: Address;
  poolManagerAddress: Address;
  stateViewAddress: Address;
  poolId: Hex;
  token0: { address: Address; symbol: string; decimals: number; native: boolean };
  token1: { address: Address; symbol: string; decimals: number; native: boolean };
  feeTier: number;
  lpFee: number;
  protocolFee: number;
  tickSpacing: number;
  hooks: Address;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  liquidity: string;
  inRange: boolean;
}

export interface UniswapV4PositionReaderOptions {
  rpcUrl: string;
  expectedChainId: number;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  timeoutMilliseconds?: number;
  /** NFT ownership changes infrequently; refresh the owner after this TTL. */
  ownershipCacheTtlMilliseconds?: number;
  /** Coalesce an identical short-lived LP read used by multiple monitors. */
  sharedReadCacheTtlMilliseconds?: number;
  now?: () => number;
  publicClient?: PublicClient;
}

function signed24(value: bigint): number {
  return Number(BigInt.asIntN(24, value));
}

export class UniswapV4PositionReader {
  private readonly publicClient: PublicClient;
  private deploymentPromise: Promise<UniswapV4Deployment> | undefined;
  private readonly tokenMetadata = new Map<string, { symbol: string; decimals: number }>();
  private readonly ownersByTokenId = new Map<string, { owner: Address; expiresAt: number }>();
  private readonly positions = new Map<string, { position: UniswapV4Position; expiresAt: number }>();
  private readonly positionReads = new Map<string, Promise<UniswapV4Position>>();
  private readonly poolSlots = new Map<string, { slot: readonly [bigint, number, number, number]; expiresAt: number }>();
  private latestBlock: { value: bigint; expiresAt: number } | undefined;
  private latestBlockRequest: Promise<bigint> | undefined;
  private readonly ownershipCacheTtlMilliseconds: number;
  private readonly sharedReadCacheTtlMilliseconds: number;
  private readonly now: () => number;

  public constructor(private readonly options: UniswapV4PositionReaderOptions) {
    this.publicClient = options.publicClient ?? createEvmPublicClient(options);
    this.ownershipCacheTtlMilliseconds = options.ownershipCacheTtlMilliseconds
      ?? DEFAULT_OWNERSHIP_CACHE_TTL_MILLISECONDS;
    this.sharedReadCacheTtlMilliseconds = options.sharedReadCacheTtlMilliseconds
      ?? DEFAULT_SHARED_READ_CACHE_TTL_MILLISECONDS;
    this.now = options.now ?? Date.now;
  }

  public async read(
    tokenId: string,
    signal?: AbortSignal,
    requestedBlockNumber?: bigint,
  ): Promise<UniswapV4Position> {
    await this.deployment();
    const blockNumber = requestedBlockNumber ?? await this.readLatestBlock(signal);
    const key = `${tokenId}:${blockNumber}`;
    const cached = this.positions.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.position;
    const inflight = this.positionReads.get(key);
    if (inflight !== undefined) return inflight;
    const request = this.readAt(tokenId, blockNumber, signal);
    this.positionReads.set(key, request);
    try {
      const position = await request;
      this.positions.set(key, { position, expiresAt: this.now() + this.sharedReadCacheTtlMilliseconds });
      this.pruneSharedReads();
      return position;
    } finally {
      this.positionReads.delete(key);
    }
  }

  private async readAt(tokenId: string, blockNumber: bigint, signal?: AbortSignal): Promise<UniswapV4Position> {
    const deployment = await this.deployment();
    const chainId = deployment.chainId;
    signal?.throwIfAborted();
    const numericTokenId = BigInt(tokenId);
    const [owner, position, liquidity] = await Promise.all([
      this.readOwner(deployment.positionManagerAddress, numericTokenId, blockNumber),
      this.publicClient.readContract({
        address: deployment.positionManagerAddress,
        abi: positionManagerAbi,
        functionName: 'getPoolAndPositionInfo',
        args: [numericTokenId],
        blockNumber,
      }),
      this.publicClient.readContract({
        address: deployment.positionManagerAddress,
        abi: positionManagerAbi,
        functionName: 'getPositionLiquidity',
        args: [numericTokenId],
        blockNumber,
      }),
    ]);
    signal?.throwIfAborted();
    const [poolKey, packedInfo] = position;
    const poolId = keccak256(encodeAbiParameters(poolKeyAbi, [poolKey]));
    const [slot0, token0, token1] = await Promise.all([
      this.readPoolSlot0(deployment.stateViewAddress, poolId, blockNumber),
      this.readCurrency(poolKey.currency0, blockNumber),
      this.readCurrency(poolKey.currency1, blockNumber),
    ]);
    signal?.throwIfAborted();
    const tickLower = signed24((packedInfo >> 8n) & 0xff_ff_ffn);
    const tickUpper = signed24((packedInfo >> 32n) & 0xff_ff_ffn);
    const currentTick = slot0[1];
    return {
      protocol: 'uniswap',
      version: 'v4',
      chainId,
      chainName: deployment.chainName,
      blockNumber: blockNumber.toString(),
      tokenId,
      owner: getAddress(owner),
      positionManagerAddress: deployment.positionManagerAddress,
      poolManagerAddress: deployment.poolManagerAddress,
      stateViewAddress: deployment.stateViewAddress,
      poolId,
      token0,
      token1,
      feeTier: poolKey.fee,
      lpFee: slot0[3],
      protocolFee: slot0[2],
      tickSpacing: poolKey.tickSpacing,
      hooks: getAddress(poolKey.hooks),
      tickLower,
      tickUpper,
      currentTick,
      liquidity: liquidity.toString(),
      inRange: liquidity > 0n && currentTick >= tickLower && currentTick < tickUpper,
    };
  }

  private async readLatestBlock(signal?: AbortSignal): Promise<bigint> {
    signal?.throwIfAborted();
    if (this.latestBlock !== undefined && this.latestBlock.expiresAt > this.now()) return this.latestBlock.value;
    if (this.latestBlockRequest !== undefined) return this.latestBlockRequest;
    const request = this.publicClient.getBlockNumber({ cacheTime: 0 });
    this.latestBlockRequest = request;
    try {
      const value = await request;
      this.latestBlock = { value, expiresAt: this.now() + this.sharedReadCacheTtlMilliseconds };
      return value;
    } finally {
      this.latestBlockRequest = undefined;
    }
  }

  private async readPoolSlot0(
    stateViewAddress: Address,
    poolId: Hex,
    blockNumber: bigint,
  ): Promise<readonly [bigint, number, number, number]> {
    const key = `${poolId}:${blockNumber}`;
    const cached = this.poolSlots.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.slot;
    const result = await this.publicClient.readContract({
      address: stateViewAddress, abi: stateViewAbi, functionName: 'getSlot0', args: [poolId], blockNumber,
    });
    const slot = result;
    this.poolSlots.set(key, { slot, expiresAt: this.now() + this.sharedReadCacheTtlMilliseconds });
    this.pruneSharedReads();
    return slot;
  }

  private pruneSharedReads(): void {
    const now = this.now();
    for (const [key, value] of this.positions) if (value.expiresAt <= now) this.positions.delete(key);
    for (const [key, value] of this.poolSlots) if (value.expiresAt <= now) this.poolSlots.delete(key);
  }

  private async readOwner(positionManagerAddress: Address, tokenId: bigint, blockNumber: bigint): Promise<Address> {
    const key = tokenId.toString();
    const cached = this.ownersByTokenId.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.owner;
    const owner = await this.publicClient.readContract({
      address: positionManagerAddress,
      abi: positionManagerAbi,
      functionName: 'ownerOf',
      args: [tokenId],
      blockNumber,
    });
    const normalized = getAddress(owner);
    this.ownersByTokenId.set(key, {
      owner: normalized,
      expiresAt: this.now() + Math.max(0, this.ownershipCacheTtlMilliseconds),
    });
    return normalized;
  }

  private async readCurrency(address: Address, blockNumber: bigint) {
    const normalized = getAddress(address);
    if (normalized === ZERO_ADDRESS) {
      return { address: normalized, symbol: 'ETH', decimals: 18, native: true };
    }
    const key = normalized.toLowerCase();
    const cached = this.tokenMetadata.get(key);
    if (cached !== undefined) return { address: normalized, ...cached, native: false };
    const [symbol, decimals] = await Promise.all([
      this.publicClient.readContract({ address: normalized, abi: erc20MetadataAbi, functionName: 'symbol', blockNumber }),
      this.publicClient.readContract({ address: normalized, abi: erc20MetadataAbi, functionName: 'decimals', blockNumber }),
    ]);
    const metadata = { symbol, decimals };
    this.tokenMetadata.set(key, metadata);
    return { address: normalized, ...metadata, native: false };
  }

  private async deployment(): Promise<UniswapV4Deployment> {
    if (this.deploymentPromise !== undefined) return this.deploymentPromise;
    this.deploymentPromise = this.loadDeployment().catch((error: unknown) => {
      this.deploymentPromise = undefined;
      throw error;
    });
    return this.deploymentPromise;
  }

  private async loadDeployment(): Promise<UniswapV4Deployment> {
    const deployment = supportedUniswapV4Deployments.get(this.options.expectedChainId);
    if (deployment === undefined) throw new Error(`Uniswap V4 is not supported on chain ${this.options.expectedChainId}`);
    const chainId = await this.publicClient.getChainId();
    if (chainId !== deployment.chainId) {
      throw new Error(`EVM RPC chain ID mismatch: expected ${deployment.chainId}, received ${chainId}`);
    }
    return deployment;
  }
}
