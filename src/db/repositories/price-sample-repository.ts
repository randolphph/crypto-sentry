import { and, asc, eq, lt } from 'drizzle-orm';

import type { PriceSample, PriceSampleStore } from '../../core/metrics/market-metric-service.js';
import type { AppDatabase } from '../client.js';
import { marketMetricSamples } from '../schema/index.js';

export class PriceSampleRepository implements PriceSampleStore {
  public constructor(private readonly database: AppDatabase['db']) {}

  public loadSince(monitorId: string, cutoff: string): PriceSample[] {
    return this.loadMetricSince(monitorId, 'price', cutoff).map((sample) => ({
      observedAt: sample.observedAt,
      price: sample.value,
    }));
  }

  public loadMetricSince(monitorId: string, metricName: string, cutoff: string) {
    return this.database
      .select({ observedAt: marketMetricSamples.observedAt, value: marketMetricSamples.value })
      .from(marketMetricSamples)
      .where(and(eq(marketMetricSamples.monitorId, monitorId), eq(marketMetricSamples.metricName, metricName)))
      .orderBy(asc(marketMetricSamples.observedAt))
      .all()
      .filter((sample) => Date.parse(sample.observedAt) >= Date.parse(cutoff));
  }

  public saveAndPrune(monitorId: string, samples: PriceSample[], cutoff: string): void {
    this.saveMetricAndPrune(monitorId, 'price', samples.map((sample) => ({
      observedAt: sample.observedAt,
      value: sample.price,
    })), cutoff);
  }

  public saveMetricAndPrune(
    monitorId: string,
    metricName: string,
    samples: Array<{ observedAt: string; value: string }>,
    cutoff: string,
  ): void {
    this.database.transaction((transaction) => {
      for (const sample of samples) {
        transaction
          .insert(marketMetricSamples)
          .values({ monitorId, metricName, observedAt: sample.observedAt, value: sample.value })
          .onConflictDoUpdate({
            target: [marketMetricSamples.monitorId, marketMetricSamples.metricName, marketMetricSamples.observedAt],
            set: { value: sample.value },
          })
          .run();
      }
      transaction
        .delete(marketMetricSamples)
        .where(and(
          eq(marketMetricSamples.monitorId, monitorId),
          eq(marketMetricSamples.metricName, metricName),
          lt(marketMetricSamples.observedAt, cutoff),
        ))
        .run();
    });
  }

  public clear(monitorId: string): void {
    this.database.delete(marketMetricSamples).where(eq(marketMetricSamples.monitorId, monitorId)).run();
  }

}
