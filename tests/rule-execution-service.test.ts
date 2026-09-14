import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import type { RuleCreate } from '../src/api/schemas.js';
import { LatestMetricStore } from '../src/core/metrics/latest-metric-store.js';
import { MetricPipeline } from '../src/core/metrics/metric-pipeline.js';
import { RuleExecutionService } from '../src/core/rules/rule-execution-service.js';
import { createDatabase } from '../src/db/client.js';
import type { AppDatabase } from '../src/db/client.js';
import { AlertRepository } from '../src/db/repositories/alert-repository.js';
import { IntegrationRepository } from '../src/db/repositories/integration-repository.js';
import { MonitorRepository } from '../src/db/repositories/monitor-repository.js';
import { RuleExecutionRepository } from '../src/db/repositories/rule-execution-repository.js';
import { RuleRepository } from '../src/db/repositories/rule-repository.js';
import { ruleStates, rules } from '../src/db/schema/index.js';
import { EncryptionService } from '../src/security/encryption/encryption-service.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createFixture(databasePath = ':memory:') {
  const database = createDatabase(databasePath);
  const integrations = new IntegrationRepository(database.db, new EncryptionService(Buffer.alloc(32, 4)));
  const monitors = new MonitorRepository(database.db);
  const ruleConfigs = new RuleRepository(database.db);
  const alerts = new AlertRepository(database.db);
  const integration = integrations.create({
    name: 'Binance Main',
    type: 'market_data',
    provider: 'binance',
    enabled: true,
    config: {
      restUrl: 'https://api.binance.com',
      spotWebsocketUrl: 'wss://stream.binance.com:9443',
      futuresWebsocketUrl: 'wss://fstream.binance.com',
    },
  });
  const monitor = monitors.create({
    name: 'BTCUSDT spot',
    type: 'market',
    enabled: true,
    intervalSeconds: 20,
    maxStaleSeconds: 90,
    config: {
      integrationId: integration.id,
      marketType: 'spot',
      providerSymbol: 'BTCUSDT',
    },
  });
  return { database, monitors, ruleConfigs, alerts, monitor };
}

function createPipeline(database: AppDatabase, monitors: MonitorRepository): MetricPipeline {
  const executionStore = new RuleExecutionRepository(database.db);
  return new MetricPipeline(monitors, new LatestMetricStore(), [new RuleExecutionService(executionStore)]);
}

function ruleInput(monitorId: string, overrides: Partial<RuleCreate> = {}): RuleCreate {
  return {
    monitorId,
    name: 'BTC below 90',
    metric: 'price',
    operator: 'lte',
    threshold: '90',
    durationSeconds: 0,
    cooldownSeconds: 60,
    hysteresis: '5',
    severity: 'warning',
    notificationIntegrationIds: [],
    enabled: true,
    ...overrides,
  };
}

function priceMetric(monitorId: string, value: string, time: string) {
  return {
    monitorId,
    source: 'binance',
    target: 'BTCUSDT',
    name: 'price',
    value,
    unit: 'USDT',
    observedAt: time,
    receivedAt: time,
    status: 'ok' as const,
  };
}

describe('RuleExecutionService', () => {
  it('persists triggers, suppresses cooldown duplicates, repeats, recovers, and re-arms', async () => {
    const fixture = createFixture();
    const rule = fixture.ruleConfigs.create(ruleInput(fixture.monitor.id));
    const pipeline = createPipeline(fixture.database, fixture.monitors);

    await pipeline.ingest(priceMetric(fixture.monitor.id, '80', '2026-09-14T12:00:00.000Z'));
    expect(fixture.alerts.list({ limit: 50, offset: 0 }).total).toBe(1);
    expect(fixture.database.db.select().from(ruleStates).where(eq(ruleStates.ruleId, rule.id)).get()?.state).toBe('TRIGGERED');

    await pipeline.ingest(priceMetric(fixture.monitor.id, '82', '2026-09-14T12:00:30.000Z'));
    expect(fixture.alerts.list({ limit: 50, offset: 0 }).total).toBe(1);

    await pipeline.ingest(priceMetric(fixture.monitor.id, '81', '2026-09-14T12:01:00.000Z'));
    expect(fixture.alerts.list({ limit: 50, offset: 0 }).total).toBe(2);

    await pipeline.ingest(priceMetric(fixture.monitor.id, '96', '2026-09-14T12:01:01.000Z'));
    const resolvedAlerts = fixture.alerts.list({ limit: 50, offset: 0 });
    expect(resolvedAlerts.items).toHaveLength(2);
    expect(resolvedAlerts.items.every((alert) => alert.status === 'resolved')).toBe(true);
    expect(fixture.database.db.select().from(ruleStates).where(eq(ruleStates.ruleId, rule.id)).get()?.state).toBe('ARMED');

    await pipeline.ingest(priceMetric(fixture.monitor.id, '79', '2026-09-14T12:01:02.000Z'));
    expect(fixture.alerts.list({ limit: 50, offset: 0 }).total).toBe(3);

    await pipeline.close();
    fixture.database.close();
  });

  it('restores condition duration from SQLite after a process restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cryptosentry-rule-restart-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'monitor.sqlite');
    const first = createFixture(databasePath);
    const rule = first.ruleConfigs.create(ruleInput(first.monitor.id, { durationSeconds: 60 }));
    const firstPipeline = createPipeline(first.database, first.monitors);

    await firstPipeline.ingest(priceMetric(first.monitor.id, '80', '2026-09-14T12:00:00.000Z'));
    expect(first.alerts.list({ limit: 50, offset: 0 }).total).toBe(0);
    expect(first.database.db.select().from(ruleStates).where(eq(ruleStates.ruleId, rule.id)).get()?.conditionSince)
      .toBe('2026-09-14T12:00:00.000Z');
    await firstPipeline.close();
    first.database.close();

    const database = createDatabase(databasePath);
    const monitors = new MonitorRepository(database.db);
    const alerts = new AlertRepository(database.db);
    const restartedPipeline = createPipeline(database, monitors);
    await restartedPipeline.ingest(priceMetric(first.monitor.id, '81', '2026-09-14T12:01:00.000Z'));

    expect(alerts.list({ limit: 50, offset: 0 }).total).toBe(1);
    expect(database.db.select().from(ruleStates).where(eq(ruleStates.ruleId, rule.id)).get()?.state).toBe('TRIGGERED');
    await restartedPipeline.close();
    database.close();
  });

  it('isolates a broken rule while evaluating other matching rules', async () => {
    const fixture = createFixture();
    const brokenRule = fixture.ruleConfigs.create(ruleInput(fixture.monitor.id, { name: 'Broken rule' }));
    const validRule = fixture.ruleConfigs.create(ruleInput(fixture.monitor.id, { name: 'Valid rule' }));
    fixture.database.db.update(rules).set({ threshold: 'not-a-number' }).where(eq(rules.id, brokenRule.id)).run();
    const execution = new RuleExecutionService(new RuleExecutionRepository(fixture.database.db));
    const pipeline = new MetricPipeline(fixture.monitors, new LatestMetricStore(), [execution]);

    const result = await pipeline.ingest(priceMetric(fixture.monitor.id, '80', '2026-09-14T12:00:00.000Z'));

    expect(result.consumerErrors).toEqual(['1 rule evaluation(s) failed']);
    const createdAlerts = fixture.alerts.list({ limit: 50, offset: 0 });
    expect(createdAlerts.total).toBe(1);
    expect(createdAlerts.items[0]?.ruleId).toBe(validRule.id);
    expect(fixture.database.db.select().from(ruleStates).where(eq(ruleStates.ruleId, brokenRule.id)).get()?.state).toBe('ARMED');
    expect(execution.getHealth()).toMatchObject({
      status: 'error',
      lastError: '1 rule evaluation(s) failed',
    });

    fixture.database.db.update(rules).set({ threshold: '90' }).where(eq(rules.id, brokenRule.id)).run();
    await pipeline.ingest(priceMetric(fixture.monitor.id, '80', '2026-09-14T12:00:01.000Z'));
    expect(execution.getHealth()).toMatchObject({ status: 'healthy', lastError: null });
    await pipeline.close();
    fixture.database.close();
  });

  it('rolls back the rule state when alert persistence fails', async () => {
    const fixture = createFixture();
    const rule = fixture.ruleConfigs.create(ruleInput(fixture.monitor.id));
    fixture.database.sqlite.exec('DROP TABLE alerts');
    const pipeline = createPipeline(fixture.database, fixture.monitors);

    const result = await pipeline.ingest(priceMetric(fixture.monitor.id, '80', '2026-09-14T12:00:00.000Z'));

    expect(result.consumerErrors).toEqual(['1 rule evaluation(s) failed']);
    expect(fixture.database.db.select().from(ruleStates).where(eq(ruleStates.ruleId, rule.id)).get()).toMatchObject({
      state: 'ARMED',
      conditionSince: null,
      lastAlertAt: null,
    });
    await pipeline.close();
    fixture.database.close();
  });

  it('applies rule enablement and condition edits immediately and resolves obsolete alerts', async () => {
    const fixture = createFixture();
    const rule = fixture.ruleConfigs.create(ruleInput(fixture.monitor.id, { enabled: false }));
    const pipeline = createPipeline(fixture.database, fixture.monitors);

    await pipeline.ingest(priceMetric(fixture.monitor.id, '80', '2026-09-14T12:00:00.000Z'));
    expect(fixture.alerts.list({ limit: 50, offset: 0 }).total).toBe(0);

    fixture.ruleConfigs.update(rule.id, { enabled: true });
    await pipeline.ingest(priceMetric(fixture.monitor.id, '80', '2026-09-14T12:00:01.000Z'));
    expect(fixture.alerts.list({ limit: 50, offset: 0 }).total).toBe(1);

    fixture.ruleConfigs.update(rule.id, { threshold: '70' });
    expect(fixture.alerts.list({ limit: 50, offset: 0 }).items[0]?.status).toBe('resolved');
    await pipeline.ingest(priceMetric(fixture.monitor.id, '80', '2026-09-14T12:00:02.000Z'));
    expect(fixture.alerts.list({ limit: 50, offset: 0 }).total).toBe(1);
    expect(fixture.database.db.select().from(ruleStates).where(eq(ruleStates.ruleId, rule.id)).get()?.state).toBe('ARMED');

    await pipeline.close();
    fixture.database.close();
  });

  it('matches rolling change rules only to the metric with the same window', async () => {
    const fixture = createFixture();
    const fiveMinute = fixture.ruleConfigs.create(ruleInput(fixture.monitor.id, {
      name: 'Five minute move',
      metric: 'price_change_percent',
      operator: 'gte',
      threshold: '5',
      windowSeconds: 300,
    }));
    fixture.ruleConfigs.create(ruleInput(fixture.monitor.id, {
      name: 'Fifteen minute move',
      metric: 'price_change_percent',
      operator: 'gte',
      threshold: '5',
      windowSeconds: 900,
    }));
    const pipeline = createPipeline(fixture.database, fixture.monitors);

    await pipeline.ingest({
      ...priceMetric(fixture.monitor.id, '10', '2026-09-14T12:05:00.000Z'),
      name: 'price_change_percent',
      unit: 'percent',
      labels: { windowSeconds: '300' },
    });

    const createdAlerts = fixture.alerts.list({ limit: 50, offset: 0 });
    expect(createdAlerts.total).toBe(1);
    expect(createdAlerts.items[0]?.ruleId).toBe(fiveMinute.id);
    await pipeline.close();
    fixture.database.close();
  });

  it('allows a stale data-age metric to trigger a disconnect rule', async () => {
    const fixture = createFixture();
    const rule = fixture.ruleConfigs.create(ruleInput(fixture.monitor.id, {
      name: 'Market data is stale',
      metric: 'data_age_seconds',
      operator: 'gt',
      threshold: '90',
    }));
    const pipeline = createPipeline(fixture.database, fixture.monitors);

    await pipeline.ingest({
      ...priceMetric(fixture.monitor.id, '91', '2026-09-14T12:05:00.000Z'),
      name: 'data_age_seconds',
      unit: 'seconds',
      status: 'stale',
    });

    const alert = fixture.alerts.list({ limit: 50, offset: 0 }).items[0];
    expect(alert?.ruleId).toBe(rule.id);
    await pipeline.ingest({
      ...priceMetric(fixture.monitor.id, '0', '2026-09-14T12:05:01.000Z'),
      name: 'data_age_seconds',
      unit: 'seconds',
    });
    expect(fixture.alerts.get(String(alert?.id)).status).toBe('resolved');
    await pipeline.close();
    fixture.database.close();
  });
});
