import { eq } from 'drizzle-orm';

import type { MetricEventDedupeStore } from '../../core/metrics/metric-pipeline.js';
import type { AppDatabase } from '../client.js';
import { processedMetricEvents } from '../schema/index.js';

export class MetricEventRepository implements MetricEventDedupeStore {
  public constructor(private readonly database: AppDatabase['db']) {}

  public claim(eventId: string, monitorId: string, metricName: string, receivedAt: string): boolean {
    const result = this.database.insert(processedMetricEvents)
      .values({ eventId, monitorId, metricName, receivedAt })
      .onConflictDoNothing({ target: [processedMetricEvents.monitorId, processedMetricEvents.eventId, processedMetricEvents.metricName] })
      .run();
    return result.changes > 0;
  }

  public clearMonitor(monitorId: string): void {
    this.database.delete(processedMetricEvents).where(eq(processedMetricEvents.monitorId, monitorId)).run();
  }
}
