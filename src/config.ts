import { z } from 'zod';

const environmentSchema = z.object({
  DATABASE_PATH: z.string().min(1).default('./data/monitor.sqlite'),
  API_TOKEN: z.string().min(32, 'API_TOKEN must contain at least 32 characters'),
  MASTER_ENCRYPTION_KEY: z.string().min(1),
  HOST: z.literal('127.0.0.1').default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface AppConfig {
  databasePath: string;
  apiToken: string;
  masterEncryptionKey: Buffer;
  host: '127.0.0.1';
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const masterEncryptionKey = Buffer.from(parsed.MASTER_ENCRYPTION_KEY, 'base64');

  if (masterEncryptionKey.length !== 32) {
    throw new Error('MASTER_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }

  return {
    databasePath: parsed.DATABASE_PATH,
    apiToken: parsed.API_TOKEN,
    masterEncryptionKey,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
  };
}
