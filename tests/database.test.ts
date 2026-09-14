import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/client.js';
import { IntegrationRepository } from '../src/db/repositories/integration-repository.js';
import { EncryptionService } from '../src/security/encryption/encryption-service.js';

describe('SQLite persistence', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('migrates in a transaction, enables WAL/foreign keys, and persists encrypted config', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cryptosentry-test-'));
    directories.push(directory);
    const databasePath = join(directory, 'monitor.sqlite');
    const encryption = new EncryptionService(Buffer.alloc(32, 3));

    const firstDatabase = createDatabase(databasePath);
    const firstRepository = new IntegrationRepository(firstDatabase.db, encryption);
    const integration = firstRepository.create({
      name: 'RPC',
      type: 'evm_rpc',
      provider: 'custom',
      enabled: true,
      config: { chainId: 1, rpcUrl: 'https://rpc.example/database-secret' },
    });
    expect(firstDatabase.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(firstDatabase.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(firstDatabase.sqlite.prepare('SELECT count(*) AS count FROM schema_migrations').get()).toEqual({ count: 1 });
    firstDatabase.close();

    expect(readFileSync(databasePath).includes(Buffer.from('database-secret'))).toBe(false);

    const reopenedDatabase = createDatabase(databasePath);
    const reopenedRepository = new IntegrationRepository(reopenedDatabase.db, encryption);
    expect(reopenedRepository.get(integration.id).config).toEqual({ chainId: 1, rpcUrl: '********' });
    reopenedDatabase.close();
  });
});
