import { describe, expect, it } from 'vitest';

import { redactLogValue } from '../src/observability/safe-log.js';

describe('safe log redaction', () => {
  it('keeps integration debugging fields while redacting credentials', () => {
    expect(redactLogValue({
      rpcIntegrationId: 'int_rpc',
      chainIds: [4_663],
      walletAddress: '0xwallet',
      rpcUrl: 'https://provider.example/secret',
      headers: { Authorization: 'Bearer secret' },
      tokenId: '123',
      botToken: '123456:secret',
    })).toEqual({
      rpcIntegrationId: 'int_rpc',
      chainIds: [4_663],
      walletAddress: '0xwallet',
      rpcUrl: '[REDACTED]',
      headers: '[REDACTED]',
      tokenId: '123',
      botToken: '[REDACTED]',
    });
  });
});
