import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const apiToken = 'telegram-discovery-api-token-long-enough';
const botToken = '123456:telegram-discovery-secret';
const authorization = { authorization: `Bearer ${apiToken}` };
const config: AppConfig = {
  databasePath: ':memory:', apiToken, masterEncryptionKey: Buffer.alloc(32, 4),
  host: '127.0.0.1', port: 3000, logLevel: 'silent',
};

function telegramResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function successfulFetch(updates: unknown[] = [], webhookUrl = ''): typeof globalThis.fetch {
  return vi.fn<typeof globalThis.fetch>(async (input) => {
    const inputUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(inputUrl).pathname;
    if (path.endsWith('/getMe')) return telegramResponse(200, {
      ok: true, result: { id: 123_456_789, is_bot: true, first_name: 'Crypto', last_name: 'Sentry', username: 'crypto_sentry_bot' },
    });
    if (path.endsWith('/getWebhookInfo')) return telegramResponse(200, {
      ok: true, result: { url: webhookUrl, pending_update_count: 0 },
    });
    if (path.endsWith('/getUpdates')) return telegramResponse(200, { ok: true, result: updates });
    throw new Error('Unexpected Telegram method');
  });
}

describe('Telegram chat discovery API', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function discover(fetch: typeof globalThis.fetch) {
    app = await createApp({ config, logger: false, webSocketFactory: false, fetch });
    return app.inject({
      method: 'POST', url: '/api/v1/integrations/telegram/discover', headers: authorization,
      payload: { botToken },
    });
  }

  it('discovers private and negative-ID group chats, deduplicates them, and sorts by recent activity', async () => {
    const response = await discover(successfulFetch([
      { update_id: 1, message: { date: 1_758_600_000, text: 'private message must stay private', chat: {
        id: 12_345_678, type: 'private', first_name: 'Randolph', username: 'randolph',
      } } },
      { update_id: 2, my_chat_member: { date: 1_758_600_060, chat: {
        id: -1_001_234_567_890, type: 'supergroup', title: 'Risk Alerts',
      } } },
      { update_id: 3, edited_message: { date: 1_758_599_000, edit_date: 1_758_600_120,
        text: 'edited message must stay private', chat: {
          id: 12_345_678, type: 'private', first_name: 'Randolph Updated', username: 'randolph',
        } } },
      { update_id: 4, channel_post: { date: 1_758_599_000, text: 'channel body', chat: {
        id: -100_999, type: 'channel', title: 'Old Channel', username: 'old_channel',
      } } },
      { update_id: 5, chat_join_request: { date: 1_758_600_030, bio: 'private bio', chat: {
        id: -444, type: 'group', title: 'Join Requests',
      } } },
    ]));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      bot: { id: '123456789', username: 'crypto_sentry_bot', displayName: 'Crypto Sentry' },
      chats: [
        { id: '12345678', type: 'private', title: 'Randolph Updated', username: 'randolph', lastSeenAt: '2025-09-23T04:02:00.000Z' },
        { id: '-1001234567890', type: 'supergroup', title: 'Risk Alerts', username: null, lastSeenAt: '2025-09-23T04:01:00.000Z' },
        { id: '-444', type: 'group', title: 'Join Requests', username: null, lastSeenAt: '2025-09-23T04:00:30.000Z' },
        { id: '-100999', type: 'channel', title: 'Old Channel', username: 'old_channel', lastSeenAt: '2025-09-23T03:43:20.000Z' },
      ],
    });
    expect(response.body).not.toContain(botToken);
    expect(response.body).not.toContain('private message');
    expect(response.body).not.toContain('edited message');
    expect(response.body).not.toContain('private bio');
  });

  it('returns the verified bot and an empty chat list when no updates exist', async () => {
    const response = await discover(successfulFetch());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      bot: { id: '123456789', username: 'crypto_sentry_bot', displayName: 'Crypto Sentry' }, chats: [],
    });
  });

  it('returns at most the 20 most recently active chats', async () => {
    const updates = Array.from({ length: 25 }, (_, index) => ({
      update_id: index + 1,
      message: { date: 1_758_600_000 + index, chat: {
        id: index + 1, type: 'private', first_name: `User ${index + 1}`,
      } },
    }));
    const response = await discover(successfulFetch(updates));
    const chats = response.json<{ chats: Array<{ id: string }> }>().chats;
    expect(chats).toHaveLength(20);
    expect(chats[0]?.id).toBe('25');
    expect(chats.at(-1)?.id).toBe('6');
  });

  it('rejects an invalid token without exposing Telegram details or the token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(telegramResponse(401, {
      ok: false, error_code: 401, description: `Unauthorized ${botToken}`,
    }));
    const response = await discover(fetch);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: {
      code: 'TELEGRAM_UNAUTHORIZED', message: 'Telegram bot token was rejected',
    } });
    expect(response.body).not.toContain(botToken);
    expect(response.body).not.toContain('Unauthorized');
  });

  it('returns a stable conflict and does not call getUpdates when a webhook is active', async () => {
    const fetch = successfulFetch([], 'https://other-service.example/telegram-secret-hook') as ReturnType<typeof vi.fn>;
    const response = await discover(fetch);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: {
      code: 'TELEGRAM_WEBHOOK_ACTIVE',
      message: 'This bot has an active webhook; use a dedicated bot or enter the Chat ID manually',
    } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(response.body).not.toContain('other-service');
    expect(response.body).not.toContain(botToken);
  });

  it.each([
    [429, { ok: false, error_code: 429, description: `limited ${botToken}`, parameters: { retry_after: 17 } },
      429, 'TELEGRAM_RATE_LIMITED'],
    [503, { ok: false, description: `unavailable ${botToken}` }, 502, 'TELEGRAM_UNAVAILABLE'],
  ])('maps Telegram HTTP %s to a sanitized discovery error', async (telegramStatus, body, status, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(telegramResponse(telegramStatus, body));
    const response = await discover(fetch);
    expect(response.statusCode).toBe(status);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(code);
    expect(response.body).not.toContain(botToken);
    expect(response.body).not.toContain('description');
  });

  it('limits discovery to five calls per minute', async () => {
    const fetch = successfulFetch();
    app = await createApp({ config, logger: false, webSocketFactory: false, fetch });
    for (let index = 0; index < 5; index += 1) {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/integrations/telegram/discover', headers: authorization, payload: { botToken },
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: 'POST', url: '/api/v1/integrations/telegram/discover', headers: authorization, payload: { botToken },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ error: { code: string } }>().error.code).toBe('TELEGRAM_DISCOVERY_RATE_LIMITED');
    expect(fetch).toHaveBeenCalledTimes(15);
  });
});
