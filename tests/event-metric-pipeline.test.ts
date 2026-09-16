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
import { AlertRepository } from '../src/db/repositories/alert-repository.js';
import { IntegrationRepository } from '../src/db/repositories/integration-repository.js';
import { MetricEventRepository } from '../src/db/repositories/metric-event-repository.js';
import { MonitorRepository } from '../src/db/repositories/monitor-repository.js';
import { RuleExecutionRepository } from '../src/db/repositories/rule-execution-repository.js';
import { RuleRepository } from '../src/db/repositories/rule-repository.js';
import { EncryptionService } from '../src/security/encryption/encryption-service.js';

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

  it('preserves recent events when a polling adapter refreshes gauge metrics', async () => {
    const latest = new LatestMetricStore();
    const pipeline = new MetricPipeline(new MonitorStore(), latest);
    await pipeline.ingest(metric('supply', '1', 0, '1:0xabc:9'));
    await pipeline.ingest(metric('health_factor', '2', 1));

    pipeline.forgetMonitor('mon_event');

    expect(latest.list('mon_event')).toHaveLength(1);
    expect(latest.list('mon_event')[0]).toMatchObject({ kind: 'event', eventId: '1:0xabc:9', name: 'supply' });
  });

  it('persists event dedupe across repository instances', () => {
    const database = createDatabase(':memory:');
    database.sqlite.prepare(`INSERT INTO monitors (
      id,name,type,enabled,interval_seconds,max_stale_seconds,config_json,last_status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      'mon_event', 'Event monitor', 'market', 1, 20, 90, '{}', 'ok',
      '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z',
    );
    const first = new MetricEventRepository(database.db);
    expect(first.reserve('1:0xabc:7', 'mon_event', 'supply', '2026-09-16T00:00:00.000Z')).toBe('reserved');
    first.commit('1:0xabc:7', 'mon_event', 'supply', '2026-09-16T00:00:00.000Z');
    expect(new MetricEventRepository(database.db).reserve(
      '1:0xabc:7', 'mon_event', 'supply', '2026-09-16T00:00:01.000Z',
    )).toBe('processed');
    database.close();
  });

  it('recovers a persisted processing reservation after its lease expires', () => {
    const database = createDatabase(':memory:');
    database.sqlite.prepare(`INSERT INTO monitors (
      id,name,type,enabled,interval_seconds,max_stale_seconds,config_json,last_status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      'mon_event', 'Event monitor', 'market', 1, 20, 90, '{}', 'ok',
      '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z',
    );
    let current = new Date('2026-09-16T00:00:00.000Z');
    const repository = new MetricEventRepository(database.db, () => current, 1_000);
    expect(repository.reserve('1:0xlease:1', 'mon_event', 'supply', current.toISOString())).toBe('reserved');
    current = new Date('2026-09-16T00:00:00.500Z');
    expect(repository.reserve('1:0xlease:1', 'mon_event', 'supply', current.toISOString())).toBe('processing');
    current = new Date('2026-09-16T00:00:01.001Z');
    expect(repository.reserve('1:0xlease:1', 'mon_event', 'supply', current.toISOString())).toBe('reserved');
    database.close();
  });

  it('retries the same event after a consumer failure and deduplicates it only after success', async () => {
    const consume = vi.fn()
      .mockRejectedValueOnce(new Error('temporary consumer failure'))
      .mockResolvedValue(undefined);
    const pipeline = new MetricPipeline(new MonitorStore(), new LatestMetricStore(), [{ consume }]);

    const first = await pipeline.ingest(metric('supply', '150', 1, '1:0xretry:1'));
    const second = await pipeline.ingest(metric('supply', '150', 2, '1:0xretry:1'));
    const third = await pipeline.ingest(metric('supply', '150', 3, '1:0xretry:1'));

    expect(first.consumerErrors).toEqual(['temporary consumer failure']);
    expect(second).toMatchObject({ accepted: true, consumerErrors: [] });
    expect(third).toMatchObject({ accepted: false, reason: 'duplicate_event' });
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it('does not duplicate an alert when a later consumer fails after the rule transaction commits', async () => {
    const database = createDatabase(':memory:');
    const integrations = new IntegrationRepository(database.db, new EncryptionService(Buffer.alloc(32, 9)));
    const integration = integrations.create({
      name: 'Ethereum', type: 'evm_rpc', provider: 'custom', enabled: true,
      config: { chainId: 1, rpcUrl: 'https://rpc.invalid' },
    });
    const monitors = new MonitorRepository(database.db, integrations);
    const monitor = monitors.create({
      name: 'Aave events', type: 'aave_pool', enabled: true, intervalSeconds: 20, maxStaleSeconds: 90,
      config: { rpcIntegrationId: integration.id, chainId: 1, reserveAssetAddresses: [] },
    });
    new RuleRepository(database.db).create({
      monitorId: monitor.id, name: 'Large supply', combinator: 'and',
      conditions: [{
        metric: 'aave_event_amount_token', labels: { eventType: 'supply' }, operator: 'gte',
        threshold: '100', hysteresis: '0',
      }],
      durationSeconds: 0, cooldownSeconds: 0, severity: 'warning', notificationIntegrationIds: [], enabled: true,
    });
    const downstream = { consume: vi.fn().mockRejectedValueOnce(new Error('after-rule failure')).mockResolvedValue(undefined) };
    const pipeline = new MetricPipeline(
      monitors,
      new LatestMetricStore(),
      [new RuleExecutionService(new RuleExecutionRepository(database.db)), downstream],
      new MetricEventRepository(database.db),
    );
    const timestamp = '2026-09-16T00:00:00.000Z';
    const event: Metric = {
      monitorId: monitor.id, source: 'aave_v3', target: 'USDC', name: 'aave_event_amount_token',
      value: '150', unit: 'USDC', observedAt: timestamp, receivedAt: timestamp, status: 'ok',
      kind: 'event', eventId: '1:0xcommit:1', labels: { eventType: 'supply' },
    };

    expect((await pipeline.ingest(event)).consumerErrors).toEqual(['after-rule failure']);
    expect(new AlertRepository(database.db).list({ limit: 50, offset: 0 }).total).toBe(1);
    expect((await pipeline.ingest(event)).consumerErrors).toEqual([]);
    expect(new AlertRepository(database.db).list({ limit: 50, offset: 0 }).total).toBe(1);
    expect(await pipeline.ingest(event)).toMatchObject({ accepted: false, reason: 'duplicate_event' });

    await pipeline.close();
    database.close();
  });
});
