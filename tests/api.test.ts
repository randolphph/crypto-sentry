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
    app = await createApp({ config, logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it('keeps health public and protects business APIs', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/status/summary' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/status/summary', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/status/summary', headers: authorization })).statusCode).toBe(200);
    const openApi = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(openApi.statusCode).toBe(200);
    expect(openApi.json<{ openapi: string; paths: Record<string, unknown> }>().paths).toHaveProperty('/api/v1/monitors');
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
  });
});
