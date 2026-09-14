import { and, asc, eq, gt, sql } from 'drizzle-orm';

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

export class AlertRepository {
  public constructor(private readonly database: AppDatabase['db']) {}

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
