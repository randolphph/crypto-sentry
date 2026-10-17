import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../src/db/client.js';
import { StockQuoteService } from '../src/core/integrations/stock-quote-service.js';
import { PollingScheduler } from '../src/core/scheduling/polling-scheduler.js';
import { StockQuoteReader, stockSymbolSchema } from '../src/adapters/markets/stock-quotes.js';
import { createApp } from '../src/app.js';

const now = new Date('2026-10-16T02:00:30.000Z');
const a = { market: 'A' as const, symbol: 'SH600519' };
const us = { market: 'US' as const, symbol: 'NVDA' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const urlOf = (value: string | URL | Request) => value instanceof Request ? value.url : value.toString();
function sinaA(value = '100', time = '10:00:00') {
  const fields = Array<string>(33).fill('0');
  fields[0] = '测试股票'; fields[2] = '90'; fields[3] = value; fields[30] = '2026-10-16'; fields[31] = time;
  return new Response(`var hq_str_sh600519="${fields.join(',')}";`);
}
function tencent(value = '101', time = '20261016100030', code = 'sh600519') {
  const fields = Array<string>(50).fill('0');
  fields[1] = '测试股票'; fields[2] = code.startsWith('hk') ? code.slice(2) : code.slice(2); fields[3] = value; fields[4] = '90'; fields[30] = time;
  return new Response(`v_${code}="${fields.join('~')}";`);
}
function mockFetch() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = urlOf(input);
    if (url.includes('list=sh600519')) return sinaA();
    if (url.includes('gtimg')) return tencent();
    if (url.includes('sinajs')) {
      const fields = Array<string>(36).fill('0'); fields[1] = '90'; fields[21] = '91'; fields[24] = 'Oct 15 07:59PM EDT'; fields[25] = 'Oct 15 04:00PM EDT';
      return new Response(`var hq_str_gb_nvda="${fields.join(',')}";`);
    }
    if (url.includes('yahoo')) return json({ chart: { result: [{ meta: { symbol: 'NVDA', currency: 'USD', regularMarketPrice: 100, regularMarketTime: now.getTime() / 1_000 - 30 } }] } });
    if (url.includes('exchangeInfo')) return json({ symbols: [{ symbol: 'NVDAUSDT', baseAsset: 'NVDA', quoteAsset: 'USDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', underlyingType: 'EQUITY' }] });
    return json({ symbol: 'NVDAUSDT', markPrice: '500', time: now.getTime() });
  });
}
afterEach(() => vi.useRealTimers());

describe('shared stock quotes', () => {
  it('normalizes exchange identities and rejects contract-like or malformed symbols', () => {
    expect(stockSymbolSchema.parse({ market: 'A', symbol: '600519' })).toEqual(a);
    expect(stockSymbolSchema.parse({ market: 'A', symbol: '920001' }).symbol).toBe('BJ920001');
    expect(stockSymbolSchema.parse({ market: 'HK', symbol: '700' }).symbol).toBe('00700');
    expect(stockSymbolSchema.safeParse({ market: 'US', symbol: 'NVDA 260116C150' }).success).toBe(false);
  });

  it('queries every applicable source and selects the newest valid A-share quote by trade clock', async () => {
    const fetch = mockFetch();
    const quotes = await new StockQuoteReader(fetch, () => now).read(a);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(quotes.sort((x, y) => Date.parse(y.observedAt) - Date.parse(x.observedAt))[0]).toMatchObject({ provider: 'tencent', price: '101', currency: 'CNY', observedAt: now.toISOString() });
    const bad = vi.fn(async (input: string | URL | Request) => urlOf(input).includes('sinajs') ? sinaA() : tencent('999', '20261016100500'));
    expect(await new StockQuoteReader(bad, () => now).read(a)).toEqual([expect.objectContaining({ provider: 'sina', price: '100' })]);
  });

  it('preserves HKD and KRW identity, clocks and source fallback instead of treating foreign shares as USD', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes('gtimg')) return tencent('410', '2026/10/16 10:00:30', 'hk00700');
      if (url.includes('naver')) return json({ itemCode: '005930', closePrice: '80,100', localTradedAt: '2026-10-16T11:00:30+09:00' });
      return json({}, 503);
    });
    const reader = new StockQuoteReader(fetch, () => now);
    expect(await reader.read({ market: 'HK', symbol: '00700' })).toEqual([expect.objectContaining({ price: '410', currency: 'HKD', observedAt: now.toISOString() })]);
    expect(await reader.read({ market: 'KR', symbol: '005930' })).toEqual([expect.objectContaining({ price: '80100', currency: 'KRW', observedAt: now.toISOString() })]);
  });

  it('shares concurrent requests while keeping equity valuation separate from a newer perpetual quote', async () => {
    const db = createDatabase(':memory:');
    const scheduler = new PollingScheduler({ onError: () => undefined });
    const fetch = mockFetch();
    const service = new StockQuoteService(db.sqlite, scheduler, { fetch, now: () => now });
    try {
      const [stock, monitor] = await Promise.all([service.get(us), service.get(us, 'monitor')]);
      expect(stock).toMatchObject({ price: '100', currency: 'USD', provider: 'yahoo', priceBasis: 'stock' });
      expect(monitor).toMatchObject({ price: '500', currency: 'USDT', provider: 'binance', priceBasis: 'perpetual_mark' });
      expect(fetch).toHaveBeenCalledTimes(4);
      await service.get(us); expect(fetch).toHaveBeenCalledTimes(4);
    } finally { await service.close(); await scheduler.close(); db.close(); }
  });

  it('retains last successful prices and timestamps after failures, backs off and recovers', async () => {
    const db = createDatabase(':memory:');
    const scheduler = new PollingScheduler({ onError: () => undefined });
    let at = now; let fail = false;
    const fetch = vi.fn(async (input: string | URL | Request) => fail ? json({}, 503) : mockFetch()(input));
    const service = new StockQuoteService(db.sqlite, scheduler, { fetch, now: () => at });
    try {
      expect(await service.get(a)).toMatchObject({ price: '101', status: 'ok' });
      fail = true; at = new Date(now.getTime() + 60_000);
      const failed = await service.get(a);
      expect(failed).toMatchObject({ price: '101', observedAt: now.toISOString(), status: 'error' });
      const calls = fetch.mock.calls.length; await service.get(a, 'stock', 0); expect(fetch).toHaveBeenCalledTimes(calls);
      fail = false; at = new Date(now.getTime() + 120_000);
      expect(await service.get(a)).toMatchObject({ price: '101', observedAt: now.toISOString(), status: 'ok' });
    } finally { await service.close(); await scheduler.close(); db.close(); }
  });

  it('persists owner-scoped subscriptions and quotes across restart, polls with the page closed and respects other consumers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(now);
    const folder = mkdtempSync(join(tmpdir(), 'stock-quote-test-'));
    const path = join(folder, 'quotes.sqlite');
    let db = createDatabase(path);
    let scheduler = new PollingScheduler({ onError: () => undefined });
    const fetch = mockFetch();
    let service = new StockQuoteService(db.sqlite, scheduler, { fetch });
    try {
      service.sync('owner-a', 'manual', [a]); service.sync('owner-b', 'ibkr', [a]);
      service.setMonitors([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(2);
      service.sync('owner-a', 'manual', []);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetch).toHaveBeenCalledTimes(4);
      await service.close(); await scheduler.close(); db.close();
      db = createDatabase(path); scheduler = new PollingScheduler({ onError: () => undefined });
      service = new StockQuoteService(db.sqlite, scheduler, { fetch }); service.reconcile();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(6);
      expect(await service.get(a)).toMatchObject({ price: '101', observedAt: now.toISOString() });
      service.sync('owner-b', 'ibkr', []);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(fetch).toHaveBeenCalledTimes(6);
    } finally { await service.close(); await scheduler.close(); db.close(); rmSync(folder, { recursive: true, force: true }); }
  });

  it('protects API subscriptions, keeps collection out of alert tasks and migrates pinned monitors to automatic sources', async () => {
    const token = 'shared-stock-quotes-api-token-long-enough';
    const headers = { authorization: `Bearer ${token}` };
    const app = await createApp({ config: { databasePath: ':memory:', apiToken: token, masterEncryptionKey: Buffer.alloc(32, 8), host: '127.0.0.1', port: 3000, logLevel: 'silent' }, fetch: mockFetch(), logger: false, webSocketFactory: false });
    try {
      expect((await app.inject({ method: 'POST', url: '/api/v1/stock-quotes/subscriptions', payload: {} })).statusCode).toBe(401);
      const subscribed = await app.inject({ method: 'POST', url: '/api/v1/stock-quotes/subscriptions', headers, payload: { owner: 'a'.repeat(64), source: 'manual', symbols: [{ market: 'A', symbol: '600519' }] } });
      expect(subscribed.statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/v1/monitors', headers })).json()).toMatchObject({ items: [] });
      const created = await app.inject({ method: 'POST', url: '/api/v1/monitors', headers, payload: { name: 'NVDA', type: 'stock_price', enabled: false, config: { symbol: 'NVDA', provider: 'sina', includeExtended: false } } });
      expect(created.statusCode).toBe(201);
      expect(created.json<{ config: object }>().config).toMatchObject({ provider: 'auto', includeExtended: true });
    } finally { await app.close(); }
  });

  it('bounds concurrent instrument collection even when a large portfolio starts at once', async () => {
    const db = createDatabase(':memory:'); const scheduler = new PollingScheduler({ onError: () => undefined });
    let active = 0; let peak = 0; const releases: Array<() => void> = [];
    const mock = vi.spyOn(StockQuoteReader.prototype, 'read').mockImplementation(async (symbol) => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve)); active--;
      return [{ ...symbol, provider: 'yahoo', currency: 'USD', price: '100', observedAt: now.toISOString(), session: 'regular', priceBasis: 'stock' }];
    });
    const service = new StockQuoteService(db.sqlite, scheduler, { now: () => now });
    try {
      const pending = Promise.all(Array.from({ length: 12 }, (_, index) => service.get({ market: 'US', symbol: `TEST${index}` })));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(active).toBe(8);
      for (const release of releases.splice(0)) release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const release of releases.splice(0)) release();
      expect((await pending).every((quote) => quote?.price === '100')).toBe(true);
      expect(peak).toBe(8);
    } finally { mock.mockRestore(); await service.close(); await scheduler.close(); db.close(); }
  });

  it('does not save a late result after the last subscription is removed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(now);
    const db = createDatabase(':memory:'); const scheduler = new PollingScheduler({ onError: () => undefined });
    let finish: ((quotes: Awaited<ReturnType<StockQuoteReader['read']>>) => void) | undefined;
    const mock = vi.spyOn(StockQuoteReader.prototype, 'read').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const service = new StockQuoteService(db.sqlite, scheduler);
    try {
      service.sync('owner-a', 'manual', [a]); await vi.advanceTimersByTimeAsync(0);
      service.sync('owner-a', 'manual', []);
      finish?.([{ ...a, price: '100', provider: 'sina', currency: 'CNY', observedAt: now.toISOString(), priceBasis: 'stock', session: 'regular' }]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stock_quotes').get()).toEqual({ count: 0 });
    } finally { mock.mockRestore(); await service.close(); await scheduler.close(); db.close(); }
  });

  it('labels old quotes closed outside exchange hours and stale during trading without changing the quote clock', async () => {
    const db = createDatabase(':memory:'); const scheduler = new PollingScheduler({ onError: () => undefined });
    let at = new Date('2026-10-16T12:00:00Z');
    const service = new StockQuoteService(db.sqlite, scheduler, { fetch: mockFetch(), now: () => at });
    try {
      expect(await service.get(a)).toMatchObject({ status: 'closed', observedAt: now.toISOString() });
      at = new Date('2026-10-19T06:00:00Z');
      expect(await service.get(a)).toMatchObject({ status: 'stale', observedAt: now.toISOString() });
    } finally { await service.close(); await scheduler.close(); db.close(); }
  });

  it('ignores an older synchronization request arriving after a newer deletion', async () => {
    const db = createDatabase(':memory:'); const scheduler = new PollingScheduler({ onError: () => undefined });
    const service = new StockQuoteService(db.sqlite, scheduler, { fetch: mockFetch(), now: () => now });
    try {
      service.sync('owner', 'manual', [a], 100);
      service.sync('owner', 'manual', [], 102);
      service.sync('owner', 'manual', [a], 101);
      expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stock_quote_subscriptions').get()).toEqual({ count: 0 });
      service.sync('owner', 'ibkr', [us], 99);
      expect(db.sqlite.prepare('SELECT source FROM stock_quote_subscriptions').all()).toEqual([{ source: 'ibkr' }]);
    } finally { await service.close(); await scheduler.close(); db.close(); }
  });
});
