import { describe, expect, it, vi } from 'vitest';

import { createRpcObservabilityFetch, EvmRpcClient, EvmRpcError } from '../src/adapters/evm/evm-rpc-client.js';
import type { EvmChainMismatchError, RpcHttpRequestLog } from '../src/adapters/evm/evm-rpc-client.js';

function rpcResponse(id: number, result: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function rpcRequest(init?: RequestInit): { id: number; method: string } {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON-RPC string body');
  return JSON.parse(init.body) as { id: number; method: string };
}

describe('EvmRpcClient', () => {
  it('observes JSON-RPC methods without logging endpoint or request parameters', async () => {
    const events: RpcHttpRequestLog[] = [];
    const fetchMock = vi.fn(async () => rpcResponse(1, '0x1'));
    const observedFetch = createRpcObservabilityFetch(fetchMock, (event) => events.push(event));

    await observedFetch('https://rpc.example/private-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: ['0xwallet'] }),
    });

    expect(events).toEqual([expect.objectContaining({ methods: ['eth_call'], statusCode: 200, ok: true })]);
    expect(JSON.stringify(events)).not.toContain('private-token');
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(JSON.stringify(events)).not.toContain('0xwallet');
  });

  it('limits concurrent requests shared by clients for the same RPC endpoint', async () => {
    let active = 0;
    let maximumActive = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = rpcRequest(init);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return rpcResponse(request.id, request.method === 'eth_chainId' ? '0x1' : '0x64');
    });
    const clients = Array.from({ length: 10 }, () => new EvmRpcClient({
      rpcUrl: 'https://rpc.example/shared-limit-test', expectedChainId: 1, fetch: fetchMock,
    }));

    await Promise.all(clients.map((client) => client.testConnectivity()));

    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(maximumActive).toBeLessThanOrEqual(8);
  });

  it('checks chain identity and reads the current block number', async () => {
    const methods: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = rpcRequest(init);
      methods.push(request.method);
      if (request.method === 'eth_chainId') return rpcResponse(request.id, '0x1');
      if (request.method === 'eth_blockNumber') return rpcResponse(request.id, '0x12d687');
      throw new Error(`Unexpected method: ${request.method}`);
    });
    const client = new EvmRpcClient({
      rpcUrl: 'https://rpc.example/private-key',
      expectedChainId: 1,
      fetch: fetchMock,
    });

    await expect(client.testConnectivity()).resolves.toEqual({ chainId: 1, blockNumber: '1234567' });
    expect(methods).toEqual(['eth_chainId', 'eth_blockNumber']);
  });

  it('adds routed authentication and chain-selection headers to every request', async () => {
    const headers: Array<Headers> = [];
    const client = new EvmRpcClient({
      rpcUrl: 'https://gateway.example/rpc', expectedChainId: 1,
      headers: { Authorization: 'Bearer secret', 'X-Chain-Id': '1' },
      fetch: async (_input, init) => {
        headers.push(new Headers(init?.headers));
        const request = rpcRequest(init);
        return rpcResponse(request.id, request.method === 'eth_chainId' ? '0x1' : '0x64');
      },
    });
    await client.testConnectivity();
    expect(headers).toHaveLength(2);
    expect(headers.every((value) => value.get('authorization') === 'Bearer secret')).toBe(true);
    expect(headers.every((value) => value.get('x-chain-id') === '1')).toBe(true);
  });

  it('reports chain mismatches explicitly and sanitizes transport failures', async () => {
    const mismatch = new EvmRpcClient({
      rpcUrl: 'https://rpc.example/private-key',
      expectedChainId: 1,
      fetch: async (_input, init) => rpcResponse(rpcRequest(init).id, '0xa'),
    });
    await expect(mismatch.testConnectivity()).rejects.toEqual(expect.objectContaining({
      name: 'EvmChainMismatchError',
      expectedChainId: 1,
      actualChainId: 10,
    } satisfies Partial<EvmChainMismatchError>));

    const failed = new EvmRpcClient({
      rpcUrl: 'https://rpc.example/private-key',
      expectedChainId: 1,
      fetch: async () => { throw new Error('request to https://rpc.example/private-key failed'); },
    });
    const error = await failed.testConnectivity().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(EvmRpcError);
    expect((error as Error).message).toBe('EVM RPC request failed');
    expect((error as Error).message).not.toContain('private-key');
  });
});
