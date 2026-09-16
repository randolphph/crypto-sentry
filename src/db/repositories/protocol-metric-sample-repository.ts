import { and, asc, eq, lt } from 'drizzle-orm';

import type { AppDatabase } from '../client.js';
import { protocolMetricSamples } from '../schema/index.js';

export class ProtocolMetricSampleRepository {
  public constructor(private readonly database: AppDatabase['db']) {}

  public loadSince(monitorId: string, metricName: string, cutoff: string) {
    return this.database.select({ observedAt: protocolMetricSamples.observedAt, value: protocolMetricSamples.value })
      .from(protocolMetricSamples).where(and(
        eq(protocolMetricSamples.monitorId, monitorId), eq(protocolMetricSamples.metricName, metricName),
      )).orderBy(asc(protocolMetricSamples.observedAt)).all()
      .filter((sample) => Date.parse(sample.observedAt) >= Date.parse(cutoff));
  }

  public saveAndPrune(monitorId: string, metricName: string, observedAt: string, value: string, cutoff: string): void {
    this.database.transaction((transaction) => {
      transaction.insert(protocolMetricSamples).values({ monitorId, metricName, observedAt, value })
        .onConflictDoUpdate({
          target: [protocolMetricSamples.monitorId, protocolMetricSamples.metricName, protocolMetricSamples.observedAt],
          set: { value },
        }).run();
      transaction.delete(protocolMetricSamples).where(and(
        eq(protocolMetricSamples.monitorId, monitorId), eq(protocolMetricSamples.metricName, metricName),
        lt(protocolMetricSamples.observedAt, cutoff),
      )).run();
    });
  }
}
