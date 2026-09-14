import { and, asc, eq, lt } from 'drizzle-orm';

import type { PriceSample, PriceSampleStore } from '../../core/metrics/market-metric-service.js';
import type { AppDatabase } from '../client.js';
import { priceSamples } from '../schema/index.js';

export class PriceSampleRepository implements PriceSampleStore {
  public constructor(private readonly database: AppDatabase['db']) {}

  public loadSince(monitorId: string, cutoff: string): PriceSample[] {
    return this.database
      .select({ observedAt: priceSamples.observedAt, price: priceSamples.price })
      .from(priceSamples)
      .where(eq(priceSamples.monitorId, monitorId))
      .orderBy(asc(priceSamples.observedAt))
      .all()
      .filter((sample) => Date.parse(sample.observedAt) >= Date.parse(cutoff));
  }

  public saveAndPrune(monitorId: string, samples: PriceSample[], cutoff: string): void {
    this.database.transaction((transaction) => {
      for (const sample of samples) {
        transaction
          .insert(priceSamples)
          .values({ monitorId, observedAt: sample.observedAt, price: sample.price })
          .onConflictDoUpdate({
            target: [priceSamples.monitorId, priceSamples.observedAt],
            set: { price: sample.price },
          })
          .run();
      }
      transaction
        .delete(priceSamples)
        .where(and(eq(priceSamples.monitorId, monitorId), lt(priceSamples.observedAt, cutoff)))
        .run();
    });
  }

  public clear(monitorId: string): void {
    this.database.delete(priceSamples).where(eq(priceSamples.monitorId, monitorId)).run();
  }

}
