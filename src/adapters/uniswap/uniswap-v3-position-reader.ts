import { formatUnits, getAddress } from 'viem';
import type { Address, PublicClient } from 'viem';

import { createEvmPublicClient } from '../evm/evm-rpc-client.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;
const DEFAULT_TOKEN_ID_CACHE_TTL_MILLISECONDS = 5 * 60 * 1_000;
const DEFAULT_SHARED_READ_CACHE_TTL_MILLISECONDS = 5_000;

const positionManagerAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tokenOfOwnerByIndex',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ name: 'tokenId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'positions',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' },
      { name: 'operator', type: 'address' },
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' },
      { name: 'tokensOwed1', type: 'uint128' },
    ],
  },
] as const;

const factoryAbi = [{
  type: 'function',
  name: 'getPool',
  stateMutability: 'view',
  inputs: [
    { name: 'tokenA', type: 'address' },
    { name: 'tokenB', type: 'address' },
    { name: 'fee', type: 'uint24' },
  ],
  outputs: [{ name: 'pool', type: 'address' }],
}] as const;

const poolAbi = [{
  type: 'function',
  name: 'slot0',
  stateMutability: 'view',
  inputs: [],
  outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' },
    { name: 'tick', type: 'int24' },
    { name: 'observationIndex', type: 'uint16' },
    { name: 'observationCardinality', type: 'uint16' },
    { name: 'observationCardinalityNext', type: 'uint16' },
    { name: 'feeProtocol', type: 'uint8' },
    { name: 'unlocked', type: 'bool' },
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

export interface UniswapV3Deployment {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  factoryAddress: Address;
  positionManagerAddress: Address;
  deploymentBlock: bigint;
}

export const ETHEREUM_UNISWAP_V3: UniswapV3Deployment = {
  chainId: 1,
  chainName: 'Ethereum',
  rpcUrl: '',
  explorerUrl: 'https://etherscan.io',
  deploymentBlock: 12_369_621n,
  factoryAddress: getAddress('0x1f98431c8ad98523631ae4a59f267346ea31f984'),
  positionManagerAddress: getAddress('0xc36442b4a4522e871399cd717abdd847ab11fe88'),
};

export const ROBINHOOD_UNISWAP_V3: UniswapV3Deployment = {
  chainId: 4_663,
  chainName: 'Robinhood Chain',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorerUrl: 'https://robinhoodchain.blockscout.com',
  factoryAddress: getAddress('0x1f7d7550b1b028f7571e69a784071f0205fd2efa'),
  positionManagerAddress: getAddress('0x73991a25c818bf1f1128deaab1492d45638de0d3'),
  deploymentBlock: 0n,
};

export const supportedUniswapV3Deployments = new Map<number, UniswapV3Deployment>([
  [ETHEREUM_UNISWAP_V3.chainId, ETHEREUM_UNISWAP_V3],
  [ROBINHOOD_UNISWAP_V3.chainId, ROBINHOOD_UNISWAP_V3],
]);

export interface UniswapV3Position {
  protocol: 'uniswap';
  version: 'v3';
  chainId: number;
  chainName: string;
  blockNumber: string;
  tokenId: string;
  owner: Address;
  positionManagerAddress: Address;
  poolAddress: Address;
  token0: { address: Address; symbol: string; decimals: number };
  token1: { address: Address; symbol: string; decimals: number };
  feeTier: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  liquidity: string;
  inRange: boolean;
  tokensOwed0: string;
  tokensOwed1: string;
}

export interface UniswapV3PositionReaderOptions {
  rpcUrl: string;
  expectedChainId: number;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  timeoutMilliseconds?: number;
  multicallBatchSizeBytes?: number;
  /** Wallet NFT ownership changes infrequently; discovery is refreshed after this TTL. */
  tokenIdCacheTtlMilliseconds?: number;
  /** Coalesce an identical short-lived LP read used by multiple monitors. */
  sharedReadCacheTtlMilliseconds?: number;
  now?: () => number;
  publicClient?: PublicClient;
}

export interface UniswapV3OwnedPositions {
  blockNumber: bigint;
  tokenIds: string[];
}

export class UniswapV3PositionReader {
  private readonly publicClient: PublicClient;
  private deploymentPromise: Promise<UniswapV3Deployment> | undefined;
  private readonly poolAddresses = new Map<string, Address>();
  private readonly tokenMetadata = new Map<string, { symbol: string; decimals: number }>();
  private readonly tokenIdsByWallet = new Map<string, { tokenIds: string[]; expiresAt: number }>();
  private readonly ownersByTokenId = new Map<string, { owner: Address; expiresAt: number }>();
  private readonly discoveries = new Map<string, Promise<UniswapV3OwnedPositions>>();
  private readonly positions = new Map<string, { position: UniswapV3Position; expiresAt: number }>();
  private readonly positionReads = new Map<string, Promise<UniswapV3Position>>();
  private readonly poolSlots = new Map<string, { slot: readonly [bigint, number]; expiresAt: number }>();
  private latestBlock: { value: bigint; expiresAt: number } | undefined;
  private latestBlockRequest: Promise<bigint> | undefined;
  private readonly tokenIdCacheTtlMilliseconds: number;
  private readonly sharedReadCacheTtlMilliseconds: number;
  private readonly now: () => number;

  public constructor(private readonly options: UniswapV3PositionReaderOptions) {
    this.publicClient = options.publicClient ?? createEvmPublicClient(options);
    this.tokenIdCacheTtlMilliseconds = options.tokenIdCacheTtlMilliseconds
      ?? DEFAULT_TOKEN_ID_CACHE_TTL_MILLISECONDS;
    this.sharedReadCacheTtlMilliseconds = options.sharedReadCacheTtlMilliseconds
      ?? DEFAULT_SHARED_READ_CACHE_TTL_MILLISECONDS;
    this.now = options.now ?? Date.now;
  }

  public async discover(walletAddress: Address, signal?: AbortSignal): Promise<UniswapV3OwnedPositions> {
    await this.deployment();
    const wallet = getAddress(walletAddress);
    const cacheKey = wallet.toLowerCase();
    const blockNumber = await this.readLatestBlock(signal);
    const cached = this.tokenIdsByWallet.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > this.now()) {
      return { blockNumber, tokenIds: [...cached.tokenIds] };
    }
    const inflight = this.discoveries.get(cacheKey);
    if (inflight !== undefined) return inflight;
    const request = this.discoverAt(wallet, blockNumber, signal);
    this.discoveries.set(cacheKey, request);
    try {
      return await request;
    } finally {
      this.discoveries.delete(cacheKey);
    }
  }

  private async discoverAt(wallet: Address, blockNumber: bigint, signal?: AbortSignal): Promise<UniswapV3OwnedPositions> {
    const deployment = await this.deployment();
    signal?.throwIfAborted();
    const balance = await this.publicClient.readContract({
      address: deployment.positionManagerAddress,
      abi: positionManagerAbi,
      functionName: 'balanceOf',
      args: [wallet],
      blockNumber,
    });
    const tokenIds = await this.readTokenIds(wallet, balance, blockNumber, signal);
    this.tokenIdsByWallet.set(wallet.toLowerCase(), {
      tokenIds,
      expiresAt: this.now() + Math.max(0, this.tokenIdCacheTtlMilliseconds),
    });
    return { blockNumber, tokenIds };
  }

  private async readTokenIds(
    wallet: Address,
    balance: bigint,
    blockNumber: bigint,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (balance === 0n) return [];
    const contracts = Array.from({ length: Number(balance) }, (_, index) => ({
      address: supportedUniswapV3Deployments.get(this.options.expectedChainId)?.positionManagerAddress
        ?? ZERO_ADDRESS as Address,
      abi: positionManagerAbi,
      functionName: 'tokenOfOwnerByIndex' as const,
      args: [wallet, BigInt(index)] as const,
    }));
    signal?.throwIfAborted();
    // PublicClient always exposes multicall. The fallback keeps lightweight unit-test
    // clients and non-multicall providers compatible without changing semantics.
    if (typeof this.publicClient.multicall === 'function') {
      const results = await this.publicClient.multicall({
        allowFailure: false,
        batchSize: this.options.multicallBatchSizeBytes ?? 8_192,
        blockNumber,
        contracts,
        multicallAddress: MULTICALL3_ADDRESS,
      });
      signal?.throwIfAborted();
      return results.map((tokenId) => tokenId.toString());
    }
    const tokenIds: string[] = [];
    for (const contract of contracts) {
      signal?.throwIfAborted();
      const tokenId = await this.publicClient.readContract({ ...contract, blockNumber });
      tokenIds.push(tokenId.toString());
    }
    return tokenIds;
  }

  public async read(
    tokenId: string,
    signal?: AbortSignal,
    requestedBlockNumber?: bigint,
  ): Promise<UniswapV3Position> {
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

  private async readAt(tokenId: string, blockNumber: bigint, signal?: AbortSignal): Promise<UniswapV3Position> {
    const deployment = await this.deployment();
    signal?.throwIfAborted();
    const numericTokenId = BigInt(tokenId);
    const [owner, position] = await Promise.all([
      this.readOwner(deployment.positionManagerAddress, numericTokenId, blockNumber),
      this.publicClient.readContract({
        address: deployment.positionManagerAddress,
        abi: positionManagerAbi,
        functionName: 'positions',
        args: [numericTokenId],
        blockNumber,
      }),
    ]);
    signal?.throwIfAborted();
    const [, , token0Address, token1Address, feeTier, tickLower, tickUpper, liquidity, , , owed0, owed1] = position;
    const poolKey = `${token0Address.toLowerCase()}:${token1Address.toLowerCase()}:${feeTier.toString()}`;
    const poolAddress = this.poolAddresses.get(poolKey) ?? await this.publicClient.readContract({
      address: deployment.factoryAddress,
      abi: factoryAbi,
      functionName: 'getPool',
      args: [token0Address, token1Address, feeTier],
      blockNumber,
    });
    this.poolAddresses.set(poolKey, poolAddress);
    if (poolAddress.toLowerCase() === ZERO_ADDRESS) throw new Error(`Uniswap V3 pool was not found for position ${tokenId}`);
    signal?.throwIfAborted();
    const [slot0, metadata0, metadata1] = await Promise.all([
      this.readPoolSlot0(poolAddress, blockNumber),
      this.readTokenMetadata(token0Address, blockNumber),
      this.readTokenMetadata(token1Address, blockNumber),
    ]);
    signal?.throwIfAborted();
    const currentTick = slot0[1];
    return {
      protocol: 'uniswap',
      version: 'v3',
      chainId: deployment.chainId,
      chainName: deployment.chainName,
      blockNumber: blockNumber.toString(),
      tokenId,
      owner: getAddress(owner),
      positionManagerAddress: deployment.positionManagerAddress,
      poolAddress: getAddress(poolAddress),
      token0: { address: getAddress(token0Address), symbol: metadata0.symbol, decimals: metadata0.decimals },
      token1: { address: getAddress(token1Address), symbol: metadata1.symbol, decimals: metadata1.decimals },
      feeTier,
      tickLower,
      tickUpper,
      currentTick,
      liquidity: liquidity.toString(),
      inRange: liquidity > 0n && currentTick >= tickLower && currentTick < tickUpper,
      tokensOwed0: formatUnits(owed0, metadata0.decimals),
      tokensOwed1: formatUnits(owed1, metadata1.decimals),
    };
  }

  private async readLatestBlock(signal?: AbortSignal): Promise<bigint> {
    signal?.throwIfAborted();
    if (this.latestBlock !== undefined && this.latestBlock.expiresAt > this.now()) return this.latestBlock.value;
    const inflight = this.latestBlockRequest;
    if (inflight !== undefined) return inflight;
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

  private async readPoolSlot0(poolAddress: Address, blockNumber: bigint): Promise<readonly [bigint, number]> {
    const key = `${poolAddress.toLowerCase()}:${blockNumber}`;
    const cached = this.poolSlots.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.slot;
    const result = await this.publicClient.readContract({ address: poolAddress, abi: poolAbi, functionName: 'slot0', blockNumber });
    const slot = result as unknown as readonly [bigint, number];
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
      expiresAt: this.now() + Math.max(0, this.tokenIdCacheTtlMilliseconds),
    });
    return normalized;
  }

  private async deployment(): Promise<UniswapV3Deployment> {
    if (this.deploymentPromise !== undefined) return this.deploymentPromise;
    this.deploymentPromise = this.loadDeployment().catch((error: unknown) => {
      this.deploymentPromise = undefined;
      throw error;
    });
    return this.deploymentPromise;
  }

  private async loadDeployment(): Promise<UniswapV3Deployment> {
    const deployment = supportedUniswapV3Deployments.get(this.options.expectedChainId);
    if (deployment === undefined) {
      throw new Error(`Uniswap V3 is not supported on chain ${this.options.expectedChainId}`);
    }
    const chainId = await this.publicClient.getChainId();
    if (chainId !== deployment.chainId) {
      throw new Error(`EVM RPC chain ID mismatch: expected ${deployment.chainId}, received ${chainId}`);
    }
    return deployment;
  }

  private async readTokenMetadata(address: Address, blockNumber: bigint): Promise<{ symbol: string; decimals: number }> {
    const normalized = getAddress(address);
    const key = normalized.toLowerCase();
    const cached = this.tokenMetadata.get(key);
    if (cached !== undefined) return cached;
    const [symbol, decimals] = await Promise.all([
      this.publicClient.readContract({ address: normalized, abi: erc20MetadataAbi, functionName: 'symbol', blockNumber }),
      this.publicClient.readContract({ address: normalized, abi: erc20MetadataAbi, functionName: 'decimals', blockNumber }),
    ]);
    const metadata = { symbol, decimals };
    this.tokenMetadata.set(key, metadata);
    return metadata;
  }
}
