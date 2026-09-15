import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const token = 'evm-test-api-token-that-is-long-enough';
const authorization = { authorization: `Bearer ${token}` };
const config: AppConfig = {
  databasePath: ':memory:',
  apiToken: token,
  masterEncryptionKey: Buffer.alloc(32, 8),
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
};

function rpcRequest(init?: RequestInit): { id: number; method: string; params?: unknown[] } {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON-RPC string body');
  return JSON.parse(init.body) as { id: number; method: string; params?: unknown[] };
}

function rpcResponse(id: number, result: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function rpcError(id: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32_000, message } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('EVM RPC integration API', () => {
  let app: FastifyInstance;
  let actualChainId = 1;
  let contractCallsFail = false;
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const request = rpcRequest(init);
    if (request.method === 'eth_chainId') return rpcResponse(request.id, `0x${actualChainId.toString(16)}`);
    if (request.method === 'eth_blockNumber') return rpcResponse(request.id, '0x64');
    if (request.method === 'eth_getCode') return rpcResponse(request.id, '0x6000');
    if (request.method === 'eth_call') {
      if (contractCallsFail) return rpcError(request.id, 'intrinsic gas too low');
      const transaction = request.params?.[0] as { data?: string } | undefined;
      const result = transaction?.data === '0x8c89b64f'
        ? `0x${(100_000_000n).toString(16).padStart(64, '0')}`
        : `0x${'0'.repeat(64 * 6)}`;
      return rpcResponse(request.id, result);
    }
    throw new Error(`Unexpected JSON-RPC method: ${request.method}`);
  });

  beforeEach(async () => {
    actualChainId = 1;
    contractCallsFail = false;
    fetchMock.mockClear();
    app = await createApp({ config, logger: false, fetch: fetchMock, webSocketFactory: false });
  });

  afterEach(async () => {
    await app.close();
  });

  async function createRpcIntegration() {
    return app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: authorization,
      payload: {
        name: 'Ethereum Mainnet',
        type: 'evm_rpc',
        provider: 'alchemy',
        config: { chainId: 1, rpcUrl: 'https://rpc.example/private-key' },
      },
    });
  }

  async function createRobinhoodRpcIntegration() {
    return app.inject({
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
  }

  it('returns the stable routing error for an invalid fixed multi-chain config', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/integrations', headers: authorization,
      payload: {
        name: 'Invalid fixed gateway', type: 'evm_rpc', provider: 'custom',
        config: { rpcUrl: 'https://gateway.example/rpc', chainIds: [1, 4_663], routing: { mode: 'fixed' } },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'RPC_ROUTING_CONFIG_INVALID' } });
  });

  it('returns the verified chain and latest block without exposing the RPC credential', async () => {
    const created = await createRpcIntegration();
    const integrationId = created.json<{ id: string }>().id;
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${integrationId}/test`,
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      provider: 'alchemy',
      networks: [{
        chainId: 1,
        chainName: 'Ethereum',
        ok: true,
        blockNumber: '100',
        connectivity: { rpc: 'ok', aaveV3: 'ok' },
        error: null,
      }],
    });
    expect(response.body).not.toContain('private-key');
    const readiness = await app.inject({ method: 'GET', url: '/api/v1/integrations/readiness', headers: authorization });
    expect(readiness.json()).toMatchObject({
      aave: { ready: true, networks: [{ chainId: 1, ready: true, integrationIds: [integrationId] }] },
    });
    await app.inject({
      method: 'PATCH', url: `/api/v1/integrations/${integrationId}`, headers: authorization,
      payload: { config: { timeoutMilliseconds: 6_000 } },
    });
    const invalidated = await app.inject({ method: 'GET', url: '/api/v1/integrations/readiness', headers: authorization });
    expect(invalidated.json()).toMatchObject({ aave: { ready: false, networks: [] } });
  });

  it('rejects an RPC that answers basic probes but cannot read Aave contracts', async () => {
    const created = await createRpcIntegration();
    const integrationId = created.json<{ id: string }>().id;
    contractCallsFail = true;

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${integrationId}/test`,
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: false,
      networks: [{ connectivity: { rpc: 'ok', aaveV3: 'error' }, error: { code: 'RPC_CONNECTION_FAILED' } }],
    });
    expect(response.body).not.toContain('intrinsic gas too low');
  });

  it('verifies official Uniswap V3 contracts on Robinhood Chain', async () => {
    actualChainId = 4_663;
    const created = await createRobinhoodRpcIntegration();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${created.json<{ id: string }>().id}/test`,
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      networks: [{
        chainId: 4_663,
        connectivity: { rpc: 'ok', uniswapV3: 'ok', uniswapV4: 'ok' },
      }],
    });
    const readiness = await app.inject({ method: 'GET', url: '/api/v1/integrations/readiness', headers: authorization });
    expect(readiness.json()).toMatchObject({
      uniswap: { ready: true, networks: [{ chainId: 4_663, versions: { v3: true, v4: true } }] },
    });
  });

  it('rejects a different network with the expected and actual chain IDs', async () => {
    const created = await createRpcIntegration();
    const integrationId = created.json<{ id: string }>().id;
    actualChainId = 10;
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${integrationId}/test`,
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: false,
      networks: [{ chainId: 1, error: { code: 'RPC_CHAIN_ID_MISMATCH' } }],
    });
  });

  it('tests every routed network and preserves a successful chain when another fails', async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const request = rpcRequest(init);
      const targetChainId = url.pathname.includes('/4663/') ? 4_663 : 1;
      if (request.method === 'eth_chainId') {
        const returnedChainId = targetChainId === 4_663 ? 4_664 : targetChainId;
        return rpcResponse(request.id, `0x${returnedChainId.toString(16)}`);
      }
      if (request.method === 'eth_blockNumber') return rpcResponse(request.id, '0x64');
      if (request.method === 'eth_getCode') return rpcResponse(request.id, '0x6000');
      if (request.method === 'eth_call') {
        const transaction = request.params?.[0] as { data?: string } | undefined;
        return rpcResponse(request.id, transaction?.data === '0x8c89b64f'
          ? `0x${(100_000_000n).toString(16).padStart(64, '0')}`
          : `0x${'0'.repeat(64 * 6)}`);
      }
      throw new Error(`Unexpected JSON-RPC method: ${request.method}`);
    });
    const created = await app.inject({
      method: 'POST', url: '/api/v1/integrations', headers: authorization,
      payload: {
        name: 'Multi-chain gateway', type: 'evm_rpc', provider: 'custom',
        config: {
          rpcUrl: 'https://gateway.example/{chainId}/rpc', chainIds: [1, 4_663],
          routing: { mode: 'url_template' }, headers: { Authorization: 'Bearer private-token' },
        },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('private-token');
    const response = await app.inject({
      method: 'POST', url: `/api/v1/integrations/${created.json<{ id: string }>().id}/test`, headers: authorization,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: false,
      networks: [
        { chainId: 1, ok: true, connectivity: { rpc: 'ok', aaveV3: 'ok' }, error: null },
        { chainId: 4_663, ok: false, connectivity: { rpc: 'error' }, error: { code: 'RPC_CHAIN_ID_MISMATCH' } },
      ],
    });
    expect(response.body).not.toContain('gateway.example');
    expect(response.body).not.toContain('private-token');
  });
});
