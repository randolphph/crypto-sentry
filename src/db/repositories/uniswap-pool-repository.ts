import { and, asc, eq } from 'drizzle-orm';

import type { AppDatabase } from '../client.js';
import { tokenMetadataCache, uniswapPools } from '../schema/index.js';

export interface UniswapPoolRecord {
  integrationId: string;
  chainId: number;
  version: 'v3' | 'v4';
  resourceId: string;
  poolAddress: string | null;
  poolId: string | null;
  token0Address: string;
  token0Symbol: string | null;
  token0Decimals: number | null;
  token0Native: boolean;
  token1Address: string;
  token1Symbol: string | null;
  token1Decimals: number | null;
  token1Native: boolean;
  feeTier: number;
  tickSpacing: number;
  hooksAddress: string | null;
  discoveredAtBlock: string;
  updatedAt: string;
}

export class UniswapPoolRepository {
  public constructor(private readonly database: AppDatabase['db']) {}

  public upsert(record: UniswapPoolRecord): void {
    this.database.insert(uniswapPools).values(record).onConflictDoUpdate({
      target: [uniswapPools.integrationId, uniswapPools.chainId, uniswapPools.version, uniswapPools.resourceId],
      set: record,
    }).run();
  }

  public get(integrationId: string, chainId: number, version: 'v3' | 'v4', resourceId: string) {
    return this.database.select().from(uniswapPools).where(and(
      eq(uniswapPools.integrationId, integrationId), eq(uniswapPools.chainId, chainId),
      eq(uniswapPools.version, version), eq(uniswapPools.resourceId, resourceId.toLowerCase()),
    )).get();
  }

  public list(input: {
    integrationId: string; chainId: number; version: 'v3' | 'v4'; q?: string; limit: number; cursor?: string;
  }) {
    const query = input.q?.trim().toLowerCase();
    const cursor = input.cursor?.toLowerCase();
    const rows = this.database.select().from(uniswapPools).where(and(
      eq(uniswapPools.integrationId, input.integrationId), eq(uniswapPools.chainId, input.chainId),
      eq(uniswapPools.version, input.version),
    )).orderBy(asc(uniswapPools.resourceId)).all().filter((row) => {
      if (cursor !== undefined && row.resourceId <= cursor) return false;
      if (query === undefined || query.length === 0) return true;
      return [row.resourceId, row.poolAddress, row.poolId, row.token0Address, row.token1Address,
        row.token0Symbol, row.token1Symbol, `${row.token0Symbol ?? ''}/${row.token1Symbol ?? ''}`,
        String(row.feeTier)]
        .some((value) => value?.toLowerCase().includes(query));
    });
    const page = rows.slice(0, input.limit);
    return { items: page, nextCursor: rows.length > input.limit ? page.at(-1)?.resourceId ?? null : null };
  }

  public saveTokenMetadata(chainId: number, address: string, metadata: {
    symbol: string | null; decimals: number | null; status: 'ok' | 'error';
  }): void {
    const row = { chainId, address: address.toLowerCase(), ...metadata, updatedAt: new Date().toISOString() };
    this.database.insert(tokenMetadataCache).values(row).onConflictDoUpdate({
      target: [tokenMetadataCache.chainId, tokenMetadataCache.address], set: row,
    }).run();
  }

  public getTokenMetadata(chainId: number, address: string) {
    return this.database.select().from(tokenMetadataCache).where(and(
      eq(tokenMetadataCache.chainId, chainId), eq(tokenMetadataCache.address, address.toLowerCase()),
    )).get();
  }
}
