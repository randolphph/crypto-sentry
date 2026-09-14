import { describe, expect, it } from 'vitest';

import { StatusService } from '../src/core/status/status-service.js';
import type { RuntimeComponentHealth, RuntimeHealthProvider } from '../src/core/status/runtime-health.js';
import { createDatabase } from '../src/db/client.js';

class MutableHealthProvider implements RuntimeHealthProvider {
  public health: RuntimeComponentHealth = {
    name: 'rule_engine',
    status: 'healthy',
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
  };

  public getHealth(): RuntimeComponentHealth {
    return { ...this.health };
  }
}

describe('StatusService', () => {
  it('reports runtime component failures as unhealthy and exposes diagnostic state', () => {
    const database = createDatabase(':memory:');
    const runtimeHealth = new MutableHealthProvider();
    const status = new StatusService(database.db, [runtimeHealth]);
    expect(status.summary()).toMatchObject({
      status: 'healthy',
      components: [{ name: 'rule_engine', status: 'healthy' }],
    });

    runtimeHealth.health = {
      name: 'rule_engine',
      status: 'error',
      lastSuccessAt: '2026-09-14T12:00:00.000Z',
      lastErrorAt: '2026-09-14T12:01:00.000Z',
      lastError: '1 rule evaluation(s) failed',
    };
    expect(status.summary()).toMatchObject({
      status: 'unhealthy',
      components: [{
        name: 'rule_engine',
        status: 'error',
        lastError: '1 rule evaluation(s) failed',
      }],
    });
    database.close();
  });
});
