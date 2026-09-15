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
      connectivity: { rpc: 'ok', aaveV3: 'ok' },
      chainId: 1,
      blockNumber: '100',
    });
    expect(response.body).not.toContain('private-key');
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

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: {
        code: 'INTEGRATION_CONNECTION_FAILED',
      },
    });
    expect(response.body).toContain('intrinsic gas too low');
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

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: {
        code: 'RPC_CHAIN_ID_MISMATCH',
        fields: { chainId: 'Expected 1, received 10' },
      },
    });
  });
});
