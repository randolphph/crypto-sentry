import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';

import { AppError } from '../../api/errors.js';
import { createId } from '../../core/ids.js';
import type { AppDatabase } from '../client.js';
import { alerts } from '../schema/index.js';

export interface AlertListOptions {
  limit: number;
  offset: number;
  status?: 'open' | 'acknowledged' | 'resolved' | undefined;
  after?: string | undefined;
}

export interface CreateAlertInput {
  ruleId: string;
  monitorId: string;
  severity: string;
  title: string;
  message: string;
  metricName?: string;
  currentValue?: string;
  threshold?: string;
  observedAt: string;
}

interface DeliveryTarget {
  integrationId: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  sentAt?: string;
  errorCode?: string;
}

interface DeliveryState { targets: DeliveryTarget[] }

function nextDeliveryAt(delivery: DeliveryState, fallback: string): string | null {
  const times = delivery.targets.flatMap((target) => {
    if (target.status === 'pending') return [target.nextAttemptAt ?? fallback];
    if (target.status === 'sending') {
      return [target.lastAttemptAt === undefined
        ? fallback : new Date(Date.parse(target.lastAttemptAt) + 30_000).toISOString()];
    }
    return [];
  });
  return times.length === 0 ? null : times.sort()[0] ?? null;
}

export interface ClaimedAlertDelivery {
  alertId: string;
  targetIndex: number;
  integrationId: string;
  attempts: number;
  alertStatus: string;
  title: string;
  message: string;
}

export type DeliveryOutcome = {
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  errorCode?: string;
  nextAttemptAt?: string;
};

export class AlertRepository {
  public constructor(private readonly database: AppDatabase['db']) {}

  public claimNextDelivery(now: Date): ClaimedAlertDelivery | undefined {
    return this.database.transaction((transaction) => {
      const rows = transaction.select().from(alerts)
        .where(lte(alerts.deliveryNextAttemptAt, now.toISOString()))
        .orderBy(asc(alerts.deliveryNextAttemptAt)).limit(100).all();
      for (const row of rows) {
        let delivery: DeliveryState | undefined;
        try {
          delivery = JSON.parse(row.deliveryJson) as DeliveryState;
        } catch {
          // A malformed legacy record must not block every later delivery.
        }
        if (delivery === undefined || !Array.isArray(delivery.targets)) {
          transaction.update(alerts).set({ deliveryNextAttemptAt: null }).where(eq(alerts.id, row.id)).run();
          continue;
        }
        const targetIndex = delivery.targets.findIndex((target) => {
          if (target.status === 'pending') return target.nextAttemptAt === undefined || target.nextAttemptAt <= now.toISOString();
          if (target.status === 'sending') return target.lastAttemptAt === undefined ||
            Date.parse(target.lastAttemptAt) <= now.getTime() - 30_000;
          return false;
        });
        if (targetIndex < 0) {
          transaction.update(alerts).set({ deliveryNextAttemptAt: nextDeliveryAt(delivery, row.createdAt) })
            .where(eq(alerts.id, row.id)).run();
          continue;
        }
        const target = delivery.targets[targetIndex];
        if (target === undefined) continue;
        const claimed: DeliveryTarget = {
          ...target, status: 'sending', attempts: target.attempts + 1, lastAttemptAt: now.toISOString(),
        };
        delete claimed.nextAttemptAt;
        delivery.targets[targetIndex] = claimed;
        transaction.update(alerts).set({
          deliveryJson: JSON.stringify(delivery), deliveryNextAttemptAt: nextDeliveryAt(delivery, row.createdAt),
          updatedAt: now.toISOString(),
        })
          .where(eq(alerts.id, row.id)).run();
        return {
          alertId: row.id, targetIndex, integrationId: target.integrationId, attempts: claimed.attempts,
          alertStatus: row.status, title: row.title, message: row.message,
        };
      }
      return undefined;
    });
  }

  public completeDelivery(job: ClaimedAlertDelivery, outcome: DeliveryOutcome, now = new Date()): void {
    this.database.transaction((transaction) => {
      const row = transaction.select().from(alerts).where(eq(alerts.id, job.alertId)).get();
      if (row === undefined) return;
      const delivery = JSON.parse(row.deliveryJson) as DeliveryState;
      const target = delivery.targets?.[job.targetIndex];
      if (target?.status !== 'sending' || target.integrationId !== job.integrationId || target.attempts !== job.attempts) return;
      const updated: DeliveryTarget = { ...target, status: outcome.status };
      delete updated.nextAttemptAt;
      delete updated.errorCode;
      if (outcome.status === 'sent') updated.sentAt = now.toISOString();
      if (outcome.errorCode !== undefined) updated.errorCode = outcome.errorCode;
      if (outcome.nextAttemptAt !== undefined) updated.nextAttemptAt = outcome.nextAttemptAt;
      delivery.targets[job.targetIndex] = updated;
      transaction.update(alerts).set({
        deliveryJson: JSON.stringify(delivery), deliveryNextAttemptAt: nextDeliveryAt(delivery, row.createdAt),
        updatedAt: now.toISOString(),
      })
        .where(eq(alerts.id, job.alertId)).run();
    });
  }

  public list(options: AlertListOptions) {
    const conditions = [
      ...(options.status === undefined ? [] : [eq(alerts.status, options.status)]),
      ...(options.after === undefined ? [] : [gt(alerts.createdAt, options.after)]),
    ];
    const where = conditions.length === 0 ? undefined : and(...conditions);
    const items = this.database
      .select()
      .from(alerts)
      .where(where)
      .orderBy(asc(alerts.createdAt))
      .limit(options.limit)
      .offset(options.offset)
      .all()
      .map(this.present);
    const count = this.database.select({ count: sql<number>`count(*)` }).from(alerts).where(where).get();
    return { items, total: count?.count ?? 0, limit: options.limit, offset: options.offset };
  }

  public get(id: string) {
    const row = this.database.select().from(alerts).where(eq(alerts.id, id)).get();
    if (row === undefined) throw new AppError(404, 'ALERT_NOT_FOUND', 'Alert was not found');
    return this.present(row);
  }

  public create(input: CreateAlertInput) {
    const timestamp = new Date().toISOString();
    const row = {
      id: createId('alert'),
      ruleId: input.ruleId,
      monitorId: input.monitorId,
      status: 'open',
      severity: input.severity,
      title: input.title,
      message: input.message,
      metricName: input.metricName ?? null,
      currentValue: input.currentValue ?? null,
      threshold: input.threshold ?? null,
      observedAt: input.observedAt,
      acknowledgedAt: null,
      resolvedAt: null,
      deliveryJson: '{}',
      deliveryNextAttemptAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.database.insert(alerts).values(row).run();
    return this.present(row);
  }

  public acknowledge(id: string) {
    const row = this.require(id);
    if (row.status === 'resolved') throw new AppError(409, 'ALERT_ALREADY_RESOLVED', 'Resolved alerts cannot be acknowledged');
    if (row.status === 'acknowledged') return this.present(row);
    const timestamp = new Date().toISOString();
    const updated = { ...row, status: 'acknowledged', acknowledgedAt: timestamp, updatedAt: timestamp };
    this.database.update(alerts).set(updated).where(eq(alerts.id, id)).run();
    return this.present(updated);
  }

  public resolve(id: string) {
    const row = this.require(id);
    if (row.status === 'resolved') return this.present(row);
    const timestamp = new Date().toISOString();
    const updated = { ...row, status: 'resolved', resolvedAt: timestamp, updatedAt: timestamp };
    this.database.update(alerts).set(updated).where(eq(alerts.id, id)).run();
    return this.present(updated);
  }

  private require(id: string) {
    const row = this.database.select().from(alerts).where(eq(alerts.id, id)).get();
    if (row === undefined) throw new AppError(404, 'ALERT_NOT_FOUND', 'Alert was not found');
    return row;
  }

  private present(this: void, row: typeof alerts.$inferSelect) {
    const { deliveryJson: _, ...publicRow } = row;
    return { ...publicRow, delivery: JSON.parse(row.deliveryJson) as Record<string, unknown> };
  }
}
