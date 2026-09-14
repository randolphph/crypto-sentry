import type { MetricConsumer } from '../metrics/metric-pipeline.js';
import type { Metric } from '../metrics/metric.js';
import { isActionableMetric } from '../metrics/metric.js';
import type { RuntimeComponentHealth, RuntimeHealthProvider } from '../status/runtime-health.js';
import { evaluateRule } from './rule-state-machine.js';
import type { EvaluatedRule, RuleAction, RuleOperator, RuleRuntimeState } from './rule-state-machine.js';

export interface ExecutableRule extends EvaluatedRule {
  id: string;
  monitorId: string;
  name: string;
  metric: string;
  labels: Record<string, string>;
  windowSeconds: number | null;
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

function labelsMatch(rule: ExecutableRule, metric: Metric): boolean {
  return Object.entries(rule.labels).every(([name, value]) => metric.labels?.[name] === value);
}

export class RuleExecutionService implements MetricConsumer, RuntimeHealthProvider {
  private health: RuntimeComponentHealth = {
    name: 'rule_engine',
    status: 'healthy',
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
  };

  public constructor(
    private readonly store: RuleExecutionStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public getHealth(): RuntimeComponentHealth {
    return { ...this.health };
  }

  public async consume(metric: Metric): Promise<void> {
    if (!isActionableMetric(metric)) return;

    const failures: Error[] = [];
    let rules: ExecutableRule[];
    try {
      rules = this.store.findEnabledRules(metric.monitorId, metric.name);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.markFailed(failure);
      throw failure;
    }
    const matchingRules = rules.filter((rule) => (
      labelsMatch(rule, metric) &&
      (metric.name !== 'price_change_percent' || String(rule.windowSeconds) === metric.labels?.windowSeconds)
    ));
    for (const rule of matchingRules) {
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
      const error = new AggregateError(failures, `${failures.length} rule evaluation(s) failed`);
      this.markFailed(error);
      throw error;
    }
    this.health = {
      name: 'rule_engine',
      status: 'healthy',
      lastSuccessAt: this.now().toISOString(),
      lastErrorAt: this.health.lastErrorAt,
      lastError: null,
    };
  }

  private markFailed(error: Error): void {
    this.health = {
      name: 'rule_engine',
      status: 'error',
      lastSuccessAt: this.health.lastSuccessAt,
      lastErrorAt: this.now().toISOString(),
      lastError: error.message,
    };
  }
}
