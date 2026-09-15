import type { MetricConsumer } from '../metrics/metric-pipeline.js';
import type { Metric } from '../metrics/metric.js';
import { isActionableMetric } from '../metrics/metric.js';
import type { RuntimeComponentHealth, RuntimeHealthProvider } from '../status/runtime-health.js';
import {
  combineConditionResults,
  conditionMatches,
  evaluateRuleTruth,
  hasRecovered,
} from './rule-state-machine.js';
import type { RuleAction, RuleOperator, RuleRuntimeState, TriState } from './rule-state-machine.js';

export interface ExecutableCondition {
  id: string;
  metric: string;
  labels: Record<string, string>;
  windowSeconds: number | null;
  operator: RuleOperator;
  threshold: string;
  hysteresis: string;
}

export interface ExecutableRule {
  id: string;
  monitorId: string;
  name: string;
  combinator: 'and' | 'or';
  conditions: ExecutableCondition[];
  durationSeconds: number;
  cooldownSeconds: number;
  severity: string;
  notificationIntegrationIds: string[];
  metric: string;
  operator: RuleOperator;
  threshold: string;
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

function labelsMatch(condition: ExecutableCondition, metric: Metric): boolean {
  return Object.entries(condition.labels).every(([name, value]) => metric.labels?.[name] === value) &&
    (condition.metric !== 'price_change_percent' || String(condition.windowSeconds) === metric.labels?.windowSeconds);
}

export class RuleExecutionService implements MetricConsumer, RuntimeHealthProvider {
  public readonly consumeUnknownMetrics = true;
  private readonly latestByCondition = new Map<string, Metric>();
  private health: RuntimeComponentHealth = {
    name: 'rule_engine', status: 'healthy', lastSuccessAt: null, lastErrorAt: null, lastError: null,
  };

  public constructor(
    private readonly store: RuleExecutionStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public getHealth(): RuntimeComponentHealth {
    return { ...this.health };
  }

  public async consume(metric: Metric): Promise<void> {
    const failures: Error[] = [];
    let rules: ExecutableRule[];
    try {
      rules = this.store.findEnabledRules(metric.monitorId, metric.name);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.markFailed(failure);
      throw failure;
    }
    for (const rule of rules) {
      try {
        const matching = rule.conditions.filter((condition) => condition.metric === metric.name && labelsMatch(condition, metric));
        if (matching.length === 0) continue;
        for (const condition of matching) this.latestByCondition.set(condition.id, metric);
        const state = this.store.getState(rule.id);
        const results = rule.conditions.map((condition): TriState => {
          const latest = this.latestByCondition.get(condition.id);
          if (latest === undefined || !isActionableMetric(latest)) return 'unknown';
          return state.state === 'TRIGGERED'
            ? !hasRecovered(latest.value, {
              operator: condition.operator,
              threshold: condition.threshold,
              hysteresis: condition.hysteresis,
              durationSeconds: rule.durationSeconds,
              cooldownSeconds: rule.cooldownSeconds,
            })
            : conditionMatches(latest.value, condition.threshold, condition.operator);
        });
        const truth = combineConditionResults(rule.combinator, results);
        const evaluatedAt = metric.receivedAt;
        const evaluation = evaluateRuleTruth(rule, state, truth, String(metric.value), new Date(evaluatedAt));
        this.store.commitEvaluation({ rule, state: evaluation.state, action: evaluation.action, metric, evaluatedAt });
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
      name: 'rule_engine', status: 'healthy', lastSuccessAt: this.now().toISOString(),
      lastErrorAt: this.health.lastErrorAt, lastError: null,
    };
  }

  private markFailed(error: Error): void {
    this.health = {
      name: 'rule_engine', status: 'error', lastSuccessAt: this.health.lastSuccessAt,
      lastErrorAt: this.now().toISOString(), lastError: error.message,
    };
  }
}
