import { describe, expect, it } from 'vitest';

import { normalizeEvmRpcConfig, resolveEvmRpcRequest } from '../src/core/integrations/evm-rpc-config.js';
import { maskSensitiveConfig } from '../src/security/encryption/encryption-service.js';

describe('multi-chain EVM RPC routing', () => {
  it('normalizes legacy single-chain config and enforces fixed routing', () => {
    expect(normalizeEvmRpcConfig({ chainId: 1, rpcUrl: 'https://rpc.example/key' })).toEqual({
      rpcUrl: 'https://rpc.example/key', chainIds: [1], routing: { mode: 'fixed' },
      timeoutMilliseconds: 5_000, multicallBatchSizeBytes: 8_192,
    });
    expect(() => normalizeEvmRpcConfig({
      rpcUrl: 'https://rpc.example', chainIds: [1, 4_663], routing: { mode: 'fixed' },
    })).toThrow();
  });

  it('resolves URL template, Header, and Query routing without leaking sensitive values', () => {
    const urlTemplate = normalizeEvmRpcConfig({
      rpcUrl: 'https://gateway.example/{chainId}/token', chainIds: [1, 4_663], routing: { mode: 'url_template' },
      headers: { Authorization: 'Bearer secret' },
    });
    expect(resolveEvmRpcRequest(urlTemplate, 4_663)).toEqual({
      rpcUrl: 'https://gateway.example/4663/token', headers: { Authorization: 'Bearer secret' },
    });
    const header = normalizeEvmRpcConfig({
      rpcUrl: 'https://gateway.example/rpc', chainIds: [1, 4_663],
      routing: { mode: 'header', headerName: 'X-Chain', valueTemplate: 'chain-{chainId}' },
    });
    expect(resolveEvmRpcRequest(header, 1).headers).toEqual({ 'X-Chain': 'chain-1' });
    const query = normalizeEvmRpcConfig({
      rpcUrl: 'https://gateway.example/rpc?token=secret', chainIds: [1, 4_663],
      routing: { mode: 'query', parameterName: 'chainId' }, headers: { 'X-Key': 'secret-key' },
    });
    expect(resolveEvmRpcRequest(query, 4_663).rpcUrl).toBe('https://gateway.example/rpc?token=secret&chainId=4663');
    expect(maskSensitiveConfig(query)).toMatchObject({ rpcUrl: '********', headers: { 'X-Key': '********' } });
  });
});
