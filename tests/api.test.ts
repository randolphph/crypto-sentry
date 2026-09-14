import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const token = 'test-api-token-that-is-longer-than-32-chars';
const authorization = { authorization: `Bearer ${token}` };

const config: AppConfig = {
  databasePath: ':memory:',
  apiToken: token,
  masterEncryptionKey: Buffer.alloc(32, 9),
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
};

describe('HTTP API foundation', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createApp({ config, logger: false, webSocketFactory: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it('keeps health public and protects business APIs', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/status/summary' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/status/summary', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    const summaryResponse = await app.inject({ method: 'GET', url: '/api/v1/status/summary', headers: authorization });
    expect(summaryResponse.statusCode).toBe(200);
    expect(summaryResponse.json<{ components: Array<{ name: string; status: string }> }>().components).toEqual([
      expect.objectContaining({ name: 'rule_engine', status: 'healthy' }),
    ]);
    const openApi = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(openApi.statusCode).toBe(200);
    const specification = openApi.json<{
      openapi: string;
      paths: Record<string, { post?: { requestBody?: unknown }; get?: { parameters?: unknown } }>;
    }>();
    expect(specification.paths).toHaveProperty('/api/v1/monitors');
    expect(specification.paths['/api/v1/monitors']?.post?.requestBody).toBeDefined();
    expect(specification.paths['/api/v1/alerts']?.get?.parameters).toBeDefined();
  });

  it('creates, encrypts, masks, updates, and deletes an integration', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: authorization,
      payload: {
        name: 'Ethereum Mainnet',
        type: 'evm_rpc',
        provider: 'custom',
        config: { chainId: 1, rpcUrl: 'https://rpc.example/private-key' },
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json<{ id: string; config: Record<string, unknown> }>();
    expect(created.config).toEqual({ chainId: 1, rpcUrl: '********' });
    expect(createResponse.body).not.toContain('private-key');

    const updateResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v1/integrations/${created.id}`,
      headers: authorization,
      payload: { name: 'Ethereum RPC', config: { rpcUrl: '********' } },
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json<{ name: string }>().name).toBe('Ethereum RPC');

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/v1/integrations/${created.id}`,
      headers: authorization,
    });
    expect(deleteResponse.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/v1/integrations/${created.id}`, headers: authorization })).statusCode).toBe(404);
  });

  it('creates monitors and rules and rejects malformed requests', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: authorization,
      payload: { name: '', type: 'unknown' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: { code: string } }>().error.code).toBe('INVALID_REQUEST');

    const integrationResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: authorization,
      payload: {
        name: 'Binance Main',
        type: 'market_data',
        provider: 'binance',
        config: {
          restUrl: 'https://api.binance.com',
          spotWebsocketUrl: 'wss://stream.binance.com:9443',
          futuresWebsocketUrl: 'wss://fstream.binance.com',
        },
      },
    });
    expect(integrationResponse.statusCode).toBe(201);
    const integration = integrationResponse.json<{ id: string }>();

    const monitorResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: authorization,
      payload: {
        name: 'BTCUSDT spot',
        type: 'market',
        config: { integrationId: integration.id, marketType: 'spot', providerSymbol: 'BTCUSDT' },
      },
    });
    expect(monitorResponse.statusCode).toBe(201);
    const monitor = monitorResponse.json<{ id: string }>();

    await expect(app.metricPipeline.ingest({
      monitorId: monitor.id,
      source: 'binance',
      target: 'BTCUSDT',
      name: 'price',
      value: '90123.456789',
      unit: 'USDT',
      observedAt: '2026-09-14T12:00:00.000Z',
      receivedAt: '2026-09-14T12:00:00.100Z',
      status: 'ok',
    })).resolves.toMatchObject({ accepted: true });

    const metricsResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/monitors/${monitor.id}/metrics`,
      headers: authorization,
    });
    expect(metricsResponse.statusCode).toBe(200);
    expect(metricsResponse.json<{ items: Array<{ name: string; value: string }> }>().items).toEqual([
      expect.objectContaining({ name: 'price', value: '90123.456789' }),
    ]);

    const refreshedMonitor = await app.inject({
      method: 'GET',
      url: `/api/v1/monitors/${monitor.id}`,
      headers: authorization,
    });
    expect(refreshedMonitor.json<{ lastStatus: string; lastDataAt: string }>()).toMatchObject({
      lastStatus: 'ok',
      lastDataAt: '2026-09-14T12:00:00.000Z',
    });
    const statusResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/status/summary',
      headers: authorization,
    });
    expect(statusResponse.json<{ status: string; monitors: { healthy: number } }>()).toMatchObject({
      status: 'healthy',
      monitors: { healthy: 1 },
    });

    const ruleResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/rules',
      headers: authorization,
      payload: {
        monitorId: monitor.id,
        name: 'BTC below 90000',
        metric: 'price',
        operator: 'lte',
        threshold: '90000',
        hysteresis: '500',
        severity: 'warning',
      },
    });
    expect(ruleResponse.statusCode).toBe(201);
    expect(ruleResponse.json<{ monitorId: string; threshold: string }>()).toMatchObject({ monitorId: monitor.id, threshold: '90000' });

    const invalidWindowRule = await app.inject({
      method: 'POST',
      url: '/api/v1/rules',
      headers: authorization,
      payload: {
        monitorId: monitor.id,
        name: 'Missing rolling window',
        metric: 'price_change_percent',
        operator: 'lte',
        threshold: '-3',
        severity: 'critical',
      },
    });
    expect(invalidWindowRule.statusCode).toBe(400);
    expect(invalidWindowRule.body).toContain('windowSeconds');

    await app.metricPipeline.ingest({
      monitorId: monitor.id,
      source: 'binance',
      target: 'BTCUSDT',
      name: 'price',
      value: '89999.999999',
      unit: 'USDT',
      observedAt: '2026-09-14T12:00:01.000Z',
      receivedAt: '2026-09-14T12:00:01.100Z',
      status: 'ok',
    });
    const alertsResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/alerts?status=open',
      headers: authorization,
    });
    expect(alertsResponse.statusCode).toBe(200);
    const alertList = alertsResponse.json<{ total: number; items: Array<{ id: string; ruleId: string; currentValue: string }> }>();
    expect(alertList).toMatchObject({
      total: 1,
      items: [expect.objectContaining({
        ruleId: ruleResponse.json<{ id: string }>().id,
        currentValue: '89999.999999',
      })],
    });
    const alertId = alertList.items[0]?.id;
    expect(alertId).toBeDefined();
    const acknowledgeResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/alerts/${String(alertId)}/acknowledge`,
      headers: authorization,
    });
    expect(acknowledgeResponse.json<{ status: string }>().status).toBe('acknowledged');

    await app.metricPipeline.ingest({
      monitorId: monitor.id,
      source: 'binance',
      target: 'BTCUSDT',
      name: 'price',
      value: '90600',
      unit: 'USDT',
      observedAt: '2026-09-14T12:00:02.000Z',
      receivedAt: '2026-09-14T12:00:02.100Z',
      status: 'ok',
    });
    const resolvedAlert = await app.inject({
      method: 'GET',
      url: `/api/v1/alerts/${String(alertId)}`,
      headers: authorization,
    });
    expect(resolvedAlert.json<{ status: string }>().status).toBe('resolved');

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/monitors/${monitor.id}`,
      headers: authorization,
      payload: { enabled: false },
    });
    const metricsAfterDisable = await app.inject({
      method: 'GET',
      url: `/api/v1/monitors/${monitor.id}/metrics`,
      headers: authorization,
    });
    expect(metricsAfterDisable.json<{ items: unknown[] }>().items).toEqual([]);
  });
});
