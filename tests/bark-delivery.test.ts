import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { sendBarkMessage } from '../src/adapters/notifications/bark-client.js';
import type { AppConfig } from '../src/config.js';
import { AlertDeliveryService } from '../src/core/notifications/alert-delivery-service.js';
import { createDatabase } from '../src/db/client.js';
import { AlertRepository } from '../src/db/repositories/alert-repository.js';
import { IntegrationRepository } from '../src/db/repositories/integration-repository.js';
import { EncryptionService } from '../src/security/encryption/encryption-service.js';
import { redactLogValue } from '../src/observability/safe-log.js';

const secret = 'private-bark-device-key';
const key = Buffer.alloc(32, 7);
const token = 'bark-test-api-token-longer-than-32-chars';
const headers = { authorization: `Bearer ${token}` };
const barkConfig = { serverUrl: 'https://push.example/bark/', deviceKey: secret, group: 'monitoring' };
function response(status: number, code: number) { return Response.json({ code, message: secret }, { status }); }
function config(databasePath: string): AppConfig {
  return { databasePath, apiToken: token, masterEncryptionKey: key, host: '127.0.0.1', port: 3000, logLevel: 'silent' };
}

describe('Bark notification delivery', () => {
  it('posts JSON to /push with the key in the body and checks Bark acknowledgement', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(200, 200));
    expect(await sendBarkMessage(barkConfig, { title: 'Alert', body: 'Details', level: 'timeSensitive' }, fetch)).toEqual({ ok: true });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://push.example/bark/push');
    const request = fetch.mock.calls[0]?.[1];
    expect(request).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(request?.body as string)).toEqual({ device_key: secret, title: 'Alert', body: 'Details', group: 'monitoring', level: 'timeSensitive' });
    fetch.mockResolvedValue(response(200, 400));
    const denied = await sendBarkMessage(barkConfig, { title: 'Alert', body: 'Details' }, fetch);
    expect(denied).toMatchObject({ ok: false, retryable: false, code: 'BARK_REJECTED' });
    expect(JSON.stringify(denied)).not.toContain(secret);
  });

  it('honors rate limits, retries transport failures and rejects invalid config before sending', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ code: 429 }), { status: 429, headers: { 'retry-after': '42' } }));
    expect(await sendBarkMessage(barkConfig, { title: 'Alert', body: 'Details' }, fetch)).toMatchObject({ retryable: true, retryAfterSeconds: 42 });
    fetch.mockRejectedValue(new Error(secret));
    const unavailable = await sendBarkMessage(barkConfig, { title: 'Alert', body: 'Details' }, fetch);
    expect(unavailable).toMatchObject({ retryable: true, code: 'BARK_UNAVAILABLE' });
    expect(JSON.stringify(unavailable)).not.toContain(secret);
    fetch.mockClear();
    expect(await sendBarkMessage({ ...barkConfig, serverUrl: 'file:///tmp/key' }, { title: 'Alert', body: 'Details' }, fetch)).toMatchObject({ retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('encrypts and masks keys, preserves them on edit, and sanitizes test results', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(200, 200));
    const app = await createApp({ config: config(':memory:'), logger: false, webSocketFactory: false, fetch });
    try {
      const created = await app.inject({ method: 'POST', url: '/api/v1/integrations', headers, payload: { name: 'Phone', type: 'notification', provider: 'bark', config: barkConfig } });
      expect(created.statusCode).toBe(201);
      expect(created.body).not.toContain(secret);
      expect(created.json<{ config: { deviceKey: string } }>().config.deviceKey).toBe('********');
      const id = created.json<{ id: string }>().id;
      const edited = await app.inject({ method: 'PATCH', url: `/api/v1/integrations/${id}`, headers, payload: { name: 'Renamed', config: { group: 'new' } } });
      expect(edited.statusCode).toBe(200);
      const test = await app.inject({ method: 'POST', url: `/api/v1/integrations/${id}/test`, headers });
      expect(test.json()).toEqual({ ok: true, provider: 'bark', delivery: { status: 'sent' } });
      expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({ device_key: secret, group: 'new' });
      fetch.mockResolvedValue(response(400, 400));
      const failure = await app.inject({ method: 'POST', url: `/api/v1/integrations/${id}/test`, headers });
      expect(failure.json()).toMatchObject({ ok: false, provider: 'bark', delivery: { status: 'failed' }, error: { code: 'BARK_REJECTED' } });
      expect(failure.body).not.toContain(secret);
      const invalid = await app.inject({ method: 'POST', url: '/api/v1/integrations', headers, payload: { name: 'Invalid', type: 'notification', provider: 'bark', config: { ...barkConfig, serverUrl: 'ftp://push.example' } } });
      expect(invalid.statusCode).toBe(400);
      expect(redactLogValue({ deviceKey: secret, config: { device_key: secret, group: 'monitoring' } })).toEqual({ deviceKey: '[REDACTED]', config: { device_key: '[REDACTED]', group: 'monitoring' } });
    } finally { await app.close(); }
  });

  it('persists default server and grouping for API callers supplying only a device key', async () => {
    const database = createDatabase(':memory:');
    try {
      const integrations = new IntegrationRepository(database.db, new EncryptionService(key));
      const created = integrations.create({ name: 'Phone', type: 'notification', provider: 'bark', enabled: true, config: { deviceKey: secret } });
      expect(created.config).toEqual({ serverUrl: 'https://api.day.app', deviceKey: '********', group: 'CryptoSentry' });
      integrations.update(created.id, { config: { deviceKey: '********', group: 'edited' } });
      expect(integrations.getRuntimeConfig(created.id)).toEqual({ serverUrl: 'https://api.day.app', deviceKey: secret, group: 'edited' });
    } finally { database.close(); }
  });

  it.each([['info', 'active'], ['warning', 'active'], ['critical', 'timeSensitive'], ['emergency', 'critical']])('delivers %s rule alerts as Bark %s without a browser and blocks deletion of referenced targets', async (severity, level) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(200, 200));
    const app = await createApp({ config: config(':memory:'), logger: false, webSocketFactory: false, fetch });
    try {
      const bark = await app.inject({ method: 'POST', url: '/api/v1/integrations', headers, payload: { name: 'Phone', type: 'notification', provider: 'bark', config: barkConfig } });
      const market = await app.inject({ method: 'POST', url: '/api/v1/integrations', headers, payload: { name: 'Binance', type: 'market_data', provider: 'binance', config: { restUrl: 'https://api.binance.com', spotWebsocketUrl: 'wss://stream.binance.com:9443' } } });
      const monitor = await app.inject({ method: 'POST', url: '/api/v1/monitors', headers, payload: { name: 'USDE', type: 'market', config: { integrationId: market.json<{ id: string }>().id, marketType: 'spot', providerSymbol: 'USDEUSDT' } } });
      const id = bark.json<{ id: string }>().id;
      const monitorId = monitor.json<{ id: string }>().id;
      const rule = await app.inject({ method: 'POST', url: '/api/v1/rules', headers, payload: { monitorId, name: 'Depeg', metric: 'price', operator: 'lte', threshold: '0.99', severity, notificationIntegrationIds: [id] } });
      expect(rule.statusCode).toBe(201);
      const now = new Date().toISOString();
      await app.metricPipeline.ingest({ monitorId, source: 'binance', target: 'USDEUSDT', name: 'price', value: '0.98', unit: 'USD', observedAt: now, receivedAt: now, status: 'ok' });
      await vi.waitFor(async () => {
        const alerts = await app.inject({ method: 'GET', url: '/api/v1/alerts', headers });
        expect(alerts.json<{ items: Array<{ delivery: { targets: Array<{ status: string }> } }> }>().items[0]?.delivery.targets[0]?.status).toBe('sent');
        expect(alerts.body).not.toContain(secret);
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({ device_key: secret, group: 'monitoring', level });
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/integrations/${id}`, headers })).statusCode).toBe(409);
    } finally { await app.close(); }
  });

  it('retries pending Bark notifications after process restart and skips disabled targets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cryptosentry-bark-'));
    const path = join(directory, 'monitor.sqlite');
    const open = () => {
      const database = createDatabase(path);
      return { database, alerts: new AlertRepository(database.db), integrations: new IntegrationRepository(database.db, new EncryptionService(key)) };
    };
    try {
      const first = open();
      const integration = first.integrations.create({ name: 'Phone', type: 'notification', provider: 'bark', enabled: true, config: barkConfig });
      const now = new Date().toISOString();
      first.database.sqlite.prepare(`INSERT INTO alerts (id, status, severity, title, message, observed_at, delivery_json, delivery_next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('alert_test', 'open', 'warning', 'Price warning', 'Price below threshold', now, JSON.stringify({ targets: [{ integrationId: integration.id, status: 'pending', attempts: 0 }] }), now, now, now);
      const stored = first.database.sqlite.prepare('SELECT config_ciphertext FROM integrations').get() as { config_ciphertext: string };
      expect(stored.config_ciphertext).not.toContain(secret);
      await new AlertDeliveryService(first.alerts, first.integrations, vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(503, 503))).processDue();
      expect(first.alerts.get('alert_test').delivery).toMatchObject({ targets: [{ status: 'pending', attempts: 1, errorCode: 'BARK_UNAVAILABLE' }] });
      const delivery = first.alerts.get('alert_test').delivery as { targets: Array<Record<string, unknown>> };
      delivery.targets[0]!.nextAttemptAt = new Date(Date.now() - 1_000).toISOString();
      first.database.sqlite.prepare('UPDATE alerts SET delivery_json = ?, delivery_next_attempt_at = ? WHERE id = ?').run(JSON.stringify(delivery), delivery.targets[0]!.nextAttemptAt, 'alert_test');
      first.database.close();
      const second = open();
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(200, 200));
      await new AlertDeliveryService(second.alerts, second.integrations, fetch).processDue();
      expect(second.alerts.get('alert_test').delivery).toMatchObject({ targets: [{ status: 'sent', attempts: 2 }] });
      second.integrations.update(integration.id, { enabled: false });
      delivery.targets[0] = { integrationId: integration.id, status: 'pending', attempts: 0 };
      second.database.sqlite.prepare('UPDATE alerts SET delivery_json = ?, delivery_next_attempt_at = ? WHERE id = ?').run(JSON.stringify(delivery), now, 'alert_test');
      await new AlertDeliveryService(second.alerts, second.integrations, fetch).processDue();
      expect(second.alerts.get('alert_test').delivery).toMatchObject({ targets: [{ status: 'skipped', errorCode: 'INTEGRATION_UNAVAILABLE' }] });
      expect(fetch).toHaveBeenCalledTimes(1);
      second.database.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
