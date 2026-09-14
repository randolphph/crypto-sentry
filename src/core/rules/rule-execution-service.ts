import type { MetricConsumer } from '../metrics/metric-pipeline.js';
import type { Metric } from '../metrics/metric.js';
import { evaluateRule } from './rule-state-machine.js';
import type { EvaluatedRule, RuleAction, RuleOperator, RuleRuntimeState } from './rule-state-machine.js';

export interface ExecutableRule extends EvaluatedRule {
  id: string;
  monitorId: string;
  name: string;
  metric: string;
  operator: RuleOperator;
  severity: string;
  notificationIntegrationIds: string[];
}

export interface RuleEvaluationCommit {
  rule: ExecutableRule;
  state: RuleRuntimeState;
  action: RuleAction;
  metric: Metric;
  evaluatedAt: string;
}

export interface RuleExecutionStore {
  findEnabledRules(monitorId: string, metricName: string): ExecutableRule[];
  getState(ruleId: string): RuleRuntimeState;
  commitEvaluation(commit: RuleEvaluationCommit): void;
}

function describeError(rule: ExecutableRule, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Rule ${rule.id} (${rule.name}) failed: ${message}`, { cause: error });
}

export class RuleExecutionService implements MetricConsumer {
  public constructor(private readonly store: RuleExecutionStore) {}

  public async consume(metric: Metric): Promise<void> {
    if (metric.status !== 'ok') return;

    const failures: Error[] = [];
    const rules = this.store.findEnabledRules(metric.monitorId, metric.name);
    for (const rule of rules) {
      try {
        const state = this.store.getState(rule.id);
        const evaluatedAt = metric.receivedAt;
        const evaluation = evaluateRule(rule, state, metric, new Date(evaluatedAt));
        this.store.commitEvaluation({
          rule,
          state: evaluation.state,
          action: evaluation.action,
          metric,
          evaluatedAt,
        });
      } catch (error) {
        failures.push(describeError(rule, error));
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} rule evaluation(s) failed`);
    }
  }
}
