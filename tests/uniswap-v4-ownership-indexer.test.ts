import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';

import { UniswapV4OwnershipIndexer } from '../src/adapters/uniswap/uniswap-v4-ownership-indexer.js';
import { ROBINHOOD_UNISWAP_V4 } from '../src/adapters/uniswap/uniswap-v4-position-reader.js';
import { createDatabase } from '../src/db/client.js';
import type { AppDatabase } from '../src/db/client.js';
import { UniswapV4OwnershipRepository } from '../src/db/repositories/uniswap-v4-ownership-repository.js';
import { integrations } from '../src/db/schema/index.js';

const wallet = '0x0000000000000000000000000000000000001234';
const other = '0x0000000000000000000000000000000000005678';
const zero = '0x0000000000000000000000000000000000000000';

function transfer(tokenId: bigint, from: string, to: string, blockNumber: bigint, logIndex: number) {
  return {
    args: { tokenId, from, to },
    blockNumber,
    logIndex,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
  };
}

describe('UniswapV4OwnershipIndexer', () => {
  let database: AppDatabase;
  let repository: UniswapV4OwnershipRepository;

  beforeEach(() => {
    database = createDatabase(':memory:');
    database.db.insert(integrations).values({
      id: 'int_rpc',
      name: 'Robinhood RPC',
      type: 'evm_rpc',
      provider: 'custom',
      enabled: true,
      configCiphertext: 'encrypted',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    repository = new UniswapV4OwnershipRepository(database.db);
  });

  afterEach(() => database.close());

  it('indexes wallet-filtered transfers in chunks and resumes from a SQLite checkpoint', async () => {
    const getLogs = vi.fn(async (parameters: { args: { from?: string; to?: string }; fromBlock: bigint }) => {
      if (parameters.fromBlock === 9_073n && parameters.args.to !== undefined) {
        return [
          transfer(1n, zero, wallet, 9_100n, 0),
          transfer(2n, other, wallet, 9_120n, 1),
        ];
      }
      if (parameters.fromBlock === 9_073n && parameters.args.from !== undefined) {
        return [transfer(1n, wallet, other, 9_150n, 0)];
      }
      return [];
    });
    const readContract = vi.fn(async () => wallet);
    const publicClient = {
      getChainId: vi.fn(async () => 4_663),
      getBlockNumber: vi.fn(async () => 9_272n),
      getLogs,
      readContract,
    } as unknown as PublicClient;
    const indexer = new UniswapV4OwnershipIndexer({
      rpcUrl: 'https://rpc.example',
      expectedChainId: 4_663,
      integrationId: 'int_rpc',
      repository,
      publicClient,
      confirmations: 0,
      chunkSize: 100n,
      maximumChunksPerSync: 2,
    });

    await expect(indexer.sync(wallet)).resolves.toMatchObject({
      tokenIds: ['2'],
      scannedThroughBlock: 9_272n,
      chainTipBlock: 9_272n,
      caughtUp: true,
    });
    expect(getLogs).toHaveBeenCalledTimes(4);
    expect(repository.getLastScannedBlock({
      integrationId: 'int_rpc',
      walletAddress: wallet,
      positionManagerAddress: ROBINHOOD_UNISWAP_V4.positionManagerAddress,
    })).toBe(9_272n);

    getLogs.mockClear();
    readContract.mockRejectedValueOnce(new Error('temporary RPC failure'));
    await expect(indexer.sync(wallet)).resolves.toMatchObject({ tokenIds: ['2'], caughtUp: true });
    expect(getLogs).not.toHaveBeenCalled();

    readContract.mockResolvedValueOnce(other);
    await expect(indexer.sync(wallet)).resolves.toMatchObject({ tokenIds: [], caughtUp: true });
  });

  it('keeps a provider-accepted reduced log range for later incremental scans', async () => {
    const ranges: bigint[] = [];
    const getLogs = vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      const size = toBlock - fromBlock + 1n;
      ranges.push(size);
      if (size > 20n) throw new Error('log range too large');
      return [];
    });
    const publicClient = {
      getChainId: vi.fn(async () => 4_663),
      getBlockNumber: vi.fn(async () => 9_172n),
      getLogs,
      readContract: vi.fn(async () => wallet),
    } as unknown as PublicClient;
    const indexer = new UniswapV4OwnershipIndexer({
      rpcUrl: 'https://rpc.example', expectedChainId: 4_663, integrationId: 'int_rpc', repository, publicClient,
      confirmations: 0, chunkSize: 40n, minimumChunkSize: 5n, maximumChunksPerSync: 1,
    });

    await indexer.sync(wallet);
    expect(ranges).toEqual([40n, 40n, 20n, 20n]);
    ranges.splice(0);
    await indexer.sync(wallet);
    expect(ranges).toEqual([20n, 20n]);
  });
});
