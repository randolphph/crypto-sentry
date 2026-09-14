import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const token = 'binance-test-api-token-that-is-long-enough';
const authorization = { authorization: `Bearer ${token}` };
const config: AppConfig = {
  databasePath: ':memory:',
  apiToken: token,
  masterEncryptionKey: Buffer.alloc(32, 7),
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Binance integration API', () => {
  let app: FastifyInstance;
  let failFuturesDiscovery = false;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path.endsWith('/ping')) return jsonResponse({});
    if (path === '/api/v3/exchangeInfo') {
      return jsonResponse({ symbols: [
        { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', quotePrecision: 8 },
      ] });
    }
    if (path === '/fapi/v1/exchangeInfo') {
      if (failFuturesDiscovery) return jsonResponse({ message: 'maintenance' }, 503);
      return jsonResponse({ symbols: [
        { symbol: 'ETHUSDT', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'ETH', quoteAsset: 'USDT', pricePrecision: 2 },
      ] });
    }
    throw new Error(`Unexpected path: ${path}`);
  });

  beforeEach(async () => {
    failFuturesDiscovery = false;
    fetchMock.mockClear();
    app = await createApp({ config, logger: false, fetch: fetchMock });
  });

  afterEach(async () => {
    await app.close();
  });

  it('tests connectivity, synchronizes markets, and preserves cache on a partial upstream failure', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: authorization,
      payload: {
        name: 'Binance Main',
        type: 'market_data',
        provider: 'binance',
        config: {
          restUrl: 'https://spot.example',
          spotWebsocketUrl: 'wss://spot-stream.example',
          futuresWebsocketUrl: 'wss://futures-stream.example',
        },
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const integrationId = createResponse.json<{ id: string }>().id;

    const testResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${integrationId}/test`,
      headers: authorization,
    });
    expect(testResponse.statusCode).toBe(200);
    expect(testResponse.json()).toEqual({
      ok: true,
      provider: 'binance',
      connectivity: { spot: 'ok', perpetual: 'ok' },
    });

    const syncResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${integrationId}/sync-markets`,
      headers: authorization,
    });
    expect(syncResponse.statusCode).toBe(200);
    expect(syncResponse.json()).toMatchObject({ total: 2, spot: 1, perpetual: 1 });

    const listMarkets = async () => app.inject({
      method: 'GET',
      url: `/api/v1/integrations/${integrationId}/markets`,
      headers: authorization,
    });
    const listResponse = await listMarkets();
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<{ items: Array<{ providerSymbol: string; canonicalSymbol: string }> }>().items).toEqual([
      expect.objectContaining({ providerSymbol: 'ETHUSDT', canonicalSymbol: 'ETH/USD' }),
      expect.objectContaining({ providerSymbol: 'BTCUSDT', canonicalSymbol: 'BTC/USD' }),
    ]);

    failFuturesDiscovery = true;
    const failedSync = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${integrationId}/sync-markets`,
      headers: authorization,
    });
    expect(failedSync.statusCode).toBe(502);
    expect(failedSync.json<{ error: { code: string } }>().error.code).toBe('INTEGRATION_CONNECTION_FAILED');
    expect((await listMarkets()).json<{ items: unknown[] }>().items).toHaveLength(2);
  });

  it('rejects operations for a disabled Binance integration without network access', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: authorization,
      payload: {
        name: 'Disabled Binance',
        type: 'market_data',
        provider: 'binance',
        enabled: false,
        config: {
          restUrl: 'https://spot.example',
          spotWebsocketUrl: 'wss://spot-stream.example',
          futuresWebsocketUrl: 'wss://futures-stream.example',
        },
      },
    });
    const integrationId = createResponse.json<{ id: string }>().id;
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${integrationId}/test`,
      headers: authorization,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INTEGRATION_DISABLED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
