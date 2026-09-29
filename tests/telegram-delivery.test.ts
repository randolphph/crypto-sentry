import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import type { request as httpsRequest } from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { createTelegramIpv4Fetch, sendTelegramMessage } from '../src/adapters/notifications/telegram-client.js';
import type { AppConfig } from '../src/config.js';
import { AlertDeliveryService } from '../src/core/notifications/alert-delivery-service.js';
import { formatTelegramAlert } from '../src/core/notifications/telegram-alert-message.js';
import { createDatabase } from '../src/db/client.js';
import { AlertRepository } from '../src/db/repositories/alert-repository.js';
import { IntegrationRepository } from '../src/db/repositories/integration-repository.js';
import { EncryptionService } from '../src/security/encryption/encryption-service.js';

const token = 'telegram-test-api-token-longer-than-32-chars';
const headers = { authorization: `Bearer ${token}` };
const secret = '123456:telegram-secret-must-never-appear';
const key = Buffer.alloc(32, 7);
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function config(databasePath: string): AppConfig {
  return { databasePath, apiToken: token, masterEncryptionKey: key, host: '127.0.0.1', port: 3000, logLevel: 'silent' };
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Telegram notification delivery', () => {
  it('uses an IPv4-only HTTPS transport for production Telegram requests', async () => {
    let options: RequestOptions | undefined;
    const request = ((requestOptions: RequestOptions, callback: (response: IncomingMessage) => void) => {
      options = requestOptions;
      const outgoing = new EventEmitter() as ClientRequest;
      outgoing.end = vi.fn(() => {
        const incoming = new EventEmitter() as IncomingMessage;
        incoming.statusCode = 200;
        incoming.headers = { 'content-type': 'application/json' };
        callback(incoming);
        incoming.emit('data', Buffer.from('{"ok":true,"result":{"message_id":1}}'));
        incoming.emit('end');
        return outgoing;
      }) as ClientRequest['end'];
      outgoing.destroy = vi.fn(() => outgoing);
      return outgoing;
    }) as unknown as typeof httpsRequest;

    const fetch = createTelegramIpv4Fetch(request);
    const response = await fetch('https://api.telegram.org/bot123:test/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });

    expect(options).toMatchObject({ hostname: 'api.telegram.org', port: 443, family: 4, method: 'POST' });
    expect(await response.json()).toEqual({ ok: true, result: { message_id: 1 } });
  });

  it('formats alerts as a concise Chinese summary', () => {
    const message = formatTelegramAlert({
      alertId: 'alert_1', targetIndex: 0, integrationId: 'telegram_1', attempts: 1,
      alertStatus: 'open', severity: 'warning', title: '[WARNING] Alert: USDE 脱锚',
      message: [
        'Rule: USDE depeg',
        'Target: USDEUSDT',
        'Labels: marketType=spot, providerSymbol=USDEUSDT',
        'Metric: price',
        'Current value: 0.98 USD',
        'Condition group: AND (1 conditions)',
        'Observed at: 2026-09-23T06:27:00.000Z',
      ].join('\n'),
      currentValue: '0.98', observedAt: '2026-09-23T06:27:00.000Z',
    });

    expect(message).toBe('🟠 警告｜USDE 脱锚\n对象：USDEUSDT\n当前：0.98 USD\n时间：09-23 14:27（北京时间）');
    expect(message).not.toMatch(/Rule:|Labels:|Metric:|Condition group:|Observed at:/u);
  });

  it('formats price movement with a percent sign, three decimals, and the trigger price', () => {
    const message = formatTelegramAlert({
      alertId: 'alert_move', targetIndex: 0, integrationId: 'telegram_1', attempts: 1,
      alertStatus: 'open', severity: 'warning', title: '[WARNING] Alert: BTC 5 分钟价格波动',
      message: [
        'Rule: BTC 5 分钟价格波动',
        'Target: BTC/USDT',
        'Labels: canonicalSymbol=BTC/USDT, marketType=spot, windowSeconds=300',
        'Metric: price_change_percent',
        'Current value: 0.12356789 percent',
        'Current price: 109900.00001 USDT',
        'Condition group: AND (1 conditions)',
        'Observed at: 2026-09-23T06:27:00.000Z',
      ].join('\n'),
      currentValue: '0.12356789', observedAt: '2026-09-23T06:27:00.000Z',
    });

    expect(message).toBe([
      '🟠 警告｜BTC 5 分钟价格波动',
      '对象：BTC/USDT',
      '波动：0.124%',
      '当前价格：109,900 USDT',
      '时间：09-23 14:27（北京时间）',
    ].join('\n'));
    expect(message).not.toContain('percent');
  });

  it('formats Uniswap LP alerts with Chinese metric names and readable position details', () => {
    const message = formatTelegramAlert({
      alertId: 'alert_lp', targetIndex: 0, integrationId: 'telegram_1', attempts: 1,
      alertStatus: 'open', severity: 'critical', title: '[CRITICAL] Alert: Uniswap LP out of range',
      message: [
        'Rule: Uniswap LP out of range',
        'Target: 123456',
        'Labels: chainId=4663, token0Address=0x01, token0Symbol=WETH, token1Address=0x02, token1Symbol=USDC, tokenId=123456, version=v4',
        'Metric: in_range',
        'Current value: false boolean',
        'Condition group: AND (1 conditions)',
        'Observed at: 2026-09-23T06:27:00.000Z',
      ].join('\n'),
      currentValue: 'false', observedAt: '2026-09-23T06:27:00.000Z',
    });

    expect(message).toBe('🔴 严重告警｜LP 已离开价格区间\n仓位：WETH/USDC · V4 · #123456\n时间：09-23 14:27（北京时间）');
    expect(message).not.toMatch(/Uniswap|out of range|boolean|token0|chainId/u);
  });

  it('formats Uniswap LP values with concise localized units', () => {
    const message = formatTelegramAlert({
      alertId: 'alert_lp_value', targetIndex: 0, integrationId: 'telegram_1', attempts: 1,
      alertStatus: 'open', severity: 'warning', title: '[WARNING] Reminder: Position value',
      message: [
        'Rule: Position value',
        'Target: 42',
        'Labels: chainId=1, token0Symbol=WETH, token1Symbol=USDC, tokenId=42, version=v3',
        'Metric: position_value_usd',
        'Current value: 12345.678901234 USD',
      ].join('\n'),
      currentValue: '12345.678901234', observedAt: '2026-09-23T06:27:00.000Z',
    });

    expect(message).toBe('🟠 警告（再次提醒）｜LP 仓位价值\n仓位：WETH/USDC · V3 · #42\n当前：$12,345.678901\n时间：09-23 14:27（北京时间）');
  });

  it('identifies PancakeSwap V3 alerts while keeping the message concise', () => {
    const message = formatTelegramAlert({
      alertId: 'alert_pancake', targetIndex: 0, integrationId: 'telegram_1', attempts: 1,
      alertStatus: 'open', severity: 'critical', title: '[CRITICAL] Alert: Pancake range',
      message: [
        'Rule: Pancake range',
        'Target: 88',
        'Labels: protocol=pancakeswap, chainId=56, token0Symbol=USDT, token1Symbol=WBNB, tokenId=88, version=v3',
        'Metric: in_range',
        'Current value: false boolean',
      ].join('\n'),
      currentValue: 'false', observedAt: '2026-09-23T06:27:00.000Z',
    });

    expect(message).toBe('🔴 严重告警｜PancakeSwap LP 已离开价格区间\n仓位：USDT/WBNB · V3 · #88\n时间：09-23 14:27（北京时间）');
  });

  it('uses the Telegram retry-after value without exposing the API description', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(429, {
      ok: false, error_code: 429, description: `rate limited ${secret}`, parameters: { retry_after: 42 },
    }));
    await expect(sendTelegramMessage({ botToken: secret, chatId: '-123' }, 'test', fetch)).resolves.toEqual({
      ok: false, code: 'TELEGRAM_RATE_LIMITED', message: 'Telegram rate limit reached',
      retryable: true, retryAfterSeconds: 42,
    });
  });

  it('sends a test message and returns only sanitized results', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(200, { ok: true, result: { message_id: 1 } }));
    const app = await createApp({ config: config(':memory:'), logger: false, webSocketFactory: false, fetch });
    try {
      const created = await app.inject({ method: 'POST', url: '/api/v1/integrations', headers, payload: {
        name: 'Telegram', type: 'notification', provider: 'telegram', config: { botToken: secret, chatId: '-123' },
      } });
      expect(created.statusCode).toBe(201);
      expect(created.body).not.toContain(secret);
      const id = created.json<{ id: string }>().id;
      const success = await app.inject({ method: 'POST', url: `/api/v1/integrations/${id}/test`, headers });
      expect(success.json()).toEqual({ ok: true, provider: 'telegram', delivery: { status: 'sent' } });
      expect(fetch).toHaveBeenCalledWith(`https://api.telegram.org/bot${secret}/sendMessage`, expect.objectContaining({ method: 'POST' }));
      fetch.mockResolvedValue(response(400, { ok: false, error_code: 400, description: `bad chat ${secret}` }));
      const failure = await app.inject({ method: 'POST', url: `/api/v1/integrations/${id}/test`, headers });
      expect(failure.json()).toEqual({ ok: false, provider: 'telegram', delivery: { status: 'failed' }, error: {
        code: 'TELEGRAM_BAD_REQUEST', message: 'Telegram rejected the chat or message',
      } });
      expect(failure.body).not.toContain(secret);
    } finally {
      await app.close();
    }
  });

  it('delivers a rule alert and persists a terminal Telegram error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(403, {
      ok: false, error_code: 403, description: `forbidden ${secret}`,
    }));
    const app = await createApp({ config: config(':memory:'), logger: false, webSocketFactory: false, fetch });
    try {
      const telegram = await app.inject({ method: 'POST', url: '/api/v1/integrations', headers, payload: {
        name: 'Telegram', type: 'notification', provider: 'telegram', config: { botToken: secret, chatId: '-123' },
      } });
      const market = await app.inject({ method: 'POST', url: '/api/v1/integrations', headers, payload: {
        name: 'Binance', type: 'market_data', provider: 'binance', config: {
          restUrl: 'https://api.binance.com', spotWebsocketUrl: 'wss://stream.binance.com:9443',
        },
      } });
      const monitor = await app.inject({ method: 'POST', url: '/api/v1/monitors', headers, payload: {
        name: 'USDE', type: 'market', config: {
          integrationId: market.json<{ id: string }>().id, marketType: 'spot', providerSymbol: 'USDEUSDT',
        },
      } });
      const rule = await app.inject({ method: 'POST', url: '/api/v1/rules', headers, payload: {
        monitorId: monitor.json<{ id: string }>().id, name: 'Depeg', metric: 'price', operator: 'lte',
        threshold: '0.99', severity: 'warning', notificationIntegrationIds: [telegram.json<{ id: string }>().id],
      } });
      expect(rule.statusCode).toBe(201);
      const timestamp = new Date().toISOString();
      await app.metricPipeline.ingest({
        monitorId: monitor.json<{ id: string }>().id, source: 'binance', target: 'USDEUSDT',
        name: 'price', value: '0.98', unit: 'USD', observedAt: timestamp, receivedAt: timestamp, status: 'ok',
      });
      await vi.waitFor(async () => {
        const list = await app.inject({ method: 'GET', url: '/api/v1/alerts', headers });
        const item = list.json<{ items: Array<{ delivery: { targets: Array<{ status: string; attempts: number; errorCode: string }> } }> }>()
          .items[0];
        expect(item?.delivery.targets[0]).toMatchObject({
          status: 'failed', attempts: 1, errorCode: 'TELEGRAM_FORBIDDEN',
        });
        expect(list.body).not.toContain(secret);
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('retries a persisted pending target after restart and records sent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cryptosentry-telegram-'));
    tempDirectories.push(directory);
    const path = join(directory, 'monitor.sqlite');
    const open = () => {
      const database = createDatabase(path);
      const alerts = new AlertRepository(database.db);
      const integrations = new IntegrationRepository(database.db, new EncryptionService(key));
      return { database, alerts, integrations };
    };
    const first = open();
    const integration = first.integrations.create({
      name: 'Telegram', type: 'notification', provider: 'telegram', enabled: true,
      config: { botToken: secret, chatId: '-123' },
    });
    const now = new Date().toISOString();
    first.database.sqlite.prepare(`INSERT INTO alerts
      (id, status, severity, title, message, observed_at, delivery_json, delivery_next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'alert_test', 'open', 'warning', 'Price warning', 'Price below threshold', now,
      JSON.stringify({ targets: [{ integrationId: integration.id, status: 'pending', attempts: 0 }] }), now, now, now,
    );
    const failedFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(503, { ok: false }));
    await new AlertDeliveryService(first.alerts, first.integrations, failedFetch).processDue();
    expect(first.alerts.get('alert_test').delivery).toMatchObject({ targets: [{ status: 'pending', attempts: 1,
      errorCode: 'TELEGRAM_UNAVAILABLE' }] });
    first.database.close();

    const second = open();
    const delivery = second.alerts.get('alert_test').delivery as { targets: Array<Record<string, unknown>> };
    delivery.targets[0]!.nextAttemptAt = new Date(Date.now() - 1_000).toISOString();
    second.database.sqlite.prepare('UPDATE alerts SET delivery_json = ?, delivery_next_attempt_at = ? WHERE id = ?')
      .run(JSON.stringify(delivery), delivery.targets[0]!.nextAttemptAt, 'alert_test');
    second.database.close();
    const successFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(200, { ok: true, result: { message_id: 5 } }));
    const restartedApp = await createApp({ config: config(path), logger: false, webSocketFactory: false, fetch: successFetch });
    try {
      await vi.waitFor(async () => {
        const alert = await restartedApp.inject({ method: 'GET', url: '/api/v1/alerts/alert_test', headers });
        expect(alert.json<{ delivery: { targets: Array<{ status: string; attempts: number }> } }>().delivery.targets[0])
          .toMatchObject({ status: 'sent', attempts: 2 });
      });
      expect(successFetch).toHaveBeenCalledTimes(1);
      const alert = await restartedApp.inject({ method: 'GET', url: '/api/v1/alerts/alert_test', headers });
      expect(alert.body).not.toContain(secret);
    } finally {
      await restartedApp.close();
    }
    const third = open();
    third.integrations.update(integration.id, { enabled: false });
    const skippedAt = new Date().toISOString();
    third.database.sqlite.prepare(`INSERT INTO alerts
      (id, status, severity, title, message, observed_at, delivery_json, delivery_next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'alert_skipped', 'open', 'warning', 'Another warning', 'Message', skippedAt,
      JSON.stringify({ targets: [{ integrationId: integration.id, status: 'pending', attempts: 0 }] }),
      skippedAt, skippedAt, skippedAt,
    );
    const skippedFetch = vi.fn<typeof globalThis.fetch>();
    await new AlertDeliveryService(third.alerts, third.integrations, skippedFetch).processDue();
    expect(skippedFetch).not.toHaveBeenCalled();
    expect(third.alerts.get('alert_skipped').delivery).toMatchObject({ targets: [{
      status: 'skipped', attempts: 1, errorCode: 'INTEGRATION_UNAVAILABLE',
    }] });
    third.database.close();
  });
});
