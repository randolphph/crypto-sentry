import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  ROBINHOOD_UNISWAP_V3,
  type UniswapV3Position,
} from '../src/adapters/uniswap/uniswap-v3-position-reader.js';
import type { AppConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import type { UniswapV3PositionReaderFactory } from '../src/core/integrations/uniswap-v3-position-coordinator.js';

const token = 'position-validation-api-token-long-enough';
const authorization = { authorization: `Bearer ${token}` };
const config: AppConfig = {
  databasePath: ':memory:', apiToken: token, masterEncryptionKey: Buffer.alloc(32, 5),
  host: '127.0.0.1', port: 3000, logLevel: 'silent',
};
const owner = '0x0000000000000000000000000000000000001234' as const;

function rpcRequest(init?: RequestInit): { id: number; method: string } {
  if (typeof init?.body !== 'string') throw new Error('Expected JSON-RPC request');
  return JSON.parse(init.body) as { id: number; method: string };
}

function response(id: number, result: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

describe('Uniswap position identity validation API', () => {
  let app: FastifyInstance;
  let rpcFails = false;
  const read = vi.fn(async (tokenId: string): Promise<UniswapV3Position> => {
    if (!['42', '43'].includes(tokenId)) throw new Error('position does not exist');
    const alternate = tokenId === '43';
    return {
      protocol: 'uniswap' as const, version: 'v3' as const, chainId: 4_663,
      chainName: 'Robinhood Chain' as const, blockNumber: '100', tokenId, owner,
      positionManagerAddress: ROBINHOOD_UNISWAP_V3.positionManagerAddress,
      poolAddress: alternate
        ? '0x0000000000000000000000000000000000000031'
        : '0x0000000000000000000000000000000000000030',
      token0: alternate
        ? { address: '0x0000000000000000000000000000000000000011', symbol: 'WBTC', decimals: 8 }
        : { address: '0x0000000000000000000000000000000000000010', symbol: 'USDG', decimals: 6 },
      token1: alternate
        ? { address: '0x0000000000000000000000000000000000000021', symbol: 'USDC', decimals: 6 }
        : { address: '0x0000000000000000000000000000000000000020', symbol: 'WETH', decimals: 18 },
      feeTier: 500, tickLower: -100, tickUpper: 100, currentTick: 0, liquidity: '1000', inRange: true,
      tokensOwed0: '0', tokensOwed1: '0',
    };
  });
  const readerFactory: UniswapV3PositionReaderFactory = {
    create: () => ({ discover: async () => ({ blockNumber: 100n, tokenIds: ['42', '43', '404'] }), read }),
  };
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    if (rpcFails) throw new Error('temporary provider outage');
    const request = rpcRequest(init);
    if (request.method === 'eth_chainId') return response(request.id, '0x1237');
    if (request.method === 'eth_blockNumber') return response(request.id, '0x64');
    if (request.method === 'eth_getCode') return response(request.id, '0x6000');
    throw new Error(`Unexpected JSON-RPC method ${request.method}`);
  });

  beforeEach(async () => {
    rpcFails = false;
    read.mockClear();
    fetchMock.mockClear();
    app = await createApp({
      config, logger: false, webSocketFactory: false, fetch: fetchMock,
      uniswapV3PositionReaderFactory: readerFactory,
    });
  });

  afterEach(async () => app.close());

  async function readyIntegration(): Promise<string> {
    const created = await app.inject({
      method: 'POST', url: '/api/v1/integrations', headers: authorization,
      payload: {
        name: 'Robinhood', type: 'evm_rpc', provider: 'custom',
        config: { chainId: 4_663, rpcUrl: 'https://rpc.example/secret' },
      },
    });
    const id = created.json<{ id: string }>().id;
    const tested = await app.inject({ method: 'POST', url: `/api/v1/integrations/${id}/test`, headers: authorization });
    expect(tested.json()).toMatchObject({ ok: true, networks: [{ connectivity: { uniswapV3: 'ok' } }] });
    return id;
  }

  it('validates create and identity-changing PATCH before committing, while metadata-only PATCH skips RPC reads', async () => {
    const rpcIntegrationId = await readyIntegration();
    const created = await app.inject({
      method: 'POST', url: '/api/v1/monitors', headers: authorization,
      payload: {
        name: 'LP #42', type: 'uniswap_position', enabled: false,
        config: { rpcIntegrationId, chainId: 4_663, version: 'v3', tokenId: '42' },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(read).toHaveBeenCalledTimes(1);
    const monitorId = created.json<{ id: string }>().id;

    const renamed = await app.inject({
      method: 'PATCH', url: `/api/v1/monitors/${monitorId}`, headers: authorization,
      payload: { name: 'Renamed', intervalSeconds: 30 },
    });
    expect(renamed.statusCode).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);

    const missing = await app.inject({
      method: 'PATCH', url: `/api/v1/monitors/${monitorId}`, headers: authorization,
      payload: { config: { tokenId: '404' } },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'POSITION_NOT_FOUND' } });
    expect((await app.inject({
      method: 'GET', url: `/api/v1/monitors/${monitorId}`, headers: authorization,
    })).json()).toMatchObject({ name: 'Renamed', config: { tokenId: '42' } });
  });

  it('distinguishes a provider outage from a missing position and does not create a monitor', async () => {
    const rpcIntegrationId = await readyIntegration();
    rpcFails = true;
    const failed = await app.inject({
      method: 'POST', url: '/api/v1/monitors', headers: authorization,
      payload: {
        name: 'Unknown LP', type: 'uniswap_position', enabled: false,
        config: { rpcIntegrationId, chainId: 4_663, version: 'v3', tokenId: '404' },
      },
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ error: { code: 'RPC_CONNECTION_FAILED' } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/monitors', headers: authorization })).json())
      .toEqual({ items: [] });
  });

  it('searches discovered wallet positions by token, pool, address, pair, and paginates partial results', async () => {
    const rpcIntegrationId = await readyIntegration();
    const base = `/api/v1/integrations/${rpcIntegrationId}/uniswap/wallet-positions` +
      `?chainId=4663&version=v3&walletAddress=${owner}`;
    for (const query of [
      '42',
      '0x0000000000000000000000000000000000000030',
      '0x0000000000000000000000000000000000000010',
      'USDG',
      'USDG%2FWETH',
      'WETH%2FUSDG',
    ]) {
      const result = await app.inject({
        method: 'GET', url: `${base}&limit=50&q=${query}`, headers: authorization,
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        status: 'partial', items: [{ tokenId: '42', poolAddress: '0x0000000000000000000000000000000000000030' }],
        failedPositionCount: 1,
      });
    }
    const firstPage = await app.inject({ method: 'GET', url: `${base}&limit=1`, headers: authorization });
    expect(firstPage.json()).toMatchObject({ items: [{ tokenId: '42' }], nextCursor: '42' });
    const secondPage = await app.inject({ method: 'GET', url: `${base}&limit=1&cursor=42`, headers: authorization });
    expect(secondPage.json()).toMatchObject({
      status: 'partial', items: [{ tokenId: '43', token0: { symbol: 'WBTC' }, token1: { symbol: 'USDC' } }],
      nextCursor: null, failedPositionCount: 1,
    });
  });
});
