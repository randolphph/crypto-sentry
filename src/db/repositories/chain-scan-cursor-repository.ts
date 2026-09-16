import { and, eq } from 'drizzle-orm';

import type { AppDatabase } from '../client.js';
import { chainScanCursors } from '../schema/index.js';

export class ChainScanCursorRepository {
  public constructor(private readonly database: AppDatabase['db']) {}

  public get(integrationId: string, protocol: string, chainId: number, streamKey: string): bigint | undefined {
    const row = this.database.select({ block: chainScanCursors.lastScannedBlock }).from(chainScanCursors).where(and(
      eq(chainScanCursors.integrationId, integrationId), eq(chainScanCursors.protocol, protocol),
      eq(chainScanCursors.chainId, chainId), eq(chainScanCursors.streamKey, streamKey),
    )).get();
    return row === undefined ? undefined : BigInt(row.block);
  }

  public save(integrationId: string, protocol: string, chainId: number, streamKey: string, block: bigint): void {
    const row = {
      integrationId, protocol, chainId, streamKey, lastScannedBlock: block.toString(), updatedAt: new Date().toISOString(),
    };
    this.database.insert(chainScanCursors).values(row).onConflictDoUpdate({
      target: [chainScanCursors.integrationId, chainScanCursors.protocol, chainScanCursors.chainId, chainScanCursors.streamKey],
      set: row,
    }).run();
  }
}
