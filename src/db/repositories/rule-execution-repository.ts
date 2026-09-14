import { and, asc, eq, ne } from 'drizzle-orm';

import type {
  ExecutableRule,
  RuleEvaluationCommit,
  RuleExecutionStore,
} from '../../core/rules/rule-execution-service.js';
import type { RuleOperator, RuleRuntimeState, RuleStateName } from '../../core/rules/rule-state-machine.js';
import { createId } from '../../core/ids.js';
import type { AppDatabase } from '../client.js';
import { alerts, ruleStates, rules } from '../schema/index.js';

function alertTitle(commit: RuleEvaluationCommit): string {
  const prefix = commit.action === 'repeat' ? 'Reminder' : 'Alert';
  return `[${commit.rule.severity.toUpperCase()}] ${prefix}: ${commit.rule.name}`;
}

function alertMessage(commit: RuleEvaluationCommit): string {
  return [
    `Rule: ${commit.rule.name}`,
    `Target: ${commit.metric.target}`,
    `Metric: ${commit.metric.name}`,
    `Current value: ${String(commit.metric.value)}${commit.metric.unit === undefined ? '' : ` ${commit.metric.unit}`}`,
    `Condition: ${commit.rule.operator} ${commit.rule.threshold}`,
    `Observed at: ${commit.metric.observedAt}`,
  ].join('\n');
}

export class RuleExecutionRepository implements RuleExecutionStore {
  public constructor(private readonly database: AppDatabase['db']) {}

  public findEnabledRules(monitorId: string, metricName: string): ExecutableRule[] {
    return this.database
      .select()
      .from(rules)
      .where(and(eq(rules.monitorId, monitorId), eq(rules.metric, metricName), eq(rules.enabled, true)))
      .orderBy(asc(rules.createdAt), asc(rules.id))
      .all()
      .map((row) => ({
        id: row.id,
        monitorId: row.monitorId,
        name: row.name,
        metric: row.metric,
        operator: row.operator as RuleOperator,
        threshold: row.threshold,
        durationSeconds: row.durationSeconds,
        cooldownSeconds: row.cooldownSeconds,
        hysteresis: row.hysteresis,
        severity: row.severity,
        notificationIntegrationIds: JSON.parse(row.notificationIntegrationIdsJson) as string[],
      }));
  }

  public getState(ruleId: string): RuleRuntimeState {
    const state = this.database.select().from(ruleStates).where(eq(ruleStates.ruleId, ruleId)).get();
    return state === undefined
      ? { state: 'ARMED', conditionSince: null, lastValue: null, lastAlertAt: null }
      : {
          state: state.state as RuleStateName,
          conditionSince: state.conditionSince,
          lastValue: state.lastValue,
          lastAlertAt: state.lastAlertAt,
        };
  }

  public commitEvaluation(commit: RuleEvaluationCommit): void {
    this.database.transaction((transaction) => {
      transaction
        .insert(ruleStates)
        .values({
          ruleId: commit.rule.id,
          state: commit.state.state,
          conditionSince: commit.state.conditionSince,
          lastValue: commit.state.lastValue,
          lastAlertAt: commit.state.lastAlertAt,
          updatedAt: commit.evaluatedAt,
        })
        .onConflictDoUpdate({
          target: ruleStates.ruleId,
          set: {
            state: commit.state.state,
            conditionSince: commit.state.conditionSince,
            lastValue: commit.state.lastValue,
            lastAlertAt: commit.state.lastAlertAt,
            updatedAt: commit.evaluatedAt,
          },
        })
        .run();

      if (commit.action === 'trigger' || commit.action === 'repeat') {
        transaction.insert(alerts).values({
          id: createId('alert'),
          ruleId: commit.rule.id,
          monitorId: commit.rule.monitorId,
          status: 'open',
          severity: commit.rule.severity,
          title: alertTitle(commit),
          message: alertMessage(commit),
          metricName: commit.metric.name,
          currentValue: String(commit.metric.value),
          threshold: commit.rule.threshold,
          observedAt: commit.metric.observedAt,
          acknowledgedAt: null,
          resolvedAt: null,
          deliveryJson: JSON.stringify({
            targets: commit.rule.notificationIntegrationIds.map((integrationId) => ({
              integrationId,
              status: 'pending',
              attempts: 0,
            })),
          }),
          createdAt: commit.evaluatedAt,
          updatedAt: commit.evaluatedAt,
        }).run();
      }

      if (commit.action === 'recover') {
        transaction
          .update(alerts)
          .set({ status: 'resolved', resolvedAt: commit.evaluatedAt, updatedAt: commit.evaluatedAt })
          .where(and(eq(alerts.ruleId, commit.rule.id), ne(alerts.status, 'resolved')))
          .run();
      }
    });
  }
}
