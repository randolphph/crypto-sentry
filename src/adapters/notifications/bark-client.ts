import { barkConfigSchema } from '../../core/notifications/bark-config.js';
import type { BarkConfig } from '../../core/notifications/bark-config.js';

export type BarkSendResult = { ok: true } | {
  ok: false; code: string; message: string; retryable: boolean; retryAfterSeconds?: number;
};

export type BarkNotificationLevel = 'active' | 'timeSensitive' | 'critical';

export async function sendBarkMessage(
  config: BarkConfig,
  message: { title: string; body: string; level?: BarkNotificationLevel },
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<BarkSendResult> {
  const parsed = barkConfigSchema.safeParse(config);
  if (!parsed.success) return { ok: false, code: 'BARK_INVALID_CONFIG', message: 'Bark configuration is invalid', retryable: false };
  try {
    const response = await fetchImplementation(`${parsed.data.serverUrl.replace(/\/+$/u, '')}/push`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_key: parsed.data.deviceKey, title: message.title.slice(0, 120),
        body: message.body.slice(0, 4_000), group: parsed.data.group,
        level: message.level ?? 'active' }),
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    const body: unknown = await response.json().catch(() => null);
    const code = body !== null && typeof body === 'object' && 'code' in body && typeof body.code === 'number' ? body.code : undefined;
    if (response.ok && code === 200) return { ok: true };
    const status = response.ok ? code ?? 502 : response.status;
    if (status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      return { ok: false, code: 'BARK_RATE_LIMITED', message: 'Bark rate limit reached', retryable: true,
        ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterSeconds: Math.min(3_600, Math.ceil(seconds)) } : {}) };
    }
    if (status >= 400 && status < 500) return { ok: false, code: 'BARK_REJECTED', message: 'Bark rejected the device key or message', retryable: false };
    return { ok: false, code: 'BARK_UNAVAILABLE', message: 'Bark service returned an invalid or unavailable response', retryable: true };
  } catch {
    return { ok: false, code: 'BARK_UNAVAILABLE', message: 'Bark request failed', retryable: true };
  }
}
