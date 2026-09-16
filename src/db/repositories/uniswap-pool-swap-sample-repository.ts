import { and, asc, eq, lt } from 'drizzle-orm';

import type { AppDatabase } from '../client.js';
import { uniswapPoolSwapSamples } from '../schema/index.js';

export interface UniswapPoolSwapSample {
  eventId: string;
  observedAt: string;
  token0Volume: string;
  token1Volume: string;
  usdVolume: string | null;
}

export class UniswapPoolSwapSampleRepository {
  public constructor(private readonly database: AppDatabase['db']) {}

  public save(monitorId: string, sample: UniswapPoolSwapSample): boolean {
    return this.database.insert(uniswapPoolSwapSamples).values({ monitorId, ...sample })
      .onConflictDoNothing({ target: [uniswapPoolSwapSamples.monitorId, uniswapPoolSwapSamples.eventId] })
      .run().changes > 0;
  }

  public listSince(monitorId: string, cutoff: string): UniswapPoolSwapSample[] {
    return this.database.select({
      eventId: uniswapPoolSwapSamples.eventId,
      observedAt: uniswapPoolSwapSamples.observedAt,
      token0Volume: uniswapPoolSwapSamples.token0Volume,
      token1Volume: uniswapPoolSwapSamples.token1Volume,
      usdVolume: uniswapPoolSwapSamples.usdVolume,
    }).from(uniswapPoolSwapSamples).where(eq(uniswapPoolSwapSamples.monitorId, monitorId))
      .orderBy(asc(uniswapPoolSwapSamples.observedAt)).all()
      .filter((sample) => Date.parse(sample.observedAt) >= Date.parse(cutoff));
  }

  public prune(monitorId: string, cutoff: string): void {
    this.database.delete(uniswapPoolSwapSamples).where(and(
      eq(uniswapPoolSwapSamples.monitorId, monitorId),
      lt(uniswapPoolSwapSamples.observedAt, cutoff),
    )).run();
  }

  public clear(monitorId: string): void {
    this.database.delete(uniswapPoolSwapSamples)
      .where(eq(uniswapPoolSwapSamples.monitorId, monitorId)).run();
  }
}
