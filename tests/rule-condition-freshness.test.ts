import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const token = 'rule-freshness-api-token-that-is-long-enough';
const authorization = { authorization: `Bearer ${token}` };
const config: AppConfig = {
  databasePath: ':memory:', apiToken: token, masterEncryptionKey: Buffer.alloc(32, 5),
  host: '127.0.0.1', port: 3000, logLevel: 'silent',
};

describe('Rule Group condition freshness', () => {
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
      name: 'Freshness monitor', type: 'market', maxStaleSeconds: 5, config: {
        integrationId: integration.json<{ id: string }>().id, marketType: 'spot', providerSymbol: 'BTCUSDT',
      },
    } });
    monitorId = monitor.json<{ id: string }>().id;
  });

  afterEach(async () => app.close());

  async function createRule(combinator: 'and' | 'or' = 'and', durationSeconds = 0): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/api/v1/rules', headers: authorization, payload: {
      monitorId, name: `${combinator} freshness`, combinator,
      conditions: [
        { metric: 'price', labels: {}, operator: 'gte', threshold: '100' },
        { metric: 'volume', labels: {}, operator: 'gte', threshold: '10' },
      ],
      durationSeconds, cooldownSeconds: 60, severity: 'warning', notificationIntegrationIds: [], enabled: true,
    } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function ingest(name: string, value: string, seconds: number, status: 'ok' | 'error' = 'ok') {
    const timestamp = new Date(Date.parse('2026-09-16T00:00:00.000Z') + seconds * 1000).toISOString();
    await app.metricPipeline.ingest({
      monitorId, source: 'test', target: 'BTCUSDT', name, value,
      observedAt: timestamp, receivedAt: timestamp, status,
    });
  }

  async function alertCount(status?: 'open'): Promise<number> {
    const query = status === undefined ? '' : `?status=${status}`;
    return (await app.inject({ method: 'GET', url: `/api/v1/alerts${query}`, headers: authorization }))
      .json<{ total: number }>().total;
  }

  it('treats an expired true AND condition as unknown and resumes after a fresh update', async () => {
    await createRule('and');
    await ingest('price', '101', 0);
    await ingest('volume', '1', 0);
    await ingest('volume', '11', 6);
    expect(await alertCount()).toBe(0);

    await ingest('price', '102', 7);
    expect(await alertCount()).toBe(1);
  });

  it('allows a fresh true OR condition to trigger when another condition is expired', async () => {
    await createRule('or');
    await ingest('price', '1', 0);
    await ingest('volume', '11', 6);
    expect(await alertCount()).toBe(1);
  });

  it('does not count an unknown interval toward group duration', async () => {
    await createRule('and', 10);
    await ingest('price', '101', 0);
    await ingest('volume', '11', 0);
    await ingest('volume', '12', 6);
    await ingest('price', '102', 7);
    await ingest('volume', '13', 11);
    await ingest('price', '103', 15);
    expect(await alertCount()).toBe(0);
    await ingest('volume', '14', 17);
    expect(await alertCount()).toBe(1);
  });

  it('keeps a triggered rule open when its expression becomes unknown', async () => {
    await createRule('and');
    await ingest('price', '101', 0);
    await ingest('volume', '11', 0);
    expect(await alertCount('open')).toBe(1);

    await ingest('price', '0', 6, 'error');
    expect(await alertCount('open')).toBe(1);
  });

  it('clears cached conditions when a rule is updated', async () => {
    const ruleId = await createRule('and');
    await ingest('price', '101', 0);
    await ingest('volume', '1', 0);

    const updated = await app.inject({
      method: 'PATCH', url: `/api/v1/rules/${ruleId}`, headers: authorization,
      payload: { name: 'Updated rule name' },
    });
    expect(updated.statusCode).toBe(200);
    await ingest('volume', '11', 1);
    expect(await alertCount()).toBe(0);

    await ingest('price', '102', 2);
    expect(await alertCount()).toBe(1);
  });
});
