import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 1;

interface EncryptedEnvelope {
  version: number;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export class EncryptionService {
  public constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Encryption key must contain exactly 32 bytes');
  }

  public encryptJson(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    const envelope: EncryptedEnvelope = {
      version: VERSION,
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    return JSON.stringify(envelope);
  }

  public decryptJson<T>(serialized: string): T {
    const envelope = JSON.parse(serialized) as EncryptedEnvelope;
    if (envelope.version !== VERSION) throw new Error('Unsupported encrypted value version');

    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  }
}

const SENSITIVE_KEY_PATTERN = /(token|secret|password|api[-_]?key|rpc[-_]?url)/i;

export function maskSensitiveConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSensitiveConfig);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === 'headers' && entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const headers = entry as Record<string, unknown>;
      return [key, Object.fromEntries(Object.keys(headers).map((headerName) => [headerName, '********']))];
    }
    return [key, SENSITIVE_KEY_PATTERN.test(key) ? '********' : maskSensitiveConfig(entry)];
  }));
}
