import { describe, expect, it } from 'vitest';

import type { Metric } from '../src/core/metrics/metric.js';
import { RuleExecutionService } from '../src/core/rules/rule-execution-service.js';
import type {
  ExecutableRule,
  RuleEvaluationCommit,
  RuleExecutionStore,
} from '../src/core/rules/rule-execution-service.js';
import type { RuleRuntimeState } from '../src/core/rules/rule-state-machine.js';

class WindowRuleStore implements RuleExecutionStore {
  public readonly commits: RuleEvaluationCommit[] = [];
  private readonly state: RuleRuntimeState = {
    state: 'ARMED', conditionSince: null, lastValue: null, lastAlertAt: null,
  };

  public constructor(private readonly rule: ExecutableRule) {}
  public findEnabledRules(monitorId: string, metricName: string): ExecutableRule[] {
    return monitorId === this.rule.monitorId && metricName === this.rule.metric ? [this.rule] : [];
  }
  public getState(): RuleRuntimeState { return this.state; }
  public commitEvaluation(commit: RuleEvaluationCommit): void { this.commits.push(commit); }
}

function rule(metric: string): ExecutableRule {
  return {
    id: `rule_${metric}`, monitorId: 'mon_window', maxStaleSeconds: 90, name: metric, combinator: 'and',
    conditions: [{ id: 'condition', metric, labels: {}, windowSeconds: 300, operator: 'gte', threshold: '1', hysteresis: '0' }],
    durationSeconds: 0, cooldownSeconds: 60, severity: 'warning', notificationIntegrationIds: [],
    metric, operator: 'gte', threshold: '1',
  };
}

function windowMetric(name: string, windowSeconds: number): Metric {
  return {
    monitorId: 'mon_window', source: 'test', target: 'window', name, value: '2', unit: 'percent',
    labels: { windowSeconds: String(windowSeconds) }, status: 'ok',
    observedAt: '2026-09-16T00:00:00.000Z', receivedAt: '2026-09-16T00:00:00.000Z',
  };
}

describe('Rule window isolation', () => {
  for (const metricName of ['open_interest_change_percent', 'total_collateral_change_percent', 'price_change_percent']) {
    it(`${metricName} only consumes the configured window`, async () => {
      const store = new WindowRuleStore(rule(metricName));
      const execution = new RuleExecutionService(store);

      await execution.consume(windowMetric(metricName, 900));
      expect(store.commits).toHaveLength(0);
      await execution.consume(windowMetric(metricName, 300));
      expect(store.commits).toHaveLength(1);
    });
  }
});
