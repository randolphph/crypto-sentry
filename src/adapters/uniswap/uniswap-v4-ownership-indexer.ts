import { getAddress, parseAbiItem } from 'viem';
import type { Address, PublicClient } from 'viem';

import type { UniswapV4OwnershipRepository, UniswapV4Transfer } from '../../db/repositories/uniswap-v4-ownership-repository.js';
import { createEvmPublicClient } from '../evm/evm-rpc-client.js';
import { supportedUniswapV4Deployments } from './uniswap-v4-position-reader.js';

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)');
const ownerAbi = [{
  type: 'function',
  name: 'ownerOf',
  stateMutability: 'view',
  inputs: [{ name: 'tokenId', type: 'uint256' }],
  outputs: [{ name: 'owner', type: 'address' }],
}] as const;

export interface UniswapV4OwnershipIndexerOptions {
  rpcUrl: string;
  expectedChainId: number;
  integrationId: string;
  repository: UniswapV4OwnershipRepository;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  timeoutMilliseconds?: number;
  publicClient?: PublicClient;
  confirmations?: number;
  chunkSize?: bigint;
  minimumChunkSize?: bigint;
  maximumChunksPerSync?: number;
}

export interface UniswapV4OwnershipSyncResult {
  tokenIds: string[];
  scannedThroughBlock: bigint;
  chainTipBlock: bigint;
  caughtUp: boolean;
}

export class UniswapV4OwnershipIndexer {
  private readonly publicClient: PublicClient;
  private readonly confirmations: bigint;
  private readonly desiredChunkSize: bigint;
  private readonly minimumChunkSize: bigint;
  private readonly maximumChunksPerSync: number;

  public constructor(private readonly options: UniswapV4OwnershipIndexerOptions) {
    this.publicClient = options.publicClient ?? createEvmPublicClient(options);
    this.confirmations = BigInt(options.confirmations ?? 12);
    this.desiredChunkSize = options.chunkSize ?? 5_000_000n;
    this.minimumChunkSize = options.minimumChunkSize ?? 1_000n;
    this.maximumChunksPerSync = options.maximumChunksPerSync ?? 32;
  }

  public async sync(walletAddress: Address, signal?: AbortSignal): Promise<UniswapV4OwnershipSyncResult> {
    const deployment = supportedUniswapV4Deployments.get(this.options.expectedChainId);
    if (deployment === undefined) throw new Error(`Uniswap V4 is not supported on chain ${this.options.expectedChainId}`);
    const chainId = await this.publicClient.getChainId();
    if (chainId !== deployment.chainId) {
      throw new Error(`EVM RPC chain ID mismatch: expected ${deployment.chainId}, received ${chainId}`);
    }
    const wallet = getAddress(walletAddress);
    const key = {
      integrationId: this.options.integrationId,
      walletAddress: wallet,
      positionManagerAddress: deployment.positionManagerAddress,
    };
    const latestBlock = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    const chainTipBlock = latestBlock > this.confirmations ? latestBlock - this.confirmations : 0n;
    let scannedThroughBlock = this.options.repository.getLastScannedBlock(key) ?? deployment.deploymentBlock - 1n;
    let fromBlock = scannedThroughBlock + 1n;
    let chunkSize = this.desiredChunkSize;
    let completedChunks = 0;

    while (fromBlock <= chainTipBlock && completedChunks < this.maximumChunksPerSync) {
      signal?.throwIfAborted();
      const toBlock = fromBlock + chunkSize - 1n < chainTipBlock
        ? fromBlock + chunkSize - 1n
        : chainTipBlock;
      try {
        const transfers = await this.readWalletTransfers(
          deployment.positionManagerAddress,
          wallet,
          fromBlock,
          toBlock,
        );
        signal?.throwIfAborted();
        this.options.repository.applyTransfersAndCheckpoint(key, transfers, toBlock);
        scannedThroughBlock = toBlock;
        fromBlock = toBlock + 1n;
        completedChunks += 1;
        if (chunkSize < this.desiredChunkSize) {
          chunkSize = chunkSize * 2n > this.desiredChunkSize ? this.desiredChunkSize : chunkSize * 2n;
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (chunkSize <= this.minimumChunkSize) throw error;
        const halved = chunkSize / 2n;
        chunkSize = halved < this.minimumChunkSize ? this.minimumChunkSize : halved;
      }
    }

    const tokenIds = this.options.repository.listOwnedTokenIds(key);
    for (const tokenId of tokenIds) {
      signal?.throwIfAborted();
      try {
        const owner = await this.publicClient.readContract({
          address: deployment.positionManagerAddress,
          abi: ownerAbi,
          functionName: 'ownerOf',
          args: [BigInt(tokenId)],
          blockNumber: scannedThroughBlock,
        });
        if (owner.toLowerCase() !== wallet.toLowerCase()) {
          this.options.repository.setOwned(key, tokenId, false);
        }
      } catch {
        // A transient ownerOf failure must not erase ownership derived from confirmed Transfer logs.
      }
    }

    return {
      tokenIds: this.options.repository.listOwnedTokenIds(key),
      scannedThroughBlock,
      chainTipBlock,
      caughtUp: scannedThroughBlock >= chainTipBlock,
    };
  }

  private async readWalletTransfers(
    positionManagerAddress: Address,
    walletAddress: Address,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<UniswapV4Transfer[]> {
    const [inbound, outbound] = await Promise.all([
      this.publicClient.getLogs({
        address: positionManagerAddress,
        event: transferEvent,
        args: { to: walletAddress },
        fromBlock,
        toBlock,
        strict: true,
      }),
      this.publicClient.getLogs({
        address: positionManagerAddress,
        event: transferEvent,
        args: { from: walletAddress },
        fromBlock,
        toBlock,
        strict: true,
      }),
    ]);
    const unique = new Map<string, UniswapV4Transfer>();
    for (const log of [...inbound, ...outbound]) {
      if (log.blockNumber === null || log.logIndex === null) continue;
      const transfer: UniswapV4Transfer = {
        tokenId: log.args.tokenId.toString(),
        from: log.args.from,
        to: log.args.to,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
      };
      unique.set(`${log.transactionHash ?? 'pending'}:${log.logIndex}`, transfer);
    }
    return [...unique.values()];
  }
}
