import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsStockQuoteReader, sinaTradeTime } from '../src/adapters/markets/us-stock-quotes.js';
import { createApp } from '../src/app.js';
import { monitorCreateSchema } from '../src/api/schemas.js';

const urlOf = (input: string | URL | Request) => input instanceof Request ? input.url : input.toString();
const now = new Date('2026-10-15T09:18:00.000Z');
const request = { symbol: 'NVDA', provider: 'auto' as const, includeExtended: true, maxStaleSeconds: 180 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function sina() {
  const fields = Array<string>(36).fill('0');
  fields[0] = 'NVIDIA'; fields[1] = '221.3'; fields[3] = '2026-10-15 17:18:00';
  fields[21] = '218.1'; fields[24] = 'Oct 15 05:17AM EDT'; fields[25] = 'Oct 14 04:00PM EDT';
  return new Response(`var hq_str_gb_nvda="${fields.join(',')}";`);
}
function yahoo(price = 219, time = now.getTime() / 1_000, symbol = 'NVDA') {
  return json({ chart: { result: [{ meta: { symbol, currency: 'USD', regularMarketPrice: price, regularMarketTime: time } }] } });
}
afterEach(() => { vi.useRealTimers(); });

describe('US stock quote adapters', () => {
  it('uses the actual Sina trade timestamp, including extended trades and DST/year boundaries', async () => {
    const reader = new UsStockQuoteReader(vi.fn(async () => sina()), () => now);
    expect(await reader.read(request)).toMatchObject({ price: '218.1', observedAt: '2026-10-15T09:17:00.000Z', session: 'extended', currency: 'USD' });
    expect(await reader.read({ ...request, provider: 'sina', includeExtended: false })).toMatchObject({ price: '221.3', observedAt: '2026-10-14T20:00:00.000Z', session: 'regular' });
    expect(sinaTradeTime('Dec 31 04:00PM EST', new Date('2027-01-01T02:00:00Z'))).toBe('2026-12-31T21:00:00.000Z');
    expect(() => sinaTradeTime('2026-10-15 17:18:00', now)).toThrow();
  });
  it('prefers fresh Sina or Yahoo quotes before consulting Binance', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => urlOf(input).includes('sinajs') ? new Response('denied', { status: 403 }) : yahoo());
    expect(await new UsStockQuoteReader(fetch, () => now).read(request)).toMatchObject({ provider: 'yahoo', price: '219' });
    expect(fetch.mock.calls.every(([input]) => !urlOf(input).includes('binance'))).toBe(true);
    const stale = vi.fn(async (input: string | URL | Request) => urlOf(input).includes('sinajs') ? sina() : yahoo());
    expect(await new UsStockQuoteReader(stale, () => now).read({ ...request, includeExtended: false })).toMatchObject({ provider: 'yahoo' });
  });
  it('automatically reaches Binance after stale or failed stock sources and keeps metadata and source preference', async () => {
    let freshStocks = false;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes('sinajs')) return freshStocks ? sina() : new Response('denied', { status: 503 });
      if (url.includes('yahoo')) return yahoo(219, now.getTime()/1000 - 3600);
      if (url.includes('exchangeInfo')) return json({ symbols: [{ symbol: 'NVDAUSDT', baseAsset: 'NVDA', quoteAsset: 'USDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', underlyingType: 'EQUITY' }] });
      return json({ symbol: 'NVDAUSDT', markPrice: '218.45', time: now.getTime() });
    });
    const reader = new UsStockQuoteReader(fetch, () => now);
    expect(await reader.read(request)).toMatchObject({ provider: 'binance', price: '218.45', currency: 'USDT', priceBasis: 'perpetual_mark' });
    freshStocks = true; fetch.mockClear();
    expect(await reader.read(request)).toMatchObject({ provider: 'sina', currency: 'USD', priceBasis: 'stock' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps the newest stale stock quote if Binance does not list the ticker, and respects a pinned source', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes('sinajs')) return sina();
      if (url.includes('yahoo')) return yahoo(219, now.getTime()/1000 - 3600);
      return json({ symbols: [] });
    });
    const reader = new UsStockQuoteReader(fetch, () => now);
    expect(await reader.read({ ...request, includeExtended: false })).toMatchObject({ provider: 'yahoo', currency: 'USD', observedAt: '2026-10-15T08:18:00.000Z' });
    fetch.mockClear();
    expect(await reader.read({ ...request, provider: 'sina', includeExtended: false })).toMatchObject({ provider: 'sina' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps stale time visible and rejects wrong symbols, invalid prices, currency and future time', async () => {
    expect(await new UsStockQuoteReader(vi.fn(async () => yahoo(200, now.getTime() / 1_000 - 3600)), () => now).read({ ...request, provider: 'yahoo' })).toMatchObject({ observedAt: '2026-10-15T08:18:00.000Z' });
    for (const [value, time, symbol] of [[0, now.getTime()/1000, 'NVDA'], [200, now.getTime()/1000 + 600, 'NVDA'], [200, now.getTime()/1000, 'TSLA']] as const) {
      await expect(new UsStockQuoteReader(vi.fn(async () => yahoo(value, time, symbol)), () => now).read({ ...request, provider: 'yahoo' })).rejects.toThrow();
    }
  });
  it('selects newer Yahoo extended-session bars only when requested', async () => {
    const fetch = vi.fn(async () => json({ chart: { result: [{ meta: { symbol: 'NVDA', currency: 'USD', regularMarketPrice: 200, regularMarketTime: now.getTime()/1000 - 3600 }, timestamp: [now.getTime()/1000 - 60], indicators: { quote: [{ close: [218] }] } }] } }));
    expect(await new UsStockQuoteReader(fetch, () => now).read({ ...request, provider: 'yahoo' })).toMatchObject({ price: '218', session: 'extended' });
    expect(await new UsStockQuoteReader(fetch, () => now).read({ ...request, provider: 'yahoo', includeExtended: false })).toMatchObject({ price: '200', session: 'regular' });
  });
  it('supports Binance TRADIFI_PERPETUAL equity metadata and rejects crypto or unlisted tickers', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => urlOf(input).includes('exchangeInfo')
      ? json({ symbols: [{ symbol: 'NVDAUSDT', baseAsset: 'NVDA', quoteAsset: 'USDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', underlyingType: 'EQUITY' }, { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', underlyingType: 'COIN' }] })
      : json({ symbol: 'NVDAUSDT', markPrice: '218.44921309', time: now.getTime() }));
    const reader = new UsStockQuoteReader(fetch, () => now);
    expect(await reader.read({ ...request, provider: 'binance' })).toMatchObject({ price: '218.44921309', currency: 'USDT', priceBasis: 'perpetual_mark' });
    await reader.read({ ...request, provider: 'binance' });
    expect(fetch.mock.calls.filter(([input]) => urlOf(input).includes('exchangeInfo'))).toHaveLength(1);
    await expect(reader.read({ ...request, provider: 'binance', symbol: 'BTC' })).rejects.toThrow('美股永续');
    await expect(reader.read({ ...request, provider: 'binance', symbol: 'UNKNOWN' })).rejects.toThrow('美股永续');
  });
});

const token = 'stock-monitor-test-token-at-least-32-characters';
const headers = { authorization: `Bearer ${token}` };
it('validates stock monitor config without needing a crypto or RPC integration', () => {
  expect(monitorCreateSchema.parse({ name: 'NVDA', type: 'stock_price', config: { symbol: ' nvda ' } }).config).toMatchObject({ symbol: ' nvda ' });
  expect(monitorCreateSchema.safeParse({ name: 'Bad', type: 'stock_price', config: { symbol: 'NVDA/USDT' } }).success).toBe(false);
  expect(monitorCreateSchema.safeParse({ name: 'Bad', type: 'stock_price', config: { symbol: 'NVDA', provider: 'unknown' } }).success).toBe(false);
});

it('polls in the backend, triggers and delivers once, observes frequency changes, ignores stale data and stops disabled monitors', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(now);
  let currentPrice = 220; let age = 0; let calls = 0; let unavailable = false; let useBinance = false; const deliveries: unknown[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    if (url.includes('yahoo.com')) { calls++; if (unavailable) return json({}, 503); return yahoo(currentPrice, (Date.now() - age) / 1000); }
    if (url.includes('exchangeInfo')) return json({ symbols: [{ symbol: 'NVDAUSDT', baseAsset: 'NVDA', quoteAsset: 'USDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', underlyingType: 'EQUITY' }] });
    if (url.includes('premiumIndex')) return useBinance ? json({ symbol: 'NVDAUSDT', markPrice: '201', time: Date.now() }) : json({}, 503);
    if (url.includes('api.day.app')) { deliveries.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}')); return json({ code: 200, message: 'success' }); }
    throw new Error(`Unexpected request: ${url}`);
  });
  const app = await createApp({ config: { databasePath: ':memory:', apiToken: token, masterEncryptionKey: Buffer.alloc(32, 8), host: '127.0.0.1', port: 3000, logLevel: 'silent' }, logger: false, webSocketFactory: false, fetch });
  try {
    const notificationResponse = await app.inject({ method: 'POST', url: '/api/v1/integrations', headers, payload: { name: 'iPhone', type: 'notification', provider: 'bark', enabled: true, config: { serverUrl: 'https://api.day.app', deviceKey: 'mock-device-key' } } });
    expect(notificationResponse.statusCode).toBe(201);
    const notification = notificationResponse.json<{id:string}>();
    const createdResponse = await app.inject({ method: 'POST', url: '/api/v1/monitors', headers, payload: { name: 'NVDA', type: 'stock_price', enabled: false, intervalSeconds: 5, maxStaleSeconds: 90, config: { symbol: 'nvda', provider: 'auto', includeExtended: true } } });
    expect(createdResponse.statusCode).toBe(201);
    const monitor = createdResponse.json<{id:string;config:{symbol:string}}>(); expect(monitor.config.symbol).toBe('NVDA');
    const rule = await app.inject({ method: 'POST', url: '/api/v1/rules', headers, payload: { monitorId: monitor.id, name: 'NVDA 低价', enabled: true, combinator: 'and', conditions: [{ metric: 'price', labels: {}, operator: 'lte', threshold: '210', hysteresis: '1' }], durationSeconds: 0, cooldownSeconds: 3600, severity: 'warning', notificationIntegrationIds: [notification.id] } });
    expect(rule.statusCode).toBe(201);
    for (const [metric, threshold] of [['price', '0'], ['price', '-1'], ['price', 'false'], ['funding_rate_percent', '1']]) {
      const invalidRule = await app.inject({ method: 'POST', url: '/api/v1/rules', headers, payload: { monitorId: monitor.id, name: 'Invalid rule', enabled: true, combinator: 'and', conditions: [{ metric, labels: {}, operator: 'eq', threshold, hysteresis: '0' }], durationSeconds: 0, cooldownSeconds: 0, severity: 'warning', notificationIntegrationIds: [] } });
      expect(invalidRule.statusCode).toBe(400);
    }
    const enabled = await app.inject({ method: 'PATCH', url: `/api/v1/monitors/${monitor.id}`, headers, payload: { enabled: true } });
    expect(enabled.json<{intervalSeconds:number}>().intervalSeconds).toBe(5);
    await vi.advanceTimersByTimeAsync(100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1); expect(deliveries).toHaveLength(0);
    currentPrice = 200;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(deliveries).toHaveLength(1));
    const snapshot = (await app.inject({ method: 'GET', url: `/api/v1/monitors/${monitor.id}/snapshot`, headers })).json<{status:string;data:{metrics:Array<{name:string;value:string}>}}>();
    expect(snapshot.status).toBe('ok'); expect(snapshot.data.metrics.find((metric) => metric.name === 'price')?.value).toBe('200');
    await vi.advanceTimersByTimeAsync(10_000); expect(deliveries).toHaveLength(1);
    const before = calls;
    await app.inject({ method: 'PATCH', url: `/api/v1/monitors/${monitor.id}`, headers, payload: { intervalSeconds: 60 } });
    await vi.advanceTimersByTimeAsync(100); expect(calls).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(5_000); expect(calls).toBe(before + 1);
    const staleRule = await app.inject({ method: 'POST', url: '/api/v1/rules', headers, payload: { monitorId: monitor.id, name: '陈旧价格不得触发', enabled: true, combinator: 'and', conditions: [{ metric: 'price', labels: {}, operator: 'lte', threshold: '250', hysteresis: '0' }], durationSeconds: 0, cooldownSeconds: 0, severity: 'warning', notificationIntegrationIds: [notification.id] } });
    expect(staleRule.statusCode).toBe(201);
    age = 3600_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await app.inject({ method: 'GET', url: `/api/v1/monitors/${monitor.id}/snapshot`, headers })).json<{status:string}>().status).toBe('stale');
    expect(deliveries).toHaveLength(1);
    unavailable = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await app.inject({ method: 'GET', url: `/api/v1/monitors/${monitor.id}/snapshot`, headers })).json<{status:string}>().status).toBe('error');
    expect(deliveries).toHaveLength(1);
    await app.inject({ method: 'PATCH', url: `/api/v1/monitors/${monitor.id}`, headers, payload: { enabled: false } });
    const stopped = calls; await vi.advanceTimersByTimeAsync(120_000); expect(calls).toBe(stopped);
    useBinance = true;
    await app.inject({ method: 'PATCH', url: `/api/v1/monitors/${monitor.id}`, headers, payload: { enabled: true } });
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(deliveries).toHaveLength(2));
    const fallback = (await app.inject({ method: 'GET', url: `/api/v1/monitors/${monitor.id}/snapshot`, headers })).json<{summary:Record<string,string>}>();
    expect(fallback.summary).toMatchObject({ source: 'binance', quoteCurrency: 'USDT', priceBasis: '永续合约标记价格' });
    expect(JSON.stringify(deliveries.at(-1))).toContain('来源：币安 · 股票永续标记价格');
    expect(JSON.stringify(deliveries.at(-1))).toContain('201 USDT');
    unavailable = false; age = 0; currentPrice = 300;
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await app.inject({ method: 'GET', url: `/api/v1/monitors/${monitor.id}/snapshot`, headers })).json<{summary:Record<string,string>}>().summary).toMatchObject({ source: 'yahoo', quoteCurrency: 'USD', priceBasis: '股票行情' });
  } finally { await app.close(); }
});
