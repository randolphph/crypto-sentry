import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { UsStockQuoteReader } from './us-stock-quotes.js';

export const stockSymbolSchema = z.object({
  market: z.enum(['A', 'HK', 'US', 'KR']),
  symbol: z.string().trim().toUpperCase().min(1).max(32),
}).strict().transform((row, ctx) => {
  let symbol = row.symbol;
  if (row.market === 'A') {
    const code = symbol.replace(/^(SH|SZ|BJ)/u, '');
    if (!/^\d{6}$/u.test(code)) { ctx.addIssue({ code: 'custom', message: 'Invalid A-share symbol' }); return z.NEVER; }
    const exchange = /^(43|83|87|88|92)/u.test(code) ? 'BJ' : /^[569]/u.test(code) ? 'SH' : /^[68]/u.test(code) ? 'SH' : 'SZ';
    symbol = `${/^(SH|SZ|BJ)/u.exec(symbol)?.[0] ?? exchange}${code}`;
  } else if (row.market === 'HK') {
    symbol = symbol.replace(/^HK/u, '').padStart(5, '0');
    if (!/^\d{5}$/u.test(symbol)) { ctx.addIssue({ code: 'custom', message: 'Invalid HK symbol' }); return z.NEVER; }
  } else if (row.market === 'KR') {
    if (!/^\d{6}$/u.test(symbol)) { ctx.addIssue({ code: 'custom', message: 'Invalid Korean symbol' }); return z.NEVER; }
  } else if (!/^[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*$/u.test(symbol)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid US symbol' }); return z.NEVER;
  }
  return { ...row, symbol };
});
export type StockSymbol = z.output<typeof stockSymbolSchema>;
export type QuoteBasis = 'stock' | 'perpetual_mark';
export interface SharedStockQuote extends StockSymbol {
  price: string;
  currency: 'CNY' | 'HKD' | 'USD' | 'KRW' | 'USDT';
  provider: string;
  observedAt: string;
  session: 'regular' | 'extended' | 'continuous';
  priceBasis: QuoteBasis;
  name?: string;
  changePct?: number;
}
export const stockKey = (symbol: StockSymbol) => `${symbol.market}:${symbol.symbol}`;

// Upstream quote clocks are local exchange times, never the HTTP retrieval clock.
export function exchangeTime(value: string, offsetHours: number): string {
  const parts = /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})[ T]?(\d{2}):?(\d{2}):?(\d{2})$/u.exec(value.trim());
  if (!parts) throw new Error('行情未提供有效成交时间');
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  if (!year || !month || !day || month > 12 || day > 31 || hour === undefined || hour > 23 || minute === undefined || minute > 59 || second === undefined || second > 59) throw new Error('行情成交时间无效');
  return new Date(Date.UTC(year, month - 1, day, hour - offsetHours, minute, second)).toISOString();
}

const chartSchema = z.object({ chart: z.object({ result: z.array(z.object({ meta: z.object({
  symbol: z.string(), currency: z.string(), regularMarketPrice: z.number(), regularMarketTime: z.number(),
  chartPreviousClose: z.number().optional(), shortName: z.string().optional(),
}) })).nullable() }) });
const naverSchema = z.object({ itemCode: z.string().optional(), stockName: z.string().optional(), closePrice: z.string(), fluctuationsRatio: z.string().optional(), localTradedAt: z.string() });

export class StockQuoteReader {
  private readonly us: UsStockQuoteReader;
  private readonly retries = new Map<string, { failures: number; after: number }>();
  public constructor(private readonly fetch: typeof globalThis.fetch = globalThis.fetch, private readonly now = () => new Date()) {
    this.us = new UsStockQuoteReader(fetch, now);
  }

  public async read(symbol: StockSymbol, signal?: AbortSignal): Promise<SharedStockQuote[]> {
    if (symbol.market === 'US') return (await this.us.readAll({ symbol: symbol.symbol, provider: 'auto', includeExtended: true, maxStaleSeconds: 180 }, signal)).map((quote) => ({ ...quote, market: 'US' }));
    const sources = symbol.market === 'A' ? ['sina', 'tencent'] : symbol.market === 'HK' ? ['tencent', 'yahoo'] : ['naver', 'yahoo'];
    const results = await Promise.allSettled(sources.map(async (source) => {
      const retryKey = `${source}:${stockKey(symbol)}`;
      const retry = this.retries.get(retryKey);
      if (retry && retry.after > this.now().getTime()) throw new Error(`${source} 暂时退避`);
      try {
        const quote = source === 'sina' ? await this.sina(symbol, signal) : source === 'tencent' ? await this.tencent(symbol, signal) : source === 'naver' ? await this.naver(symbol, signal) : await this.yahoo(symbol, signal);
        const value = new Decimal(quote.price);
        if (!value.isFinite() || value.lte(0) || !Number.isFinite(Date.parse(quote.observedAt)) || Date.parse(quote.observedAt) > this.now().getTime() + 60_000) throw new Error('行情价格或时间无效');
        this.retries.delete(retryKey);
        return quote;
      } catch (error) {
        if (!signal?.aborted) {
          const failures = (retry?.failures ?? 0) + 1;
          this.retries.set(retryKey, { failures, after: this.now().getTime() + Math.min(30_000 * 2 ** Math.min(failures - 1, 4), 300_000) });
        }
        throw error;
      }
    }));
    if (signal?.aborted) throw signal.reason;
    const quotes = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    if (!quotes.length) throw new Error(results.flatMap((result, i) => result.status === 'rejected' ? [`${sources[i]}: ${result.reason instanceof Error ? result.reason.message : '行情失败'}`] : []).join('; '));
    return quotes;
  }

  private async get(url: string, signal?: AbortSignal): Promise<Response> {
    const response = await this.fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn/' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`行情源 HTTP ${response.status}`);
    return response;
  }

  private quote(symbol: StockSymbol, provider: string, price: string, observedAt: string, name?: string, previous?: string): SharedStockQuote {
    const currency = symbol.market === 'A' ? 'CNY' : symbol.market === 'HK' ? 'HKD' : 'KRW';
    const changePct = previous && Number(previous) > 0 ? new Decimal(price).div(previous).minus(1).times(100).toNumber() : undefined;
    return { ...symbol, provider, price, currency, observedAt, session: 'regular', priceBasis: 'stock', ...(name ? { name } : {}), ...(changePct === undefined ? {} : { changePct }) };
  }

  private async sina(symbol: StockSymbol, signal?: AbortSignal): Promise<SharedStockQuote> {
    const code = symbol.symbol.toLowerCase();
    const response = await this.get(`https://hq.sinajs.cn/list=${code}`, signal);
    const text = new TextDecoder('gb18030').decode(await response.arrayBuffer());
    const fields = new RegExp(`hq_str_${code}="([^"]*)"`, 'u').exec(text)?.[1]?.split(',');
    if (!fields || fields.length < 32) throw new Error('新浪未找到股票');
    return this.quote(symbol, 'sina', fields[3] ?? '', exchangeTime(`${fields[30]} ${fields[31]}`, 8), fields[0], fields[2]);
  }

  private async tencent(symbol: StockSymbol, signal?: AbortSignal): Promise<SharedStockQuote> {
    const code = symbol.market === 'A' ? symbol.symbol.toLowerCase() : `hk${symbol.symbol}`;
    const response = await this.get(`https://qt.gtimg.cn/q=${code}`, signal);
    const text = new TextDecoder('gb18030').decode(await response.arrayBuffer());
    const fields = new RegExp(`v_${code}="([^"]*)"`, 'u').exec(text)?.[1]?.split('~');
    if (!fields || fields.length < 31 || fields[2]?.replace(/^0+/u, '') !== symbol.symbol.replace(/^(SH|SZ|BJ)/u, '').replace(/^0+/u, '')) throw new Error('腾讯行情标的不匹配');
    return this.quote(symbol, 'tencent', fields[3] ?? '', exchangeTime(fields[30] ?? '', 8), fields[1], fields[4]);
  }

  private async yahoo(symbol: StockSymbol, signal?: AbortSignal): Promise<SharedStockQuote> {
    const candidates = symbol.market === 'HK' ? [`${Number(symbol.symbol).toString().padStart(4, '0')}.HK`] : [`${symbol.symbol}.KS`, `${symbol.symbol}.KQ`];
    const results = await Promise.allSettled(candidates.map(async (ticker) => {
      const response = await this.get(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`, signal);
      const meta = chartSchema.parse(await response.json()).chart.result?.[0]?.meta;
      const currency = symbol.market === 'HK' ? 'HKD' : 'KRW';
      if (!meta || meta.symbol.toUpperCase() !== ticker || meta.currency !== currency) throw new Error('Yahoo 行情标的或币种不匹配');
      return this.quote(symbol, 'yahoo', String(meta.regularMarketPrice), new Date(meta.regularMarketTime * 1_000).toISOString(), meta.shortName, meta.chartPreviousClose?.toString());
    }));
    const quote = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
    if (!quote) throw new Error('Yahoo 未找到该股票');
    return quote;
  }

  private async naver(symbol: StockSymbol, signal?: AbortSignal): Promise<SharedStockQuote> {
    const response = await this.get(`https://m.stock.naver.com/api/stock/${symbol.symbol}/basic`, signal);
    const data = naverSchema.parse(await response.json());
    if (data.itemCode && data.itemCode !== symbol.symbol) throw new Error('Naver 行情标的不匹配');
    const quote = this.quote(symbol, 'naver', data.closePrice.replaceAll(',', ''), /[Z+-]\d{2}:?\d{2}$/u.test(data.localTradedAt) ? new Date(data.localTradedAt).toISOString() : exchangeTime(data.localTradedAt, 9), data.stockName);
    const changePct = Number(data.fluctuationsRatio);
    return { ...quote, ...(Number.isFinite(changePct) ? { changePct } : {}) };
  }
}

export function stockMarketOpen(market: StockSymbol['market'], at: Date): boolean {
  const timezone = market === 'US' ? 'America/New_York' : market === 'KR' ? 'Asia/Seoul' : 'Asia/Shanghai';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((part) => [part.type, part.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  if (market === 'US') return minute >= 240 && minute < 1200;
  if (market === 'KR') return minute >= 540 && minute < 930;
  return market === 'A' ? (minute >= 570 && minute < 690) || (minute >= 780 && minute < 900) : (minute >= 570 && minute < 720) || (minute >= 780 && minute < 960);
}
