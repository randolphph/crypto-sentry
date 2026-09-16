import { and, asc, eq, ne } from 'drizzle-orm';

import { AppError } from '../../api/errors.js';
import { ruleConditionSchema, ruleCreateSchema, rulePatchSchema } from '../../api/schemas.js';
import type { NormalizedRuleCreate, RuleCreate, RulePatch } from '../../api/schemas.js';
import { createId } from '../../core/ids.js';
import { ruleMetricDefinition } from '../../core/rules/rule-metric-catalog.js';
import type { AppDatabase } from '../client.js';
import { alerts, integrations, monitors, ruleConditions, ruleStates, rules } from '../schema/index.js';

type ConditionInput = NormalizedRuleCreate['conditions'][number];

export class RuleRepository {
  public constructor(private readonly database: AppDatabase['db']) {}

  public list() {
    return this.database.select().from(rules).orderBy(asc(rules.createdAt)).all().map((row) => this.present(row));
  }

  public get(id: string) {
    const row = this.database.select().from(rules).where(eq(rules.id, id)).get();
    if (row === undefined) throw new AppError(404, 'RULE_NOT_FOUND', 'Rule was not found');
    return this.present(row);
  }

  public create(input: RuleCreate) {
    const parsed = ruleCreateSchema.safeParse(input);
    if (!parsed.success) throw new AppError(400, 'RULE_CONDITION_INVALID', 'Rule condition is invalid', {
      conditions: parsed.error.issues.map((issue) => issue.message).join('; '),
    });
    const normalized = parsed.data;
    const monitor = this.database.select({ id: monitors.id, type: monitors.type, configJson: monitors.configJson })
      .from(monitors).where(eq(monitors.id, normalized.monitorId)).get();
    if (monitor === undefined) throw new AppError(400, 'INVALID_RULE_CONFIG', 'monitorId must reference an existing monitor');
    this.validateConditions(normalized.conditions, monitor, normalized.durationSeconds);
    this.validateNotificationIntegrations(normalized.notificationIntegrationIds);
    const timestamp = new Date().toISOString();
    const first = normalized.conditions[0];
    if (first === undefined) throw new AppError(400, 'RULE_CONDITION_INVALID', 'At least one condition is required');
    const row = {
      id: createId('rule'), monitorId: normalized.monitorId, name: normalized.name, combinator: normalized.combinator,
      metric: first.metric, labelsJson: JSON.stringify(first.labels), operator: first.operator,
      threshold: first.threshold, windowSeconds: first.windowSeconds ?? null,
      durationSeconds: normalized.durationSeconds, cooldownSeconds: normalized.cooldownSeconds,
      hysteresis: first.hysteresis, severity: normalized.severity,
      notificationIntegrationIdsJson: JSON.stringify(normalized.notificationIntegrationIds),
      enabled: normalized.enabled, createdAt: timestamp, updatedAt: timestamp,
    };
    this.database.transaction((transaction) => {
      transaction.insert(rules).values(row).run();
      transaction.insert(ruleConditions).values(this.conditionRows(row.id, normalized.conditions)).run();
      transaction.insert(ruleStates).values({ ruleId: row.id, state: 'ARMED', updatedAt: timestamp }).run();
    });
    return this.present(row);
  }

  public update(id: string, input: RulePatch) {
    const parsed = rulePatchSchema.safeParse(input);
    if (!parsed.success) throw new AppError(400, 'RULE_CONDITION_INVALID', 'Rule condition is invalid', {
      conditions: parsed.error.issues.map((issue) => issue.message).join('; '),
    });
    const parsedInput = parsed.data;
    const row = this.database.select().from(rules).where(eq(rules.id, id)).get();
    if (row === undefined) throw new AppError(404, 'RULE_NOT_FOUND', 'Rule was not found');
    const currentConditions = this.conditions(id);
    const hasLegacyConditionPatch = 'metric' in parsedInput || 'labels' in parsedInput || 'operator' in parsedInput ||
      'threshold' in parsedInput || 'windowSeconds' in parsedInput || 'hysteresis' in parsedInput;
    const legacyPatch = hasLegacyConditionPatch ? {
      ...('metric' in parsedInput && parsedInput.metric !== undefined ? { metric: parsedInput.metric } : {}),
      ...('labels' in parsedInput && parsedInput.labels !== undefined ? { labels: parsedInput.labels } : {}),
      ...('operator' in parsedInput && parsedInput.operator !== undefined ? { operator: parsedInput.operator } : {}),
      ...('threshold' in parsedInput && parsedInput.threshold !== undefined ? { threshold: parsedInput.threshold } : {}),
      ...('windowSeconds' in parsedInput && parsedInput.windowSeconds !== undefined ? { windowSeconds: parsedInput.windowSeconds } : {}),
      ...('hysteresis' in parsedInput && parsedInput.hysteresis !== undefined ? { hysteresis: parsedInput.hysteresis } : {}),
    } : undefined;
    const conditions = 'conditions' in parsedInput && parsedInput.conditions !== undefined
      ? parsedInput.conditions
      : legacyPatch === undefined
        ? currentConditions
        : [{ ...currentConditions[0], ...legacyPatch } as ConditionInput];
    const monitor = this.database.select({ id: monitors.id, type: monitors.type, configJson: monitors.configJson })
      .from(monitors).where(eq(monitors.id, row.monitorId)).get();
    if (monitor === undefined) throw new AppError(400, 'INVALID_RULE_CONFIG', 'Rule monitor was not found');
    const durationSeconds = parsedInput.durationSeconds ?? row.durationSeconds;
    this.validateConditions(conditions, monitor, durationSeconds);
    if ('notificationIntegrationIds' in parsedInput && parsedInput.notificationIntegrationIds !== undefined) {
      this.validateNotificationIntegrations(parsedInput.notificationIntegrationIds);
    }
    const first = conditions[0];
    if (first === undefined) throw new AppError(400, 'RULE_CONDITION_INVALID', 'At least one condition is required');
    const timestamp = new Date().toISOString();
    const updated = {
      ...row,
      ...('name' in parsedInput && parsedInput.name !== undefined ? { name: parsedInput.name } : {}),
      ...('combinator' in parsedInput && parsedInput.combinator !== undefined ? { combinator: parsedInput.combinator } : {}),
      metric: first.metric, labelsJson: JSON.stringify(first.labels), operator: first.operator,
      threshold: first.threshold, windowSeconds: first.windowSeconds ?? null, hysteresis: first.hysteresis,
      ...('durationSeconds' in parsedInput && parsedInput.durationSeconds !== undefined ? { durationSeconds: parsedInput.durationSeconds } : {}),
      ...('cooldownSeconds' in parsedInput && parsedInput.cooldownSeconds !== undefined ? { cooldownSeconds: parsedInput.cooldownSeconds } : {}),
      ...('severity' in parsedInput && parsedInput.severity !== undefined ? { severity: parsedInput.severity } : {}),
      ...('notificationIntegrationIds' in parsedInput && parsedInput.notificationIntegrationIds !== undefined
        ? { notificationIntegrationIdsJson: JSON.stringify(parsedInput.notificationIntegrationIds) } : {}),
      ...('enabled' in parsedInput && parsedInput.enabled !== undefined ? { enabled: parsedInput.enabled } : {}),
      updatedAt: timestamp,
    };
    const conditionsChanged = ('conditions' in parsedInput && parsedInput.conditions !== undefined) || legacyPatch !== undefined;
    const resetState = conditionsChanged ||
      ('combinator' in parsedInput && parsedInput.combinator !== undefined && parsedInput.combinator !== row.combinator) ||
      ('durationSeconds' in parsedInput && parsedInput.durationSeconds !== undefined) ||
      ('enabled' in parsedInput && parsedInput.enabled !== undefined && parsedInput.enabled !== row.enabled);
    this.database.transaction((transaction) => {
      transaction.update(rules).set(updated).where(eq(rules.id, id)).run();
      if (conditionsChanged) {
        transaction.delete(ruleConditions).where(eq(ruleConditions.ruleId, id)).run();
        transaction.insert(ruleConditions).values(this.conditionRows(id, conditions)).run();
      }
      if (resetState) {
        transaction.update(ruleStates).set({
          state: 'ARMED', conditionSince: null, lastValue: null, lastAlertAt: null, updatedAt: timestamp,
        }).where(eq(ruleStates.ruleId, id)).run();
        transaction.update(alerts).set({ status: 'resolved', resolvedAt: timestamp, updatedAt: timestamp })
          .where(and(eq(alerts.ruleId, id), ne(alerts.status, 'resolved'))).run();
      }
    });
    return this.present(updated);
  }

  public delete(id: string): void {
    const result = this.database.delete(rules).where(eq(rules.id, id)).run();
    if (result.changes === 0) throw new AppError(404, 'RULE_NOT_FOUND', 'Rule was not found');
  }

  private conditions(ruleId: string): ConditionInput[] {
    return this.database.select().from(ruleConditions).where(eq(ruleConditions.ruleId, ruleId))
      .orderBy(asc(ruleConditions.position)).all().map((condition) => ({
        metric: condition.metric,
        labels: JSON.parse(condition.labelsJson) as Record<string, string>,
        operator: condition.operator as ConditionInput['operator'],
        threshold: condition.threshold,
        ...(condition.windowSeconds === null ? {} : { windowSeconds: condition.windowSeconds }),
        hysteresis: condition.hysteresis,
      }));
  }

  private conditionRows(ruleId: string, conditions: ConditionInput[]) {
    return conditions.map((condition, position) => ({
      id: createId('condition'), ruleId, position, metric: condition.metric,
      labelsJson: JSON.stringify(condition.labels), operator: condition.operator,
      threshold: condition.threshold, windowSeconds: condition.windowSeconds ?? null,
      hysteresis: condition.hysteresis,
    }));
  }

  private present(row: typeof rules.$inferSelect) {
    const conditions = this.conditions(row.id);
    const first = conditions[0];
    const { labelsJson: _, notificationIntegrationIdsJson: __, ...publicRow } = row;
    return {
      ...publicRow, combinator: row.combinator as 'and' | 'or', conditions,
      notificationIntegrationIds: JSON.parse(row.notificationIntegrationIdsJson) as string[],
      ...(first === undefined ? {} : {
        metric: first.metric, labels: first.labels, operator: first.operator,
        threshold: first.threshold, windowSeconds: first.windowSeconds ?? null, hysteresis: first.hysteresis,
      }),
    };
  }

  private validateConditions(
    conditions: ConditionInput[],
    monitor: { type: string; configJson: string },
    durationSeconds: number,
  ): void {
    if (conditions.length < 1 || conditions.length > 20) {
      throw new AppError(400, 'RULE_CONDITION_INVALID', 'A rule group requires between 1 and 20 conditions');
    }
    for (const [index, condition] of conditions.entries()) {
      const parsed = ruleConditionSchema.safeParse(condition);
      if (!parsed.success) {
        throw new AppError(400, 'RULE_CONDITION_INVALID', 'Rule condition is invalid', {
          [`conditions.${index}`]: parsed.error.issues.map((issue) => issue.message).join('; '),
        });
      }
      const definition = ruleMetricDefinition(monitor.type, condition.metric);
      if (['market', 'aave_account', 'aave_pool', 'uniswap_position', 'uniswap_wallet', 'uniswap_pool'].includes(monitor.type) && definition === undefined) {
        throw new AppError(400, 'RULE_METRIC_UNSUPPORTED', 'Metric is not supported by this monitor type', {
          [`conditions.${index}.metric`]: `${condition.metric} is not available for ${monitor.type}`,
        });
      }
      if (definition === undefined) continue;
      if (!definition.operators.includes(condition.operator)) {
        throw new AppError(400, 'RULE_CONDITION_INVALID', 'Operator is not supported for this metric', {
          [`conditions.${index}.operator`]: `Allowed operators: ${definition.operators.join(', ')}`,
        });
      }
      const invalidLabel = Object.keys(condition.labels).find((label) => !definition.labels.includes(label));
      if (invalidLabel !== undefined) {
        throw new AppError(400, 'RULE_LABEL_INVALID', 'Rule labels are invalid for this metric', {
          [`conditions.${index}.labels.${invalidLabel}`]: 'Label is not supported by this metric',
        });
      }
      if (definition.requiresWindow && condition.windowSeconds === undefined) {
        throw new AppError(400, 'RULE_CONDITION_INVALID', 'This metric requires windowSeconds', {
          [`conditions.${index}.windowSeconds`]: 'windowSeconds is required',
        });
      }
      if (!definition.requiresWindow && condition.windowSeconds !== undefined) {
        throw new AppError(400, 'RULE_CONDITION_INVALID', 'This metric does not support a window', {
          [`conditions.${index}.windowSeconds`]: 'Remove windowSeconds',
        });
      }
      if (condition.windowSeconds !== undefined && (
        condition.windowSeconds < (definition.windowSecondsMin ?? 1) ||
        condition.windowSeconds > (definition.windowSecondsMax ?? Number.MAX_SAFE_INTEGER)
      )) {
        throw new AppError(400, 'RULE_CONDITION_INVALID', 'Rule window is outside the supported range', {
          [`conditions.${index}.windowSeconds`]: `Expected ${definition.windowSecondsMin}-${definition.windowSecondsMax} seconds`,
        });
      }
      if (condition.labels.windowSeconds !== undefined &&
        condition.labels.windowSeconds !== String(condition.windowSeconds)) {
        throw new AppError(400, 'RULE_LABEL_INVALID', 'Rule window label conflicts with windowSeconds', {
          [`conditions.${index}.labels.windowSeconds`]: `Expected ${String(condition.windowSeconds)}`,
        });
      }
      const monitorConfig = JSON.parse(monitor.configJson) as Record<string, unknown>;
      const marketType = monitorConfig.marketType;
      if (definition.marketTypes !== undefined && typeof marketType === 'string' &&
        !definition.marketTypes.includes(marketType as 'spot' | 'perpetual')) {
        throw new AppError(400, 'RULE_METRIC_UNSUPPORTED', 'Metric is not supported by this market type', {
          [`conditions.${index}.metric`]: `${condition.metric} is not available for ${marketType}`,
        });
      }
      if (condition.labels.marketType !== undefined && condition.labels.marketType !== marketType) {
        throw new AppError(400, 'RULE_LABEL_INVALID', 'Rule labels do not match the monitor configuration', {
          [`conditions.${index}.labels.marketType`]: `Expected ${String(marketType)}`,
        });
      }
      const selectedChainIds = Array.isArray(monitorConfig.chainIds)
        ? monitorConfig.chainIds as number[]
        : typeof monitorConfig.chainId === 'number' ? [monitorConfig.chainId] : [];
      if (definition.chainIds !== undefined && selectedChainIds.some((chainId) => !definition.chainIds?.includes(chainId))) {
        throw new AppError(400, 'RULE_METRIC_UNSUPPORTED', 'Metric is not supported on the monitor network', {
          [`conditions.${index}.metric`]: `${condition.metric} is not available on every selected chain`,
        });
      }
      const selectedVersions = Array.isArray(monitorConfig.versions)
        ? monitorConfig.versions as Array<'v3' | 'v4'>
        : typeof monitorConfig.version === 'string' ? [monitorConfig.version as 'v3' | 'v4'] : [];
      if (definition.versions !== undefined && selectedVersions.some((version) => !definition.versions?.includes(version))) {
        throw new AppError(400, 'RULE_METRIC_UNSUPPORTED', 'Metric is not supported by the monitor protocol version');
      }
      if (condition.labels.chainId !== undefined && selectedChainIds.length > 0 && !selectedChainIds.includes(Number(condition.labels.chainId))) {
        throw new AppError(400, 'RULE_LABEL_INVALID', 'Rule chain label does not match the monitor configuration', {
          [`conditions.${index}.labels.chainId`]: 'Select a chain configured by the monitor',
        });
      }
      if (condition.labels.version !== undefined && !selectedVersions.includes(condition.labels.version as 'v3' | 'v4')) {
        throw new AppError(400, 'RULE_LABEL_INVALID', 'Rule version label does not match the monitor configuration', {
          [`conditions.${index}.labels.version`]: 'Select a version configured by the monitor',
        });
      }
      if (definition.kind === 'event' && durationSeconds !== 0) {
        throw new AppError(400, 'EVENT_RULE_DURATION_UNSUPPORTED', 'Event rules require durationSeconds to be 0', {
          durationSeconds: 'Event conditions cannot accumulate duration',
        });
      }
    }
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
}
