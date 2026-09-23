export interface TelegramSendFailure {
  ok: false;
  code: 'TELEGRAM_UNAUTHORIZED' | 'TELEGRAM_FORBIDDEN' | 'TELEGRAM_BAD_REQUEST' |
    'TELEGRAM_RATE_LIMITED' | 'TELEGRAM_UNAVAILABLE';
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
}

export type TelegramSendResult = { ok: true } | TelegramSendFailure;

export interface TelegramDiscoveredChat {
  id: string;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title: string;
  username: string | null;
  lastSeenAt: string;
}

export interface TelegramDiscoveryResult {
  bot: { id: string; username: string | null; displayName: string };
  chats: TelegramDiscoveredChat[];
}

export class TelegramApiError extends Error {
  public constructor(
    public readonly code: TelegramSendFailure['code'],
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

const TIMEOUT_MILLISECONDS = 10_000;

function apiRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function telegramFailure(statusCode: number, body: unknown): TelegramSendFailure {
  const api = apiRecord(body);
  const status = statusCode === 200 && typeof api.error_code === 'number' ? api.error_code : statusCode;
  if (status === 401 || status === 404) return { ok: false, code: 'TELEGRAM_UNAUTHORIZED', message: 'Telegram bot token was rejected', retryable: false };
  if (status === 403) return { ok: false, code: 'TELEGRAM_FORBIDDEN', message: 'Telegram bot is not allowed to perform this action', retryable: false };
  if (status === 400) return { ok: false, code: 'TELEGRAM_BAD_REQUEST', message: 'Telegram rejected the request', retryable: false };
  if (status === 429) {
    const parameters = apiRecord(api.parameters);
    const retryAfterSeconds = typeof parameters.retry_after === 'number' && Number.isFinite(parameters.retry_after)
      ? Math.max(1, Math.min(3_600, Math.ceil(parameters.retry_after))) : undefined;
    return {
      ok: false, code: 'TELEGRAM_RATE_LIMITED', message: 'Telegram rate limit reached', retryable: true,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  }
  return { ok: false, code: 'TELEGRAM_UNAVAILABLE', message: 'Telegram service is unavailable', retryable: true };
}

async function callTelegram(
  botToken: string,
  method: string,
  payload: Record<string, unknown>,
  fetchImplementation: typeof globalThis.fetch,
): Promise<unknown> {
  try {
    const response = await fetchImplementation(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MILLISECONDS),
      redirect: 'error',
    });
    const body: unknown = await response.json().catch(() => null);
    const api = apiRecord(body);
    if (response.ok && api.ok === true && 'result' in api) return api.result;
    const failure = telegramFailure(response.status, body);
    throw new TelegramApiError(failure.code, failure.message, failure.retryAfterSeconds);
  } catch (error) {
    if (error instanceof TelegramApiError) throw error;
    throw new TelegramApiError('TELEGRAM_UNAVAILABLE', 'Telegram request failed');
  }
}

function requiredIdentifier(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TelegramApiError('TELEGRAM_UNAVAILABLE', 'Telegram returned an invalid response');
  }
  return String(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function displayName(value: Record<string, unknown>): string {
  return [optionalString(value.first_name), optionalString(value.last_name)].filter(Boolean).join(' ');
}

function discoveredChat(chatValue: unknown, timestampValue: unknown): TelegramDiscoveredChat | undefined {
  const chat = apiRecord(chatValue);
  const type = chat.type;
  if (!['private', 'group', 'supergroup', 'channel'].includes(String(type))) return undefined;
  if (typeof timestampValue !== 'number' || !Number.isFinite(timestampValue)) return undefined;
  let id: string;
  try {
    id = requiredIdentifier(chat.id);
  } catch {
    return undefined;
  }
  const username = optionalString(chat.username) ?? null;
  const title = optionalString(chat.title) ?? (displayName(chat) || (username === null ? id : `@${username}`));
  const lastSeenAt = new Date(timestampValue * 1_000);
  if (!Number.isFinite(lastSeenAt.getTime())) return undefined;
  return {
    id,
    type: type as TelegramDiscoveredChat['type'],
    title,
    username,
    lastSeenAt: lastSeenAt.toISOString(),
  };
}

function chatFromUpdate(value: unknown): TelegramDiscoveredChat | undefined {
  const update = apiRecord(value);
  for (const name of ['message', 'edited_message', 'channel_post'] as const) {
    const item = apiRecord(update[name]);
    if (Object.keys(item).length === 0) continue;
    return discoveredChat(item.chat, name === 'edited_message' ? item.edit_date ?? item.date : item.date);
  }
  for (const name of ['my_chat_member', 'chat_join_request'] as const) {
    const item = apiRecord(update[name]);
    if (Object.keys(item).length === 0) continue;
    return discoveredChat(item.chat, item.date);
  }
  return undefined;
}

export async function discoverTelegramChats(
  botToken: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<TelegramDiscoveryResult & { webhookActive: boolean }> {
  const botValue = apiRecord(await callTelegram(botToken, 'getMe', {}, fetchImplementation));
  const id = requiredIdentifier(botValue.id);
  const bot = {
    id,
    username: optionalString(botValue.username) ?? null,
    displayName: displayName(botValue) || optionalString(botValue.username) || id,
  };
  const webhook = apiRecord(await callTelegram(botToken, 'getWebhookInfo', {}, fetchImplementation));
  if ((optionalString(webhook.url) ?? '').length > 0) return { bot, chats: [], webhookActive: true };
  const result = await callTelegram(botToken, 'getUpdates', { limit: 100, timeout: 0 }, fetchImplementation);
  if (!Array.isArray(result)) throw new TelegramApiError('TELEGRAM_UNAVAILABLE', 'Telegram returned an invalid response');
  const chats = new Map<string, TelegramDiscoveredChat>();
  for (const update of result) {
    const chat = chatFromUpdate(update);
    if (chat === undefined) continue;
    const current = chats.get(chat.id);
    if (current === undefined || chat.lastSeenAt > current.lastSeenAt) chats.set(chat.id, chat);
  }
  return {
    bot,
    chats: [...chats.values()].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt)).slice(0, 20),
    webhookActive: false,
  };
}

export async function sendTelegramMessage(
  config: { botToken: string; chatId: string },
  text: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<TelegramSendResult> {
  try {
    await callTelegram(config.botToken, 'sendMessage', {
      chat_id: config.chatId, text: text.slice(0, 4_096),
    }, fetchImplementation);
    return { ok: true };
  } catch (error) {
    if (error instanceof TelegramApiError) {
      return {
        ok: false, code: error.code,
        message: error.code === 'TELEGRAM_BAD_REQUEST' ? 'Telegram rejected the chat or message' : error.message,
        retryable: ['TELEGRAM_RATE_LIMITED', 'TELEGRAM_UNAVAILABLE'].includes(error.code),
        ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
      };
    }
    return { ok: false, code: 'TELEGRAM_UNAVAILABLE', message: 'Telegram request failed', retryable: true };
  }
}
