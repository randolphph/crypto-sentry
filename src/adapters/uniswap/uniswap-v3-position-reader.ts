import { formatUnits, getAddress } from 'viem';
import type { Address, PublicClient } from 'viem';

import { createEvmPublicClient } from '../evm/evm-rpc-client.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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
}

export const ROBINHOOD_UNISWAP_V3: UniswapV3Deployment = {
  chainId: 4_663,
  chainName: 'Robinhood Chain',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorerUrl: 'https://robinhoodchain.blockscout.com',
  factoryAddress: getAddress('0x1f7d7550b1b028f7571e69a784071f0205fd2efa'),
  positionManagerAddress: getAddress('0x73991a25c818bf1f1128deaab1492d45638de0d3'),
};

export const supportedUniswapV3Deployments = new Map<number, UniswapV3Deployment>([
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
  publicClient?: PublicClient;
}

export interface UniswapV3OwnedPositions {
  blockNumber: bigint;
  tokenIds: string[];
}

export class UniswapV3PositionReader {
  private readonly publicClient: PublicClient;

  public constructor(private readonly options: UniswapV3PositionReaderOptions) {
    this.publicClient = options.publicClient ?? createEvmPublicClient(options);
  }

  public async discover(walletAddress: Address, signal?: AbortSignal): Promise<UniswapV3OwnedPositions> {
    const deployment = await this.deployment();
    signal?.throwIfAborted();
    const blockNumber = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    const balance = await this.publicClient.readContract({
      address: deployment.positionManagerAddress,
      abi: positionManagerAbi,
      functionName: 'balanceOf',
      args: [getAddress(walletAddress)],
      blockNumber,
    });
    const tokenIds: string[] = [];
    for (let index = 0n; index < balance; index += 1n) {
      signal?.throwIfAborted();
      const tokenId = await this.publicClient.readContract({
        address: deployment.positionManagerAddress,
        abi: positionManagerAbi,
        functionName: 'tokenOfOwnerByIndex',
        args: [getAddress(walletAddress), index],
        blockNumber,
      });
      tokenIds.push(tokenId.toString());
    }
    return { blockNumber, tokenIds };
  }

  public async read(
    tokenId: string,
    signal?: AbortSignal,
    requestedBlockNumber?: bigint,
  ): Promise<UniswapV3Position> {
    const deployment = await this.deployment();
    signal?.throwIfAborted();
    const blockNumber = requestedBlockNumber ?? await this.publicClient.getBlockNumber({ cacheTime: 0 });
    const numericTokenId = BigInt(tokenId);
    const [owner, position] = await Promise.all([
      this.publicClient.readContract({
        address: deployment.positionManagerAddress,
        abi: positionManagerAbi,
        functionName: 'ownerOf',
        args: [numericTokenId],
        blockNumber,
      }),
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
    const poolAddress = await this.publicClient.readContract({
      address: deployment.factoryAddress,
      abi: factoryAbi,
      functionName: 'getPool',
      args: [token0Address, token1Address, feeTier],
      blockNumber,
    });
    if (poolAddress.toLowerCase() === ZERO_ADDRESS) throw new Error(`Uniswap V3 pool was not found for position ${tokenId}`);
    signal?.throwIfAborted();
    const [slot0, symbol0, decimals0, symbol1, decimals1] = await Promise.all([
      this.publicClient.readContract({ address: poolAddress, abi: poolAbi, functionName: 'slot0', blockNumber }),
      this.publicClient.readContract({ address: token0Address, abi: erc20MetadataAbi, functionName: 'symbol', blockNumber }),
      this.publicClient.readContract({ address: token0Address, abi: erc20MetadataAbi, functionName: 'decimals', blockNumber }),
      this.publicClient.readContract({ address: token1Address, abi: erc20MetadataAbi, functionName: 'symbol', blockNumber }),
      this.publicClient.readContract({ address: token1Address, abi: erc20MetadataAbi, functionName: 'decimals', blockNumber }),
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
      token0: { address: getAddress(token0Address), symbol: symbol0, decimals: decimals0 },
      token1: { address: getAddress(token1Address), symbol: symbol1, decimals: decimals1 },
      feeTier,
      tickLower,
      tickUpper,
      currentTick,
      liquidity: liquidity.toString(),
      inRange: liquidity > 0n && currentTick >= tickLower && currentTick < tickUpper,
      tokensOwed0: formatUnits(owed0, decimals0),
      tokensOwed1: formatUnits(owed1, decimals1),
    };
  }

  private async deployment(): Promise<UniswapV3Deployment> {
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
}
