import { and, asc, eq } from 'drizzle-orm';

import type { AppDatabase } from '../client.js';
import { uniswapV4OwnedTokens, uniswapV4ScanCheckpoints } from '../schema/index.js';

export interface UniswapV4Transfer {
  tokenId: string;
  from: string;
  to: string;
  blockNumber: bigint;
  logIndex: number;
}

export interface UniswapV4OwnershipKey {
  integrationId: string;
  walletAddress: string;
  positionManagerAddress: string;
}

export class UniswapV4OwnershipRepository {
  public constructor(private readonly database: AppDatabase['db']) {}

  public getLastScannedBlock(key: UniswapV4OwnershipKey): bigint | undefined {
    const row = this.database.select({ block: uniswapV4ScanCheckpoints.lastScannedBlock })
      .from(uniswapV4ScanCheckpoints)
      .where(and(
        eq(uniswapV4ScanCheckpoints.integrationId, key.integrationId),
        eq(uniswapV4ScanCheckpoints.walletAddress, key.walletAddress.toLowerCase()),
        eq(uniswapV4ScanCheckpoints.positionManagerAddress, key.positionManagerAddress.toLowerCase()),
      ))
      .get();
    return row === undefined ? undefined : BigInt(row.block);
  }

  public applyTransfersAndCheckpoint(
    key: UniswapV4OwnershipKey,
    transfers: UniswapV4Transfer[],
    scannedThroughBlock: bigint,
  ): void {
    const walletAddress = key.walletAddress.toLowerCase();
    const positionManagerAddress = key.positionManagerAddress.toLowerCase();
    const updatedAt = new Date().toISOString();
    const ordered = [...transfers].sort((left, right) => (
      left.blockNumber === right.blockNumber
        ? left.logIndex - right.logIndex
        : left.blockNumber < right.blockNumber ? -1 : 1
    ));

    this.database.transaction((transaction) => {
      for (const transfer of ordered) {
        transaction.insert(uniswapV4OwnedTokens).values({
          integrationId: key.integrationId,
          walletAddress,
          positionManagerAddress,
          tokenId: transfer.tokenId,
          owned: transfer.to.toLowerCase() === walletAddress,
          lastEventBlock: transfer.blockNumber.toString(),
          lastEventLogIndex: transfer.logIndex,
          updatedAt,
        }).onConflictDoUpdate({
          target: [
            uniswapV4OwnedTokens.integrationId,
            uniswapV4OwnedTokens.walletAddress,
            uniswapV4OwnedTokens.positionManagerAddress,
            uniswapV4OwnedTokens.tokenId,
          ],
          set: {
            owned: transfer.to.toLowerCase() === walletAddress,
            lastEventBlock: transfer.blockNumber.toString(),
            lastEventLogIndex: transfer.logIndex,
            updatedAt,
          },
        }).run();
      }
      transaction.insert(uniswapV4ScanCheckpoints).values({
        integrationId: key.integrationId,
        walletAddress,
        positionManagerAddress,
        lastScannedBlock: scannedThroughBlock.toString(),
        updatedAt,
      }).onConflictDoUpdate({
        target: [
          uniswapV4ScanCheckpoints.integrationId,
          uniswapV4ScanCheckpoints.walletAddress,
          uniswapV4ScanCheckpoints.positionManagerAddress,
        ],
        set: { lastScannedBlock: scannedThroughBlock.toString(), updatedAt },
      }).run();
    });
  }

  public setOwned(key: UniswapV4OwnershipKey, tokenId: string, owned: boolean): void {
    this.database.update(uniswapV4OwnedTokens)
      .set({ owned, updatedAt: new Date().toISOString() })
      .where(and(
        eq(uniswapV4OwnedTokens.integrationId, key.integrationId),
        eq(uniswapV4OwnedTokens.walletAddress, key.walletAddress.toLowerCase()),
        eq(uniswapV4OwnedTokens.positionManagerAddress, key.positionManagerAddress.toLowerCase()),
        eq(uniswapV4OwnedTokens.tokenId, tokenId),
      ))
      .run();
  }

  public listOwnedTokenIds(key: UniswapV4OwnershipKey): string[] {
    return this.database.select({ tokenId: uniswapV4OwnedTokens.tokenId })
      .from(uniswapV4OwnedTokens)
      .where(and(
        eq(uniswapV4OwnedTokens.integrationId, key.integrationId),
        eq(uniswapV4OwnedTokens.walletAddress, key.walletAddress.toLowerCase()),
        eq(uniswapV4OwnedTokens.positionManagerAddress, key.positionManagerAddress.toLowerCase()),
        eq(uniswapV4OwnedTokens.owned, true),
      ))
      .orderBy(asc(uniswapV4OwnedTokens.tokenId))
      .all()
      .map(({ tokenId }) => tokenId)
      .sort((left, right) => {
        const leftId = BigInt(left);
        const rightId = BigInt(right);
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      });
  }
}
