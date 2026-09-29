import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
import { BSC_PANCAKE_V3 } from '../src/adapters/pancake/pancake-v3-position-reader.js';
import type { UniswapV3Position } from '../src/adapters/uniswap/uniswap-v3-position-reader.js';
import type { AppConfig } from '../src/config.js';
import type { UniswapV3PositionReaderFactory } from '../src/core/integrations/uniswap-v3-position-coordinator.js';
import type { UniswapPoolReaderFactory } from '../src/core/integrations/uniswap-pool-coordinator.js';

const token = 'pancake-test-api-token-that-is-long-enough';
const authorization = { authorization: `Bearer ${token}` };
const config: AppConfig = {
  databasePath: ':memory:', apiToken: token, masterEncryptionKey: Buffer.alloc(32, 12),
  host: '127.0.0.1', port: 3000, logLevel: 'silent',
};
const wallet = '0x0000000000000000000000000000000000001234' as const;
const poolAddress = '0x0000000000000000000000000000000000000030' as const;
const position: UniswapV3Position = {
  protocol: 'pancakeswap', version: 'v3', chainId: 56, chainName: 'BNB Smart Chain', blockNumber: '5000',
  tokenId: '88', owner: wallet, positionManagerAddress: BSC_PANCAKE_V3.positionManagerAddress, poolAddress,
  token0: { address: '0x0000000000000000000000000000000000000010', symbol: 'USDT', decimals: 18 },
  token1: { address: '0x0000000000000000000000000000000000000020', symbol: 'WBNB', decimals: 18 },
  feeTier: 2500, tickLower: -100, tickUpper: 100, currentTick: 0, liquidity: '1000000', inRange: true,
  tokensOwed0: '1.25', tokensOwed1: '0.01',
};

function rpcResponse(id: number, result: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

describe('PancakeSwap V3 monitoring API', () => {
  let app: FastifyInstance;
  const read = vi.fn(async () => position);
  const discover = vi.fn(async () => ({ blockNumber: 5_000n, tokenIds: ['88'] }));
  const positionFactory: UniswapV3PositionReaderFactory = { create: () => ({ discover, read }) };
  const poolFactory: UniswapPoolReaderFactory = { create: () => ({
    latestBlock: async () => 5_000n,
    describeV3: async () => ({
      chainId: 56, version: 'v3', resourceId: poolAddress.toLowerCase(), poolAddress, poolId: null,
      token0Address: position.token0.address, token0Symbol: position.token0.symbol, token0Decimals: position.token0.decimals,
      token1Address: position.token1.address, token1Symbol: position.token1.symbol, token1Decimals: position.token1.decimals,
      feeTier: position.feeTier, tickSpacing: 50,
    }),
    read: async (_target, _from, to) => ({
      blockNumber: to.toString(), currentTick: 0, token0Price: '600', token1Price: '0.001666666666666666',
      activeLiquidity: '1000000', tvlToken0: '10000', tvlToken1: '20', lpFee: '2500', protocolFee: '0', events: [],
    }),
  }) };
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new Error('Expected JSON-RPC body');
    const request = JSON.parse(init.body) as { id: number; method: string };
    if (request.method === 'eth_chainId') return rpcResponse(request.id, '0x38');
    if (request.method === 'eth_blockNumber') return rpcResponse(request.id, '0x1388');
    if (request.method === 'eth_getCode') return rpcResponse(request.id, '0x6000');
    throw new Error(`Unexpected JSON-RPC method: ${request.method}`);
  });

  beforeEach(async () => {
    read.mockClear(); discover.mockClear(); fetchMock.mockClear();
    app = await createApp({
      config, logger: false, fetch: fetchMock, webSocketFactory: false, pollingMinimumIntervalMilliseconds: 1,
      pancakeV3PositionReaderFactory: positionFactory, pancakePoolReaderFactory: poolFactory,
    });
  });

  afterEach(async () => app.close());

  async function createReadyBscRpc(): Promise<string> {
    const created = await app.inject({
      method: 'POST', url: '/api/v1/integrations', headers: authorization,
      payload: {
        name: 'BSC', type: 'evm_rpc', provider: 'custom',
        config: { chainIds: [56], rpcUrl: 'https://bsc.example/rpc', routing: { mode: 'fixed' } },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    const tested = await app.inject({ method: 'POST', url: `/api/v1/integrations/${id}/test`, headers: authorization });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({
      ok: true, networks: [{ chainId: 56, connectivity: { rpc: 'ok', pancakeV3: 'ok' } }],
    });
    const readiness = await app.inject({ method: 'GET', url: '/api/v1/integrations/readiness', headers: authorization });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({
      pancakeswap: {
        ready: true,
        configuredNetworkCount: 1,
        networks: [{ chainId: 56, name: 'BNB Chain', versions: { v3: true }, integrationIds: [id] }],
      },
    });
    return id;
  }

  it('publishes PancakeSwap capability and discovers directly owned V3 positions', async () => {
    const id = await createReadyBscRpc();
    const response = await app.inject({
      method: 'GET', headers: authorization,
      url: `/api/v1/integrations/${id}/pancakeswap/wallet-positions?walletAddress=${wallet}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok', discovery: { caughtUp: true, scannedThroughBlock: '5000' },
      items: [{ protocol: 'pancakeswap', chainId: 56, tokenId: '88' }], failedPositionCount: 0,
    });
  });

  it('runs position and wallet monitors through the shared metric and snapshot pipeline', async () => {
    const rpcIntegrationId = await createReadyBscRpc();
    for (const [type, target] of [
      ['pancake_position', { chainId: 56, version: 'v3', tokenId: '88' }],
      ['pancake_wallet', { chainIds: [56], versions: ['v3'], walletAddress: wallet }],
    ] as const) {
      const created = await app.inject({
        method: 'POST', url: '/api/v1/monitors', headers: authorization,
        payload: { name: type, type, intervalSeconds: 5, config: { rpcIntegrationId, ...target } },
      });
      expect(created.statusCode).toBe(201);
      const monitorId = created.json<{ id: string }>().id;
      await vi.waitFor(async () => {
        const snapshot = await app.inject({ method: 'GET', url: `/api/v1/monitors/${monitorId}/snapshot`, headers: authorization });
        expect(snapshot.json()).toMatchObject({
          monitorType: type, status: 'ok', data: { protocol: 'pancakeswap', positions: [{ tokenId: '88', inRange: true }] },
        });
      });
      const metrics = await app.inject({ method: 'GET', url: `/api/v1/monitors/${monitorId}/metrics`, headers: authorization });
      expect(metrics.json<{ items: Array<{ source: string }> }>().items.every(({ source }) => source === 'pancakeswap')).toBe(true);
    }
  });

  it('monitors a direct PancakeSwap V3 pool and exposes a normalized snapshot', async () => {
    const rpcIntegrationId = await createReadyBscRpc();
    const created = await app.inject({
      method: 'POST', url: '/api/v1/monitors', headers: authorization,
      payload: {
        name: 'USDT/WBNB', type: 'pancake_pool', intervalSeconds: 5,
        config: { rpcIntegrationId, chainId: 56, version: 'v3', poolAddress },
      },
    });
    expect(created.statusCode).toBe(201);
    const monitorId = created.json<{ id: string }>().id;
    await vi.waitFor(async () => {
      const snapshot = await app.inject({ method: 'GET', url: `/api/v1/monitors/${monitorId}/snapshot`, headers: authorization });
      expect(snapshot.json()).toMatchObject({
        monitorType: 'pancake_pool', status: 'ok',
        data: { pool: { protocol: 'pancakeswap', chainId: 56, version: 'v3', poolAddress, currentTick: '0' } },
      });
    });
  });
});
