import { asc, eq } from 'drizzle-orm';

import { AppError } from '../../api/errors.js';
import { validateMonitorConfig } from '../../api/schemas.js';
import type { MonitorCreate, MonitorPatch } from '../../api/schemas.js';
import { createId } from '../../core/ids.js';
import type { AppDatabase } from '../client.js';
import { integrations, monitors } from '../schema/index.js';

export class MonitorRepository {
  public constructor(private readonly database: AppDatabase['db']) {}

  public list() {
    return this.database.select().from(monitors).orderBy(asc(monitors.createdAt)).all().map(this.present);
  }

  public get(id: string) {
    const row = this.database.select().from(monitors).where(eq(monitors.id, id)).get();
    if (row === undefined) throw new AppError(404, 'MONITOR_NOT_FOUND', 'Monitor was not found');
    return this.present(row);
  }

  public create(input: MonitorCreate) {
    this.validateIntegrationReference(input.type, input.config);
    const timestamp = new Date().toISOString();
    const row = {
      id: createId('mon'),
      name: input.name,
      type: input.type,
      enabled: input.enabled,
      intervalSeconds: input.intervalSeconds,
      maxStaleSeconds: input.maxStaleSeconds,
      configJson: JSON.stringify(input.config),
      lastStatus: 'warming_up',
      lastDataAt: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.database.insert(monitors).values(row).run();
    return this.present(row);
  }

  public update(id: string, input: MonitorPatch) {
    const row = this.database.select().from(monitors).where(eq(monitors.id, id)).get();
    if (row === undefined) throw new AppError(404, 'MONITOR_NOT_FOUND', 'Monitor was not found');
    if (input.config !== undefined) this.validateIntegrationReference(row.type, input.config);
    const updated = {
      ...row,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.intervalSeconds === undefined ? {} : { intervalSeconds: input.intervalSeconds }),
      ...(input.maxStaleSeconds === undefined ? {} : { maxStaleSeconds: input.maxStaleSeconds }),
      ...(input.config === undefined ? {} : { configJson: JSON.stringify(input.config) }),
      updatedAt: new Date().toISOString(),
    };
    this.database.update(monitors).set(updated).where(eq(monitors.id, id)).run();
    return this.present(updated);
  }

  public delete(id: string): void {
    const result = this.database.delete(monitors).where(eq(monitors.id, id)).run();
    if (result.changes === 0) throw new AppError(404, 'MONITOR_NOT_FOUND', 'Monitor was not found');
  }

  private present(this: void, row: typeof monitors.$inferSelect) {
    const { configJson: _, ...publicRow } = row;
    return { ...publicRow, config: JSON.parse(row.configJson) as Record<string, unknown> };
  }

  private validateIntegrationReference(monitorType: string, config: Record<string, unknown>): void {
    validateMonitorConfig(monitorType as MonitorCreate['type'], config);
    const referenceKey = monitorType === 'market' ? 'integrationId' : 'rpcIntegrationId';
    const integrationId = config[referenceKey];
    if (typeof integrationId !== 'string') {
      throw new AppError(400, 'INVALID_MONITOR_CONFIG', `config.${referenceKey} is required`);
    }
    const integration = this.database.select().from(integrations).where(eq(integrations.id, integrationId)).get();
    const expectedType = monitorType === 'market' ? 'market_data' : 'evm_rpc';
    if (integration === undefined || integration.type !== expectedType || !integration.enabled) {
      throw new AppError(400, 'INVALID_MONITOR_CONFIG', `config.${referenceKey} must reference an enabled ${expectedType} integration`, {
        [referenceKey]: 'Integration was not found or has the wrong type',
      });
    }
  }
}
