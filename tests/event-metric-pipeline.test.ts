import { describe, expect, it, vi } from 'vitest';

import { LatestMetricStore } from '../src/core/metrics/latest-metric-store.js';
import type { Metric } from '../src/core/metrics/metric.js';
import { MetricPipeline } from '../src/core/metrics/metric-pipeline.js';
import type { MonitorRuntimeState, RuntimeMonitor } from '../src/core/metrics/metric-pipeline.js';
import { RuleExecutionService } from '../src/core/rules/rule-execution-service.js';
import type {
  ExecutableRule,
  RuleEvaluationCommit,
  RuleExecutionStore,
} from '../src/core/rules/rule-execution-service.js';
import type { RuleRuntimeState } from '../src/core/rules/rule-state-machine.js';
import { createDatabase } from '../src/db/client.js';
import { MetricEventRepository } from '../src/db/repositories/metric-event-repository.js';

class MonitorStore {
  public findRuntimeMonitor(id: string): RuntimeMonitor | undefined {
    return id === 'mon_event' ? { id, enabled: true } : undefined;
  }
  public updateRuntimeState(_id: string, _state: MonitorRuntimeState): void {}
}

class RuleStore implements RuleExecutionStore {
  public readonly commits: RuleEvaluationCommit[] = [];
  private state: RuleRuntimeState = { state: 'ARMED', conditionSince: null, lastValue: null, lastAlertAt: null };
  private readonly rule: ExecutableRule = {
    id: 'rule_event', monitorId: 'mon_event', maxStaleSeconds: 90, name: 'Large supply while healthy', combinator: 'and',
    conditions: [
      { id: 'condition_event', metric: 'supply', labels: {}, windowSeconds: null, operator: 'gte', threshold: '100', hysteresis: '0' },
      { id: 'condition_gauge', metric: 'health_factor', labels: {}, windowSeconds: null, operator: 'gte', threshold: '1.2', hysteresis: '0' },
    ],
    durationSeconds: 0, cooldownSeconds: 0, severity: 'warning', notificationIntegrationIds: [],
    metric: 'supply', operator: 'gte', threshold: '100',
  };

  public findEnabledRules(monitorId: string, metricName: string): ExecutableRule[] {
    return monitorId === this.rule.monitorId && this.rule.conditions.some((condition) => condition.metric === metricName)
      ? [this.rule]
      : [];
  }
  public getState(): RuleRuntimeState { return this.state; }
  public commitEvaluation(commit: RuleEvaluationCommit): void {
    this.state = commit.state;
    this.commits.push(commit);
  }
}

function metric(name: string, value: string, seconds: number, eventId?: string) {
  const timestamp = new Date(Date.parse('2026-09-16T00:00:00.000Z') + seconds * 1_000).toISOString();
  return {
    monitorId: 'mon_event', source: 'aave_v3', target: 'account', name, value,
    observedAt: timestamp, receivedAt: timestamp, status: 'ok' as const,
    ...(eventId === undefined ? {} : { kind: 'event' as const, eventId }),
  };
}

describe('event Metric semantics', () => {
  it('deduplicates eventId and does not replay an old event on later gauge updates', async () => {
    const store = new RuleStore();
    const execution = new RuleExecutionService(store);
    const consumer = { consume: vi.fn(async (input: Metric) => execution.consume(input)) };
    const pipeline = new MetricPipeline(new MonitorStore(), new LatestMetricStore(), [consumer]);

    await pipeline.ingest(metric('health_factor', '1.5', 0));
    const first = await pipeline.ingest(metric('supply', '150', 1, '1:0xabc:7'));
    const duplicate = await pipeline.ingest(metric('supply', '150', 2, '1:0xabc:7'));
    await pipeline.ingest(metric('health_factor', '1.6', 3));

    expect(first).toMatchObject({ accepted: true });
    expect(duplicate).toMatchObject({ accepted: false, reason: 'duplicate_event' });
    expect(store.commits.filter((commit) => commit.action === 'trigger')).toHaveLength(1);
    expect(store.commits.filter((commit) => commit.action === 'repeat')).toHaveLength(0);
    expect(consumer.consume).toHaveBeenCalledTimes(3);
    expect(pipeline.list('mon_event').filter((item) => item.kind === 'event')).toHaveLength(1);
  });

  it('rejects event metrics without a stable eventId', async () => {
    const pipeline = new MetricPipeline(new MonitorStore(), new LatestMetricStore());
    await expect(pipeline.ingest({ ...metric('supply', '1', 0), kind: 'event' })).rejects.toThrow('eventId');
  });

  it('persists event dedupe across repository instances', () => {
    const database = createDatabase(':memory:');
    database.sqlite.prepare(`INSERT INTO monitors (
      id,name,type,enabled,interval_seconds,max_stale_seconds,config_json,last_status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      'mon_event', 'Event monitor', 'market', 1, 20, 90, '{}', 'ok',
      '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z',
    );
    expect(new MetricEventRepository(database.db).claim('1:0xabc:7', 'mon_event', '2026-09-16T00:00:00.000Z')).toBe(true);
    expect(new MetricEventRepository(database.db).claim('1:0xabc:7', 'mon_event', '2026-09-16T00:00:01.000Z')).toBe(false);
    database.close();
  });
});
