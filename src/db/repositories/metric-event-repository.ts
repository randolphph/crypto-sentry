import { and, eq } from 'drizzle-orm';

import type { MetricEventDedupeStore } from '../../core/metrics/metric-pipeline.js';
import type { AppDatabase } from '../client.js';
import { processedMetricEvents } from '../schema/index.js';

export class MetricEventRepository implements MetricEventDedupeStore {
  public constructor(
    private readonly database: AppDatabase['db'],
    private readonly now: () => Date = () => new Date(),
    private readonly processingTimeoutMilliseconds = 60_000,
  ) {}

  public reserve(eventId: string, monitorId: string, metricName: string, receivedAt: string): 'reserved' | 'processed' | 'processing' {
    return this.database.transaction((transaction) => {
      const where = and(
        eq(processedMetricEvents.monitorId, monitorId),
        eq(processedMetricEvents.eventId, eventId),
        eq(processedMetricEvents.metricName, metricName),
      );
      const existing = transaction.select().from(processedMetricEvents).where(where).get();
      const startedAt = this.now().toISOString();
      if (existing === undefined) {
        transaction.insert(processedMetricEvents).values({
          eventId, monitorId, metricName, receivedAt, status: 'processing',
          processingStartedAt: startedAt, processedAt: null, attemptCount: 1,
        }).run();
        return 'reserved';
      }
      if (existing.status === 'processed') return 'processed';
      const stale = existing.processingStartedAt === null ||
        this.now().getTime() - Date.parse(existing.processingStartedAt) >= this.processingTimeoutMilliseconds;
      if (!stale) return 'processing';
      transaction.update(processedMetricEvents).set({
        receivedAt, status: 'processing', processingStartedAt: startedAt,
        attemptCount: existing.attemptCount + 1,
      }).where(where).run();
      return 'reserved';
    });
  }

  public commit(eventId: string, monitorId: string, metricName: string, processedAt: string): void {
    this.database.update(processedMetricEvents).set({
      status: 'processed', processedAt, processingStartedAt: null,
    }).where(and(
      eq(processedMetricEvents.monitorId, monitorId),
      eq(processedMetricEvents.eventId, eventId),
      eq(processedMetricEvents.metricName, metricName),
    )).run();
  }

  public release(eventId: string, monitorId: string, metricName: string): void {
    this.database.delete(processedMetricEvents).where(and(
      eq(processedMetricEvents.monitorId, monitorId),
      eq(processedMetricEvents.eventId, eventId),
      eq(processedMetricEvents.metricName, metricName),
      eq(processedMetricEvents.status, 'processing'),
    )).run();
  }

  public clearMonitor(monitorId: string): void {
    this.database.delete(processedMetricEvents).where(eq(processedMetricEvents.monitorId, monitorId)).run();
  }
}
