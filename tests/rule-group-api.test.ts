import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const token = 'rule-group-api-token-that-is-long-enough';
const authorization = { authorization: `Bearer ${token}` };
const config: AppConfig = {
  databasePath: ':memory:', apiToken: token, masterEncryptionKey: Buffer.alloc(32, 7),
  host: '127.0.0.1', port: 3000, logLevel: 'silent',
};

describe('Rule Group API and execution', () => {
  let app: FastifyInstance;
  let monitorId: string;

  beforeEach(async () => {
    app = await createApp({ config, logger: false, webSocketFactory: false });
    const integration = await app.inject({ method: 'POST', url: '/api/v1/integrations', headers: authorization, payload: {
      name: 'Binance', type: 'market_data', provider: 'binance', config: {
        restUrl: 'https://api.binance.com', spotWebsocketUrl: 'wss://stream.binance.com:9443',
      },
    } });
    const monitor = await app.inject({ method: 'POST', url: '/api/v1/monitors', headers: authorization, payload: {
      name: 'BTC', type: 'market', config: {
        integrationId: integration.json<{ id: string }>().id, marketType: 'spot', providerSymbol: 'BTCUSDT',
      },
    } });
    monitorId = monitor.json<{ id: string }>().id;
  });
  afterEach(async () => app.close());

  async function ingest(name: string, value: string, receivedAt: string, status: 'ok' | 'error' = 'ok') {
    await app.metricPipeline.ingest({
      monitorId, source: 'test', target: 'BTCUSDT', name, value,
      observedAt: receivedAt, receivedAt, status,
    });
  }

  it('persists conditions, applies group duration/cooldown and per-condition hysteresis, and preserves triggered state on unknown', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/rules', headers: authorization, payload: {
      monitorId, name: 'Price and volume', combinator: 'and',
      conditions: [
        { metric: 'price', labels: {}, operator: 'gte', threshold: '100', hysteresis: '5' },
        { metric: 'quote_volume_24h', labels: {}, operator: 'gte', threshold: '10', hysteresis: '1' },
      ],
      durationSeconds: 60, cooldownSeconds: 60, severity: 'warning', notificationIntegrationIds: [], enabled: true,
    } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ combinator: 'and', conditions: [{ metric: 'price' }, { metric: 'quote_volume_24h' }] });
    const ruleId = created.json<{ id: string }>().id;

    await ingest('price', '101', '2026-09-15T00:00:00.000Z');
    await ingest('quote_volume_24h', '11', '2026-09-15T00:00:00.000Z');
    await ingest('price', '102', '2026-09-15T00:00:59.000Z');
    expect((await app.inject({ method: 'GET', url: '/api/v1/alerts', headers: authorization })).json<{ total: number }>().total).toBe(0);
    await ingest('quote_volume_24h', '12', '2026-09-15T00:01:00.000Z');
    expect((await app.inject({ method: 'GET', url: '/api/v1/alerts', headers: authorization })).json<{ total: number }>().total).toBe(1);

    await ingest('price', '98', '2026-09-15T00:01:10.000Z');
    await ingest('quote_volume_24h', '12', '2026-09-15T00:01:59.000Z');
    expect((await app.inject({ method: 'GET', url: '/api/v1/alerts', headers: authorization })).json<{ total: number }>().total).toBe(1);
    await ingest('quote_volume_24h', '12', '2026-09-15T00:02:00.000Z');
    expect((await app.inject({ method: 'GET', url: '/api/v1/alerts', headers: authorization })).json<{ total: number }>().total).toBe(2);

    await ingest('quote_volume_24h', '0', '2026-09-15T00:02:01.000Z', 'error');
    const stillOpen = await app.inject({ method: 'GET', url: '/api/v1/alerts?status=open', headers: authorization });
    expect(stillOpen.json<{ total: number }>().total).toBe(2);
    await ingest('price', '94', '2026-09-15T00:02:02.000Z');
    expect((await app.inject({ method: 'GET', url: '/api/v1/alerts?status=open', headers: authorization })).json<{ total: number }>().total).toBe(0);

    const patched = await app.inject({ method: 'PATCH', url: `/api/v1/rules/${ruleId}`, headers: authorization, payload: {
      conditions: [{ metric: 'price', labels: {}, operator: 'gte', threshold: '200', hysteresis: '0' }],
    } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ conditions: [{ threshold: '200' }] });
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/rules/${ruleId}`, headers: authorization });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe('');
  });

  it('implements OR when one condition is true and the other is unknown', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/rules', headers: authorization, payload: {
      monitorId, name: 'Price or volume', combinator: 'or',
      conditions: [
        { metric: 'price', labels: {}, operator: 'gte', threshold: '100' },
        { metric: 'quote_volume_24h', labels: {}, operator: 'gte', threshold: '10' },
      ],
      durationSeconds: 0, cooldownSeconds: 60, severity: 'warning', notificationIntegrationIds: [], enabled: true,
    } });
    await ingest('price', '101', '2026-09-15T00:00:00.000Z');
    expect((await app.inject({ method: 'GET', url: '/api/v1/alerts', headers: authorization })).json<{ total: number }>().total).toBe(1);
  });

  it('validates metric support, windows, labels, and market type from the catalog', async () => {
    const funding = await app.inject({ method: 'POST', url: '/api/v1/rules', headers: authorization, payload: {
      monitorId, name: 'Spot funding', metric: 'funding_rate_percent', operator: 'gte', threshold: '0.01',
      severity: 'warning',
    } });
    expect(funding.statusCode).toBe(400);
    expect(funding.json()).toMatchObject({ error: { code: 'RULE_METRIC_UNSUPPORTED' } });

    const missingWindow = await app.inject({ method: 'POST', url: '/api/v1/rules', headers: authorization, payload: {
      monitorId, name: 'Price move', metric: 'price_change_percent', operator: 'gte', threshold: '3', severity: 'warning',
    } });
    expect(missingWindow.statusCode).toBe(400);
    expect(missingWindow.json()).toMatchObject({ error: { code: 'RULE_CONDITION_INVALID' } });

    const badLabel = await app.inject({ method: 'POST', url: '/api/v1/rules', headers: authorization, payload: {
      monitorId, name: 'Bad label', metric: 'price', labels: { chainId: '1' }, operator: 'gte', threshold: '1', severity: 'warning',
    } });
    expect(badLabel.statusCode).toBe(400);
    const badLabelBody = badLabel.json<{ error: { code: string; fields: Record<string, string> } }>();
    expect(badLabelBody.error.code).toBe('RULE_LABEL_INVALID');
    expect(typeof badLabelBody.error.fields['conditions.0.labels.chainId']).toBe('string');
  });
});
