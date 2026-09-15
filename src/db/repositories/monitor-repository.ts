import { and, asc, eq } from 'drizzle-orm';

import { AppError } from '../../api/errors.js';
import {
  aaveMonitorConfigSchema,
  lpMonitorConfigSchema,
  marketMonitorConfigSchema,
  validateMonitorConfig,
} from '../../api/schemas.js';
import type { MonitorCreate, MonitorPatch } from '../../api/schemas.js';
import { createId } from '../../core/ids.js';
import type { MonitorRuntimeState, MonitorRuntimeStateStore, RuntimeMonitor } from '../../core/metrics/metric-pipeline.js';
import type { AppDatabase } from '../client.js';
import { integrations, monitors, rules } from '../schema/index.js';

export class MonitorRepository implements MonitorRuntimeStateStore {
  public constructor(private readonly database: AppDatabase['db']) {}

  public list() {
    return this.database.select().from(monitors).orderBy(asc(monitors.createdAt)).all().map(this.present);
  }

  public get(id: string) {
    const row = this.database.select().from(monitors).where(eq(monitors.id, id)).get();
    if (row === undefined) throw new AppError(404, 'MONITOR_NOT_FOUND', 'Monitor was not found');
    return this.present(row);
  }

  public findRuntimeMonitor(id: string): RuntimeMonitor | undefined {
    return this.database
      .select({ id: monitors.id, enabled: monitors.enabled })
      .from(monitors)
      .where(eq(monitors.id, id))
      .get();
  }

  public listEnabledMarketSubscriptions() {
    const windowsByMonitor = new Map<string, number[]>();
    for (const rule of this.database
      .select({ monitorId: rules.monitorId, windowSeconds: rules.windowSeconds })
      .from(rules)
      .where(and(eq(rules.enabled, true), eq(rules.metric, 'price_change_percent')))
      .all()) {
      if (rule.windowSeconds === null) continue;
      const windows = windowsByMonitor.get(rule.monitorId) ?? [];
      windows.push(rule.windowSeconds);
      windowsByMonitor.set(rule.monitorId, windows);
    }
    return this.database
      .select({ id: monitors.id, configJson: monitors.configJson, maxStaleSeconds: monitors.maxStaleSeconds })
      .from(monitors)
      .where(and(eq(monitors.enabled, true), eq(monitors.type, 'market')))
      .all()
      .flatMap((row) => {
        const config = marketMonitorConfigSchema.safeParse(JSON.parse(row.configJson));
        return config.success ? [{
          monitorId: row.id,
          maxStaleSeconds: row.maxStaleSeconds,
          windowSeconds: windowsByMonitor.get(row.id) ?? [],
          ...config.data,
        }] : [];
      });
  }

  public listEnabledAaveMonitors() {
    return this.database
      .select({
        id: monitors.id,
        configJson: monitors.configJson,
        intervalSeconds: monitors.intervalSeconds,
        maxStaleSeconds: monitors.maxStaleSeconds,
      })
      .from(monitors)
      .where(and(eq(monitors.enabled, true), eq(monitors.type, 'aave_position')))
      .all()
      .flatMap((row) => {
        const config = aaveMonitorConfigSchema.safeParse(JSON.parse(row.configJson));
        return config.success ? [{
          monitorId: row.id,
          intervalSeconds: row.intervalSeconds,
          maxStaleSeconds: row.maxStaleSeconds,
          ...config.data,
        }] : [];
      });
  }

  public listEnabledUniswapMonitors() {
    return this.database
      .select({
        id: monitors.id,
        configJson: monitors.configJson,
        intervalSeconds: monitors.intervalSeconds,
        maxStaleSeconds: monitors.maxStaleSeconds,
      })
      .from(monitors)
      .where(and(eq(monitors.enabled, true), eq(monitors.type, 'lp_position')))
      .all()
      .flatMap((row) => {
        const config = lpMonitorConfigSchema.safeParse(JSON.parse(row.configJson));
        return config.success ? [{
          monitorId: row.id,
          intervalSeconds: row.intervalSeconds,
          maxStaleSeconds: row.maxStaleSeconds,
          ...config.data,
        }] : [];
      });
  }

  public updateRuntimeState(id: string, state: MonitorRuntimeState): void {
    this.database
      .update(monitors)
      .set({
        lastStatus: state.status,
        lastError: state.lastError,
        ...(state.lastDataAt === undefined ? {} : { lastDataAt: state.lastDataAt }),
      })
      .where(eq(monitors.id, id))
      .run();
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
    if (monitorType === 'aave_position') {
      const rpcIntegration = this.database
        .select({ id: integrations.id })
        .from(integrations)
        .where(and(eq(integrations.type, 'evm_rpc'), eq(integrations.enabled, true)))
        .get();
      if (rpcIntegration === undefined) {
        throw new AppError(400, 'INVALID_MONITOR_CONFIG', 'At least one enabled evm_rpc integration is required');
      }
      return;
    }
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
