import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const token = 'setup-test-api-token-that-is-long-enough';
const authorization = { authorization: `Bearer ${token}` };
const config: AppConfig = {
  databasePath: ':memory:',
  apiToken: token,
  masterEncryptionKey: Buffer.alloc(32, 6),
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('Integration setup API', () => {
  let app: FastifyInstance;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path === '/api/v3/exchangeInfo') {
      return jsonResponse({ symbols: [
        { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', quotePrecision: 8 },
      ] });
    }
    if (path === '/fapi/v1/exchangeInfo') {
      return jsonResponse({ symbols: [
        { symbol: 'ETHUSDT', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'ETH', quoteAsset: 'USDT', pricePrecision: 2 },
      ] });
    }
    throw new Error(`Unexpected path: ${path}`);
  });

  beforeEach(async () => {
    fetchMock.mockClear();
    app = await createApp({ config, logger: false, fetch: fetchMock, webSocketFactory: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it('publishes the provider catalog and initial readiness', async () => {
    const catalog = await app.inject({ method: 'GET', url: '/api/v1/integrations/catalog', headers: authorization });
    expect(catalog.statusCode).toBe(200);
    const catalogBody = catalog.json<{
      marketData: { providers: Array<{ id: string; requiresCredentials: boolean }> };
      evmRpc: {
        providers: Array<{ id: string }>;
        routingModes: Array<{ id: string }>;
        networks: Array<{ chainId: number; name: string; productEnabled: boolean; capabilities: Record<string, string> }>;
      };
      monitorTypes: Array<{ id: string; status: string; chainIds?: number[]; versions?: string[] }>;
      uniswap: { deployments: Array<{ chainId: number; version: string; positionManagerAddress: string }> };
      samplingPresets: Array<{ id: string; intervalSeconds: number }>;
      ruleMetrics: {
        market: Array<{ id: string; kind: string; requiresWindow: boolean; marketTypes: string[] }>;
        aave_account: Array<{ id: string; kind: string; requiresWindow: boolean }>;
        aave_pool: Array<{ id: string; kind: string; requiresWindow: boolean }>;
      };
    }>();
    expect(catalogBody).toMatchObject({
      marketData: { providers: [{ id: 'binance', requiresCredentials: false }] },
      evmRpc: {
        providers: [{ id: 'alchemy' }, { id: 'infura' }, { id: 'quicknode' }, { id: 'custom' }],
      },
    });
    expect(catalogBody.uniswap.deployments.map(({ chainId, version }) => ({ chainId, version }))).toEqual([
      { chainId: 1, version: 'v3' },
      { chainId: 4_663, version: 'v3' },
      { chainId: 1, version: 'v4' },
      { chainId: 4_663, version: 'v4' },
    ]);
    expect(catalogBody.evmRpc.routingModes.map(({ id }) => id)).toEqual(['fixed', 'url_template', 'header', 'query']);
    expect(catalogBody.evmRpc.networks.find(({ chainId }) => chainId === 1)).toMatchObject({
      productEnabled: true, capabilities: { aaveV3: 'available', uniswapV3: 'available', uniswapV4: 'available' },
    });
    expect(catalogBody.evmRpc.networks.find(({ chainId }) => chainId === 4_663)).toMatchObject({
      productEnabled: true, capabilities: { aaveV3: 'unsupported', uniswapV3: 'available', uniswapV4: 'available' },
    });
    expect(catalogBody.monitorTypes).toEqual(expect.arrayContaining([
      { id: 'aave_pool', status: 'available', chainIds: [1] },
      { id: 'uniswap_wallet', status: 'available', chainIds: [1, 4_663], versions: ['v3', 'v4'] },
    ]));
    expect(catalogBody.samplingPresets).toEqual([
      { id: 'realtime', intervalSeconds: 5 },
      { id: 'standard', intervalSeconds: 20 },
      { id: 'economy', intervalSeconds: 60 },
    ]);
    expect(catalogBody.ruleMetrics.market).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'base_volume_24h', kind: 'gauge', marketTypes: ['spot', 'perpetual'] }),
      expect.objectContaining({ id: 'funding_rate_percent', kind: 'gauge', marketTypes: ['perpetual'] }),
      expect.objectContaining({ id: 'open_interest_change_percent', requiresWindow: true }),
    ]));
    expect(catalogBody.ruleMetrics.aave_account).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'health_factor_infinite', kind: 'gauge' }),
      expect.objectContaining({ id: 'total_collateral_change_percent', requiresWindow: true }),
      expect.objectContaining({ id: 'account_liquidation', kind: 'event' }),
    ]));
    expect(catalogBody.ruleMetrics.aave_pool).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'aave_event_amount_token', kind: 'event' }),
      expect.objectContaining({ id: 'aave_event_amount_usd', kind: 'event' }),
    ]));
    expect(catalogBody.evmRpc.networks).toEqual([
      expect.objectContaining({ chainId: 1, name: 'Ethereum' }),
      expect.objectContaining({ chainId: 42_161, name: 'Arbitrum' }),
      expect.objectContaining({ chainId: 8_453, name: 'Base' }),
      expect.objectContaining({ chainId: 56, name: 'BNB Chain' }),
      expect.objectContaining({ chainId: 4_663, name: 'Robinhood Chain' }),
    ]);

    const readiness = await app.inject({ method: 'GET', url: '/api/v1/integrations/readiness', headers: authorization });
    expect(readiness.json()).toEqual({
      aave: { ready: false, configuredNetworkCount: 0, networks: [] },
      binance: { ready: false, sources: [] },
      uniswap: { ready: false, configuredNetworkCount: 0, networks: [] },
    });
  });

  it('does not report an untested Robinhood Chain RPC as ready', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: authorization,
      payload: {
        name: 'Robinhood Chain',
        type: 'evm_rpc',
        provider: 'custom',
        config: { chainId: 4_663, rpcUrl: 'https://rpc.mainnet.chain.robinhood.com' },
      },
    });
    const readiness = await app.inject({ method: 'GET', url: '/api/v1/integrations/readiness', headers: authorization });

    expect(readiness.json()).toMatchObject({
      aave: { ready: false, configuredNetworkCount: 0 },
      uniswap: {
        ready: false,
        configuredNetworkCount: 0,
        networks: [],
      },
    });
  });

  it('idempotently creates Binance defaults and becomes ready after market sync', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/v1/integrations/binance/default', headers: authorization });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{ created: boolean; integration: { id: string; config: Record<string, unknown> } }>();
    expect(firstBody).toMatchObject({
      created: true,
      integration: {
        name: 'Binance Public Market Data',
        type: 'market_data',
        provider: 'binance',
        enabled: true,
        config: {
          restUrl: 'https://api.binance.com',
          futuresRestUrl: 'https://fapi.binance.com',
          spotWebsocketUrl: 'wss://stream.binance.com:9443',
          futuresWebsocketUrl: 'wss://fstream.binance.com/market',
        },
      },
    });

    const second = await app.inject({ method: 'POST', url: '/api/v1/integrations/binance/default', headers: authorization });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ created: false, integration: { id: firstBody.integration.id } });

    const beforeSync = await app.inject({ method: 'GET', url: '/api/v1/integrations/readiness', headers: authorization });
    expect(beforeSync.json()).toMatchObject({
      binance: { ready: false, sources: [{ integrationId: firstBody.integration.id, enabled: true, marketCount: 0 }] },
    });

    const sync = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${firstBody.integration.id}/sync-markets`,
      headers: authorization,
    });
    expect(sync.statusCode).toBe(200);

    const afterSync = await app.inject({ method: 'GET', url: '/api/v1/integrations/readiness', headers: authorization });
    expect(afterSync.json()).toMatchObject({
      binance: { ready: true, sources: [{ integrationId: firstBody.integration.id, enabled: true, marketCount: 2 }] },
    });
  });

  it('reports supported Alchemy RPC networks as Aave-ready without exposing the URL', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: authorization,
      payload: {
        name: 'Invalid Alchemy RPC',
        type: 'evm_rpc',
        provider: 'alchemy',
        config: { chainId: 0, rpcUrl: 'not-a-url' },
      },
    });
    expect(invalid.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: authorization,
      payload: {
        name: 'Alchemy Ethereum',
        type: 'evm_rpc',
        provider: 'alchemy',
        config: { chainId: 1, rpcUrl: 'https://eth-mainnet.g.alchemy.com/v2/test-credential' },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      provider: 'alchemy', config: { chainIds: [1], routing: { mode: 'fixed' }, rpcUrl: '********' },
    });
    expect(created.body).not.toContain('test-credential');

    const readiness = await app.inject({ method: 'GET', url: '/api/v1/integrations/readiness', headers: authorization });
    expect(readiness.json()).toMatchObject({
      aave: {
        ready: false,
        configuredNetworkCount: 0,
        networks: [],
      },
    });
    expect(readiness.body).not.toContain('test-credential');
  });
});
