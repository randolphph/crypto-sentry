import { and, asc, eq, ne } from 'drizzle-orm';

import { AppError } from '../../api/errors.js';
import type { RuleCreate, RulePatch } from '../../api/schemas.js';
import { createId } from '../../core/ids.js';
import type { AppDatabase } from '../client.js';
import { alerts, integrations, monitors, ruleStates, rules } from '../schema/index.js';

export class RuleRepository {
  public constructor(private readonly database: AppDatabase['db']) {}

  public list() {
    return this.database.select().from(rules).orderBy(asc(rules.createdAt)).all().map(this.present);
  }

  public get(id: string) {
    const row = this.database.select().from(rules).where(eq(rules.id, id)).get();
    if (row === undefined) throw new AppError(404, 'RULE_NOT_FOUND', 'Rule was not found');
    return this.present(row);
  }

  public create(input: RuleCreate) {
    const monitor = this.database.select({ id: monitors.id }).from(monitors).where(eq(monitors.id, input.monitorId)).get();
    if (monitor === undefined) throw new AppError(400, 'INVALID_RULE_CONFIG', 'monitorId must reference an existing monitor');
    this.validateOperatorThreshold(input.operator, input.threshold);
    this.validateNotificationIntegrations(input.notificationIntegrationIds);
    const timestamp = new Date().toISOString();
    const row = {
      id: createId('rule'),
      monitorId: input.monitorId,
      name: input.name,
      metric: input.metric,
      operator: input.operator,
      threshold: input.threshold,
      windowSeconds: input.windowSeconds ?? null,
      durationSeconds: input.durationSeconds,
      cooldownSeconds: input.cooldownSeconds,
      hysteresis: input.hysteresis,
      severity: input.severity,
      notificationIntegrationIdsJson: JSON.stringify(input.notificationIntegrationIds),
      enabled: input.enabled,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.database.transaction((transaction) => {
      transaction.insert(rules).values(row).run();
      transaction.insert(ruleStates).values({ ruleId: row.id, state: 'ARMED', updatedAt: timestamp }).run();
    });
    return this.present(row);
  }

  public update(id: string, input: RulePatch) {
    const row = this.database.select().from(rules).where(eq(rules.id, id)).get();
    if (row === undefined) throw new AppError(404, 'RULE_NOT_FOUND', 'Rule was not found');
    this.validateOperatorThreshold(input.operator ?? row.operator, input.threshold ?? row.threshold);
    if (input.notificationIntegrationIds !== undefined) this.validateNotificationIntegrations(input.notificationIntegrationIds);
    const timestamp = new Date().toISOString();
    const updated = {
      ...row,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.metric === undefined ? {} : { metric: input.metric }),
      ...(input.operator === undefined ? {} : { operator: input.operator }),
      ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
      ...(input.windowSeconds === undefined ? {} : { windowSeconds: input.windowSeconds }),
      ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
      ...(input.cooldownSeconds === undefined ? {} : { cooldownSeconds: input.cooldownSeconds }),
      ...(input.hysteresis === undefined ? {} : { hysteresis: input.hysteresis }),
      ...(input.severity === undefined ? {} : { severity: input.severity }),
      ...(input.notificationIntegrationIds === undefined
        ? {}
        : { notificationIntegrationIdsJson: JSON.stringify(input.notificationIntegrationIds) }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      updatedAt: timestamp,
    };
    const resetState =
      input.metric !== undefined ||
      input.operator !== undefined ||
      input.threshold !== undefined ||
      input.windowSeconds !== undefined ||
      input.durationSeconds !== undefined ||
      input.hysteresis !== undefined ||
      (input.enabled !== undefined && input.enabled !== row.enabled);
    this.database.transaction((transaction) => {
      transaction.update(rules).set(updated).where(eq(rules.id, id)).run();
      if (resetState) {
        transaction.update(ruleStates).set({
          state: 'ARMED',
          conditionSince: null,
          lastValue: null,
          lastAlertAt: null,
          updatedAt: timestamp,
        }).where(eq(ruleStates.ruleId, id)).run();
        transaction.update(alerts).set({
          status: 'resolved',
          resolvedAt: timestamp,
          updatedAt: timestamp,
        }).where(and(eq(alerts.ruleId, id), ne(alerts.status, 'resolved'))).run();
      }
    });
    return this.present(updated);
  }

  public delete(id: string): void {
    const result = this.database.delete(rules).where(eq(rules.id, id)).run();
    if (result.changes === 0) throw new AppError(404, 'RULE_NOT_FOUND', 'Rule was not found');
  }

  private present(this: void, row: typeof rules.$inferSelect) {
    const { notificationIntegrationIdsJson: _, ...publicRow } = row;
    return {
      ...publicRow,
      notificationIntegrationIds: JSON.parse(row.notificationIntegrationIdsJson) as string[],
    };
  }

  private validateNotificationIntegrations(ids: string[]): void {
    for (const id of ids) {
      const integration = this.database.select({ type: integrations.type }).from(integrations).where(eq(integrations.id, id)).get();
      if (integration?.type !== 'notification') {
        throw new AppError(400, 'INVALID_RULE_CONFIG', 'notificationIntegrationIds must reference notification integrations', {
          notificationIntegrationIds: `Invalid notification integration: ${id}`,
        });
      }
    }
  }

  private validateOperatorThreshold(operator: string, threshold: string): void {
    if ((threshold === 'true' || threshold === 'false') && !['eq', 'neq'].includes(operator)) {
      throw new AppError(400, 'INVALID_RULE_CONFIG', 'Boolean thresholds only support eq and neq');
    }
  }
}
