import { desc, eq, sql } from 'drizzle-orm';

import type { AppDatabase } from '../../db/client.js';
import { alerts, integrations, monitors } from '../../db/schema/index.js';

export class StatusService {
  private readonly startedAt = new Date().toISOString();
  private engineHeartbeatAt = this.startedAt;

  public constructor(private readonly database: AppDatabase['db']) {}

  public heartbeat(now: Date = new Date()): void {
    this.engineHeartbeatAt = now.toISOString();
  }

  public summary() {
    const monitorRows = this.database.select().from(monitors).where(eq(monitors.enabled, true)).all();
    const healthy = monitorRows.filter((row) => row.lastStatus === 'ok').length;
    const stale = monitorRows.filter((row) => ['stale', 'warming_up'].includes(row.lastStatus)).length;
    const error = monitorRows.filter((row) => row.lastStatus === 'error').length;
    const open = this.database.select({ count: sql<number>`count(*)` }).from(alerts).where(eq(alerts.status, 'open')).get()?.count ?? 0;
    const unacknowledged = open;
    const lastAlertAt = this.database.select({ createdAt: alerts.createdAt }).from(alerts).orderBy(desc(alerts.createdAt)).limit(1).get()?.createdAt ?? null;
    const sourceRows = this.database.select().from(integrations).where(eq(integrations.enabled, true)).all();
    const heartbeatAgeMs = Date.now() - Date.parse(this.engineHeartbeatAt);
    const status = heartbeatAgeMs > 15_000 ? 'unhealthy' : error > 0 || stale > 0 ? 'degraded' : 'healthy';

    return {
      status,
      serverTime: new Date().toISOString(),
      startedAt: this.startedAt,
      engineHeartbeatAt: this.engineHeartbeatAt,
      monitors: { total: monitorRows.length, healthy, stale, error },
      alerts: { open, unacknowledged, lastAlertAt },
      sources: sourceRows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.enabled ? 'configured' : 'disabled',
        lastDataAt: null,
      })),
    };
  }

  public monitorStatuses() {
    return this.database.select({
      id: monitors.id,
      name: monitors.name,
      enabled: monitors.enabled,
      status: monitors.lastStatus,
      lastDataAt: monitors.lastDataAt,
      lastError: monitors.lastError,
    }).from(monitors).all();
  }
}
