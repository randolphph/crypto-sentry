import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/client.js';
import { IntegrationRepository } from '../src/db/repositories/integration-repository.js';
import { MonitorRepository } from '../src/db/repositories/monitor-repository.js';
import { PriceSampleRepository } from '../src/db/repositories/price-sample-repository.js';
import { EncryptionService } from '../src/security/encryption/encryption-service.js';

describe('PriceSampleRepository', () => {
  const databases: ReturnType<typeof createDatabase>[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('upserts samples and prunes only expired rows for the selected monitor', () => {
    const database = createDatabase(':memory:');
    databases.push(database);
    const integrations = new IntegrationRepository(database.db, new EncryptionService(Buffer.alloc(32, 7)));
    const monitors = new MonitorRepository(database.db);
    const integration = integrations.create({
      name: 'Binance',
      type: 'market_data',
      provider: 'binance',
      enabled: true,
      config: {
        restUrl: 'https://api.binance.com',
        spotWebsocketUrl: 'wss://stream.binance.com:9443',
      },
    });
    const createMonitor = (name: string, symbol: string) => monitors.create({
      name,
      type: 'market',
      enabled: true,
      intervalSeconds: 20,
      maxStaleSeconds: 90,
      config: { integrationId: integration.id, marketType: 'spot', providerSymbol: symbol },
    });
    const first = createMonitor('BTC', 'BTCUSDT');
    const second = createMonitor('ETH', 'ETHUSDT');
    const repository = new PriceSampleRepository(database.db);
    repository.saveAndPrune(first.id, [
      { observedAt: '2026-09-14T11:59:00.000Z', price: '90' },
      { observedAt: '2026-09-14T12:00:00.000Z', price: '100' },
    ], '2026-09-14T11:58:00.000Z');
    repository.saveAndPrune(second.id, [
      { observedAt: '2026-09-14T11:59:00.000Z', price: '200' },
    ], '2026-09-14T11:58:00.000Z');

    repository.saveAndPrune(first.id, [
      { observedAt: '2026-09-14T12:00:00.000Z', price: '101' },
    ], '2026-09-14T12:00:00.000Z');

    expect(repository.loadSince(first.id, '2026-09-14T11:00:00.000Z')).toEqual([
      { observedAt: '2026-09-14T12:00:00.000Z', price: '101' },
    ]);
    expect(repository.loadSince(second.id, '2026-09-14T11:00:00.000Z')).toEqual([
      { observedAt: '2026-09-14T11:59:00.000Z', price: '200' },
    ]);
  });
});
