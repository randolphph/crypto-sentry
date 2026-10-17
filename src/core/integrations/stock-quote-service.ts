import type Database from 'better-sqlite3';
import { StockQuoteReader, stockKey, stockMarketOpen } from '../../adapters/markets/stock-quotes.js';
import type { SharedStockQuote, StockSymbol, QuoteBasis } from '../../adapters/markets/stock-quotes.js';
import type { PollingScheduler } from '../scheduling/polling-scheduler.js';

export interface StoredStockQuote extends SharedStockQuote {
  receivedAt: string;
  status: 'ok' | 'stale' | 'closed' | 'error';
  error?: string;
}
interface QuoteState {
  symbol: StockSymbol;
  quotes: Map<QuoteBasis, StoredStockQuote>;
  lastAttempt: number;
  failures: number;
  nextAttempt: number;
  pending?: Promise<void> | undefined;
  controller?: AbortController | undefined;
  error?: string | undefined;
  stockError?: string | undefined;
}

export class StockQuoteService {
  private readonly states = new Map<string, QuoteState>();
  private readonly monitors = new Map<string, { symbol: StockSymbol; intervalSeconds: number }>();
  private readonly tasks = new Set<string>();
  private readonly reader: StockQuoteReader;
  private closed = false;
  private activeLoads = 0;
  private readonly waitingLoads: Array<() => void> = [];
  public constructor(private readonly sqlite: Database.Database, private readonly scheduler: PollingScheduler,
    private readonly options: { fetch?: typeof globalThis.fetch; now?: () => Date } = {}) {
    this.reader = new StockQuoteReader(options.fetch, options.now);
  }
  private now(): Date { return this.options.now?.() ?? new Date(); }

  public sync(owner: string, source: string, symbols: StockSymbol[], revision = this.now().getTime()): void {
    this.sqlite.transaction(() => {
      const previous = this.sqlite.prepare('SELECT revision FROM stock_quote_subscription_versions WHERE owner = ? AND source = ?').get(owner, source) as { revision: number } | undefined;
      if (previous && previous.revision > revision) return;
      this.sqlite.prepare('INSERT INTO stock_quote_subscription_versions (owner, source, revision) VALUES (?, ?, ?) ON CONFLICT(owner, source) DO UPDATE SET revision = excluded.revision').run(owner, source, revision);
      this.sqlite.prepare('DELETE FROM stock_quote_subscriptions WHERE owner = ? AND source = ?').run(owner, source);
      const insert = this.sqlite.prepare('INSERT OR IGNORE INTO stock_quote_subscriptions (owner, source, market, symbol) VALUES (?, ?, ?, ?)');
      for (const symbol of symbols) insert.run(owner, source, symbol.market, symbol.symbol);
    })();
    this.reconcile();
  }

  public setMonitors(monitors: Array<{ id: string; symbol: string; intervalSeconds: number }>): void {
    this.monitors.clear();
    for (const monitor of monitors) this.monitors.set(monitor.id, { symbol: { market: 'US', symbol: monitor.symbol }, intervalSeconds: monitor.intervalSeconds });
    this.reconcile();
  }

  public reconcile(): void {
    if (this.closed) return;
    const desired = new Map<string, { symbol: StockSymbol; seconds: number }>();
    const rows = this.sqlite.prepare('SELECT DISTINCT market, symbol FROM stock_quote_subscriptions').all() as StockSymbol[];
    for (const symbol of rows) desired.set(stockKey(symbol), { symbol, seconds: 60 });
    for (const { symbol, intervalSeconds } of this.monitors.values()) {
      const key = stockKey(symbol);
      desired.set(key, { symbol, seconds: Math.min(desired.get(key)?.seconds ?? intervalSeconds, intervalSeconds) });
    }
    for (const [key, { symbol, seconds }] of desired) {
      this.state(symbol);
      const id = `quote:${key}`;
      this.tasks.add(id);
      this.scheduler.upsert({ id, intervalMilliseconds: seconds * 1_000, run: async () => {
        const pause = !stockMarketOpen(symbol.market, this.now()) && symbol.market !== 'US' ? 300 : seconds;
        await this.refresh(symbol, pause);
      } });
    }
    for (const id of this.tasks) {
      if (desired.has(id.slice('quote:'.length))) continue;
      this.scheduler.remove(id);
      this.tasks.delete(id);
      const state = this.states.get(id.slice('quote:'.length));
      state?.controller?.abort();
      this.states.delete(id.slice('quote:'.length));
    }
  }

  public async get(symbol: StockSymbol, mode: 'stock' | 'monitor' = 'stock', maxAgeSeconds = 60, signal?: AbortSignal): Promise<StoredStockQuote | null> {
    if (this.closed || signal?.aborted) return null;
    await this.refresh(symbol, maxAgeSeconds);
    if (signal?.aborted) return null;
    const state = this.state(symbol);
    const quotes = [...state.quotes.values()].filter((quote) => mode === 'monitor' || quote.priceBasis === 'stock');
    const newest = quotes.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
    if (!newest) return null;
    const age = (this.now().getTime() - Date.parse(newest.observedAt)) / 1_000;
    const error = state.error ?? (mode === 'stock' ? state.stockError : undefined);
    const status = error ? 'error' : age <= 180 ? 'ok' : newest.priceBasis === 'stock' && !stockMarketOpen(symbol.market, this.now()) ? 'closed' : 'stale';
    return { ...newest, status, ...(error ? { error } : {}) };
  }

  public error(symbol: StockSymbol): string { return this.states.get(stockKey(symbol))?.error ?? '尚无可用股票行情'; }

  public async close(): Promise<void> {
    this.closed = true;
    for (const id of this.tasks) this.scheduler.remove(id);
    this.tasks.clear();
    for (const state of this.states.values()) state.controller?.abort();
    await Promise.all([...this.states.values()].flatMap((state) => state.pending ? [state.pending] : []));
  }

  private state(symbol: StockSymbol): QuoteState {
    const key = stockKey(symbol);
    let state = this.states.get(key);
    if (!state) {
      const rows = this.sqlite.prepare('SELECT quote_json FROM stock_quotes WHERE market = ? AND symbol = ?').all(symbol.market, symbol.symbol) as Array<{ quote_json: string }>;
      const quotes = rows.map((row) => JSON.parse(row.quote_json) as StoredStockQuote);
      state = { symbol, quotes: new Map(quotes.map((quote) => [quote.priceBasis, quote])), lastAttempt: 0, failures: 0, nextAttempt: 0 };
      this.states.set(key, state);
    }
    return state;
  }

  private async refresh(symbol: StockSymbol, maxAgeSeconds: number): Promise<void> {
    const state = this.state(symbol);
    if (state.pending) return state.pending;
    const now = this.now().getTime();
    if (this.closed || now < state.nextAttempt || (state.lastAttempt > 0 && now - state.lastAttempt < maxAgeSeconds * 1_000)) return;
    state.lastAttempt = now;
    const controller = new AbortController();
    state.controller = controller;
    const pending = this.collect(symbol, controller.signal).then((quotes) => {
      if (this.closed || controller.signal.aborted || this.states.get(stockKey(symbol)) !== state) return;
      const receivedAt = this.now().toISOString();
      const upsert = this.sqlite.prepare('INSERT INTO stock_quotes (market, symbol, basis, quote_json, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(market, symbol, basis) DO UPDATE SET quote_json = excluded.quote_json, received_at = excluded.received_at');
      for (const quote of quotes.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))) {
        const prior = state.quotes.get(quote.priceBasis);
        if (prior && Date.parse(prior.observedAt) > Date.parse(quote.observedAt)) continue;
        const stored: StoredStockQuote = { ...quote, receivedAt, status: 'ok' };
        state.quotes.set(quote.priceBasis, stored);
        upsert.run(symbol.market, symbol.symbol, quote.priceBasis, JSON.stringify(stored), receivedAt);
      }
      state.error = undefined; state.failures = 0; state.nextAttempt = 0;
      state.stockError = quotes.some((quote) => quote.priceBasis === 'stock') ? undefined : '股票报价暂不可用，保留最后成功估值';
    }).catch((error: unknown) => {
      if (this.closed || controller.signal.aborted) return;
      state.error = error instanceof Error ? error.message : '行情更新失败';
      state.failures++;
      state.nextAttempt = this.now().getTime() + Math.min(30_000 * 2 ** Math.min(state.failures - 1, 4), 300_000);
    }).finally(() => { state.pending = undefined; state.controller = undefined; });
    state.pending = pending;
    await pending;
  }

  private async collect(symbol: StockSymbol, signal: AbortSignal): Promise<SharedStockQuote[]> {
    while (this.activeLoads >= 8) {
      await new Promise<void>((resolve) => this.waitingLoads.push(resolve));
      if (this.closed || signal.aborted) {
        this.waitingLoads.shift()?.();
        throw new Error('行情采集已取消');
      }
    }
    if (this.closed || signal.aborted) throw new Error('行情采集已取消');
    this.activeLoads++;
    try { return await this.reader.read(symbol, signal); }
    finally { this.activeLoads--; this.waitingLoads.shift()?.(); }
  }
}
