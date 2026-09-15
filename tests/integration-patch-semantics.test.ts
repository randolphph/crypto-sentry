import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/client.js';
import type { AppDatabase } from '../src/db/client.js';
import { IntegrationRepository } from '../src/db/repositories/integration-repository.js';
import { EncryptionService } from '../src/security/encryption/encryption-service.js';

describe('EVM RPC integration PATCH semantics', () => {
  let database: AppDatabase;
  let repository: IntegrationRepository;

  beforeEach(() => {
    database = createDatabase(':memory:');
    repository = new IntegrationRepository(database.db, new EncryptionService(Buffer.alloc(32, 6)));
  });

  afterEach(() => database.close());

  function createHeaderIntegration() {
    return repository.create({
      name: 'Gateway', type: 'evm_rpc', provider: 'custom', enabled: true,
      config: {
        rpcUrl: 'https://gateway.example/secret-token',
        chainIds: [1, 4_663],
        routing: { mode: 'header', headerName: 'X-Chain', valueTemplate: 'chain-{chainId}' },
        headers: { Authorization: 'Bearer private', 'X-Remove-Me': 'delete-me' },
      },
    });
  }

  it('replaces header routing with query routing and preserves only submitted masked secrets', () => {
    const integration = createHeaderIntegration();

    repository.update(integration.id, { config: {
      rpcUrl: '********',
      routing: { mode: 'query', parameterName: 'chainId' },
      headers: { Authorization: '********' },
    } });

    expect(repository.getRuntimeConfig(integration.id)).toMatchObject({
      rpcUrl: 'https://gateway.example/secret-token',
      routing: { mode: 'query', parameterName: 'chainId' },
      headers: { Authorization: 'Bearer private' },
    });
    expect(repository.getRuntimeConfig(integration.id)).not.toHaveProperty('headers.X-Remove-Me');
    expect(repository.get(integration.id)).toMatchObject({
      config: {
        rpcUrl: '********',
        routing: { mode: 'query', parameterName: 'chainId' },
        headers: { Authorization: '********' },
      },
    });
    expect((repository.get(integration.id).config as { routing: unknown }).routing)
      .toEqual({ mode: 'query', parameterName: 'chainId' });
  });

  it('replaces query routing with fixed routing without retaining old fields', () => {
    const integration = repository.create({
      name: 'Query gateway', type: 'evm_rpc', provider: 'custom', enabled: true,
      config: {
        rpcUrl: 'https://gateway.example/rpc', chainIds: [1],
        routing: { mode: 'query', parameterName: 'network' },
      },
    });

    repository.update(integration.id, { config: { routing: { mode: 'fixed' } } });

    expect(repository.getRuntimeConfig(integration.id).routing).toEqual({ mode: 'fixed' });
  });

  it('replaces header routing with a URL template', () => {
    const integration = createHeaderIntegration();

    repository.update(integration.id, { config: {
      rpcUrl: 'https://gateway.example/{chainId}/rpc',
      routing: { mode: 'url_template' },
    } });

    expect(repository.getRuntimeConfig(integration.id).routing).toEqual({
      mode: 'url_template', chainIdPlaceholder: '{chainId}',
    });
  });

  it('clears all static headers when headers is null', () => {
    const integration = createHeaderIntegration();

    repository.update(integration.id, { config: { headers: null } });

    expect(repository.getRuntimeConfig(integration.id)).not.toHaveProperty('headers');
  });
});
