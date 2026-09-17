import { describe, expect, it, vi } from 'vitest';

import { listenWithCleanup } from '../src/app.js';
import { RpcRequestAuditService } from '../src/core/observability/rpc-request-audit-service.js';
import { createDatabase } from '../src/db/client.js';
import { RpcRequestLogRepository } from '../src/db/repositories/rpc-request-log-repository.js';

describe('RPC request audit and startup cleanup', () => {
  it('persists only safe RPC transport metadata and flushes it on close', () => {
    const database = createDatabase(':memory:');
    const repository = new RpcRequestLogRepository(database.db);
    const audit = new RpcRequestAuditService(repository, {
      now: () => new Date('2026-09-17T10:00:00.000Z'),
      flushMilliseconds: 60_000,
    });
    audit.record({ methods: ['eth_call'], durationMilliseconds: 12, statusCode: 200, ok: true }, 'uniswap:mon_1');
    audit.record({ methods: ['eth_getLogs'], durationMilliseconds: 5_001, statusCode: null, ok: false, errorName: 'TimeoutError' });
    audit.close();

    expect(repository.list({ limit: 10 })).toEqual([
      expect.objectContaining({ methods: ['eth_getLogs'], taskId: null, ok: false, errorName: 'TimeoutError' }),
      expect.objectContaining({ methods: ['eth_call'], taskId: 'uniswap:mon_1', ok: true, statusCode: 200 }),
    ]);
    const serialized = JSON.stringify(repository.list({ limit: 10 }));
    expect(serialized).not.toContain('https://');
    expect(serialized).not.toContain('Authorization');
    database.close();
  });

  it('closes an initialized app when binding its listening port fails', async () => {
    const close = vi.fn(async () => undefined);
    const listen = vi.fn(async () => { throw new Error('EADDRINUSE'); });
    await expect(listenWithCleanup({ listen, close } as never, { host: '127.0.0.1', port: 3001 }))
      .rejects.toThrow('EADDRINUSE');
    expect(close).toHaveBeenCalledOnce();
  });
});
