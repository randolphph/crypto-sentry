import { and, asc, eq } from 'drizzle-orm';

import type { DiscoveredMarket } from '../../adapters/markets/market.js';
import type { AppDatabase } from '../client.js';
import { integrationMarkets } from '../schema/index.js';

export class MarketRepository {
  public constructor(private readonly database: AppDatabase['db']) {}

  public list(integrationId: string) {
    return this.database
      .select()
      .from(integrationMarkets)
      .where(eq(integrationMarkets.integrationId, integrationId))
      .orderBy(asc(integrationMarkets.marketType), asc(integrationMarkets.providerSymbol))
      .all();
  }

  public replace(integrationId: string, markets: DiscoveredMarket[]): void {
    const updatedAt = new Date().toISOString();
    this.database.transaction((transaction) => {
      transaction.delete(integrationMarkets).where(eq(integrationMarkets.integrationId, integrationId)).run();
      if (markets.length > 0) {
        transaction.insert(integrationMarkets).values(markets.map((market) => ({
          integrationId,
          ...market,
          updatedAt,
        }))).run();
      }
    });
  }

  public has(integrationId: string, marketType: DiscoveredMarket['marketType'], providerSymbol: string): boolean {
    return this.database
      .select({ providerSymbol: integrationMarkets.providerSymbol })
      .from(integrationMarkets)
      .where(and(
        eq(integrationMarkets.integrationId, integrationId),
        eq(integrationMarkets.marketType, marketType),
        eq(integrationMarkets.providerSymbol, providerSymbol),
      ))
      .get() !== undefined;
  }
}
