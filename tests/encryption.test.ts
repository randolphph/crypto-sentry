import { describe, expect, it } from 'vitest';

import { EncryptionService, maskSensitiveConfig } from '../src/security/encryption/encryption-service.js';

describe('integration config encryption', () => {
  it('round-trips data without placing plaintext in the serialized envelope', () => {
    const encryption = new EncryptionService(Buffer.alloc(32, 7));
    const value = { rpcUrl: 'https://rpc.example/private-key', chainId: 1 };
    const encrypted = encryption.encryptJson(value);

    expect(encrypted).not.toContain('private-key');
    expect(encryption.decryptJson(encrypted)).toEqual(value);
  });

  it('masks nested sensitive fields while retaining operational metadata', () => {
    expect(maskSensitiveConfig({
      rpcUrl: 'https://secret',
      chainId: 1,
      nested: { botToken: 'token', chatId: '42' },
    })).toEqual({
      rpcUrl: '********',
      chainId: 1,
      nested: { botToken: '********', chatId: '42' },
    });
  });
});
