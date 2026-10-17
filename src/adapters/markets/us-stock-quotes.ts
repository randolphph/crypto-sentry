import { z } from 'zod';
import { Decimal } from 'decimal.js';

export type StockQuoteProvider = 'auto' | 'sina' | 'yahoo' | 'binance';
export interface StockQuote {
  symbol: string; price: string; currency: 'USD' | 'USDT';
  provider: Exclude<StockQuoteProvider, 'auto'>; observedAt: string;
  session: 'regular' | 'extended' | 'continuous';
  priceBasis: 'stock' | 'perpetual_mark';
  name?: string;
  changePct?: number;
}
export interface StockQuoteRequest { symbol: string; provider: StockQuoteProvider; includeExtended: boolean; maxStaleSeconds: number }
const headers = { 'user-agent': 'Mozilla/5.0', accept: 'application/json,text/plain,*/*' };
const yahooSchema = z.object({ chart: z.object({ result: z.array(z.object({
  meta: z.object({ symbol: z.string(), currency: z.string(), regularMarketPrice: z.number(), regularMarketTime: z.number(), chartPreviousClose: z.number().optional(), previousClose: z.number().optional(), shortName: z.string().optional() }),
  timestamp: z.array(z.number()).optional(),
  indicators: z.object({ quote: z.array(z.object({ close: z.array(z.number().nullable()) })) }).optional(),
})).nullable() }) });
const equitySchema = z.object({ symbols: z.array(z.object({ symbol: z.string(), baseAsset: z.string(), quoteAsset: z.string(), status: z.string(), contractType: z.string(), underlyingType: z.string().optional() })) });
const markSchema = z.object({ symbol: z.string(), markPrice: z.string(), time: z.number() });
function price(value: string | number): string {
  const parsed = new Decimal(value);
  if (!parsed.isFinite() || parsed.lte(0)) throw new Error('行情价格无效');
  return parsed.toString();
}
function iso(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('行情时间无效');
  return new Date(seconds * 1_000).toISOString();
}
const identity = (value: string) => value.toUpperCase().replace(/[.-]/gu, '');

// Sina's field 3 is the response clock, not the regular-session trade time.
// Fields 24/25 identify extended/regular trades in the US Eastern timezone.
export function sinaTradeTime(value: string, now: Date): string {
  const matched = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{1,2}):(\d{2})(AM|PM)\s+(EDT|EST)$/iu.exec(value.trim());
  if (!matched) throw new Error('新浪未提供有效成交时间');
  const month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf((matched[1] ?? '').toLowerCase());
  const hour = Number(matched[3]); const minute = Number(matched[4]); const day = Number(matched[2]);
  if (hour < 1 || hour > 12 || minute > 59 || day < 1 || day > 31) throw new Error('新浪成交时间无效');
  const utcHour = hour % 12 + (matched[5]?.toUpperCase() === 'PM' ? 12 : 0) + (matched[6]?.toUpperCase() === 'EDT' ? 4 : 5);
  let timestamp = Date.UTC(now.getUTCFullYear(), month, day, utcHour, minute);
  if (timestamp > now.getTime() + 86_400_000) timestamp = Date.UTC(now.getUTCFullYear() - 1, month, day, utcHour, minute);
  return new Date(timestamp).toISOString();
}

export class UsStockQuoteReader {
  private equities: z.infer<typeof equitySchema>['symbols'] = [];
  private equitiesExpireAt = 0;
  private equitiesPending: Promise<void> | undefined;
  public constructor(private readonly fetch: typeof globalThis.fetch = globalThis.fetch, private readonly now = () => new Date()) {}

  public async read(request: StockQuoteRequest, signal?: AbortSignal): Promise<StockQuote> {
    const quotes = await this.readAll(request, signal);
    const newest = quotes.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
    if (!newest) throw new Error('没有可用的美股行情');
    return newest;
  }

  public async readAll(request: StockQuoteRequest, signal?: AbortSignal): Promise<StockQuote[]> {
    const sources = request.provider === 'auto' ? ['sina', 'yahoo', 'binance'] as const : [request.provider];
    const results = await Promise.allSettled(sources.map(async (source) => {
      const quote = source === 'sina' ? await this.sina(request, signal) : source === 'yahoo' ? await this.yahoo(request, signal) : await this.binance(request, signal);
      if (Date.parse(quote.observedAt) > this.now().getTime() + 60_000) throw new Error('行情时间位于未来');
      return quote;
    }));
    if (signal?.aborted) throw signal.reason;
    const quotes = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    if (!quotes.length) throw new Error(results.flatMap((result, index) => result.status === 'rejected' ? [`${sources[index]}: ${result.reason instanceof Error ? result.reason.message : '行情读取失败'}`] : []).join('; '));
    return quotes;
  }

  private async get(url: string, signal?: AbortSignal, extraHeaders: Record<string,string> = {}): Promise<Response> {
    const response = await this.fetch(url, { headers: { ...headers, ...extraHeaders }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`行情源返回 HTTP ${response.status}`);
    return response;
  }

  private async sina(request: StockQuoteRequest, signal?: AbortSignal): Promise<StockQuote> {
    const code = request.symbol.toLowerCase().replace(/[.-]/gu, '_');
    const response = await this.get(`https://hq.sinajs.cn/list=gb_${encodeURIComponent(code)}`, signal, { Referer: 'https://finance.sina.com.cn/' });
    const text = new TextDecoder('gb18030').decode(await response.arrayBuffer());
    const match = new RegExp(`hq_str_gb_${code}="([^\x22]*)"`, 'u').exec(text);
    const fields = match?.[1]?.split(',');
    if (!fields || fields.length < 27) throw new Error('新浪未找到该美股');
    let quote: StockQuote = { symbol: request.symbol, price: price(fields[1] ?? ''), currency: 'USD', provider: 'sina', observedAt: sinaTradeTime(fields[25] ?? '', this.now()), session: 'regular', priceBasis: 'stock' };
    if (request.includeExtended && fields[21] && fields[24]) {
      try {
        const extended = { ...quote, price: price(fields[21]), observedAt: sinaTradeTime(fields[24], this.now()), session: 'extended' as const };
        if (Date.parse(extended.observedAt) > Date.parse(quote.observedAt)) quote = extended;
      } catch { /* Missing extended-session quote does not invalidate the regular quote. */ }
    }
    const changePct = Number(fields[2]);
    return { ...quote, ...(fields[0] ? { name: fields[0] } : {}), ...(Number.isFinite(changePct) ? { changePct } : {}) };
  }

  private async yahoo(request: StockQuoteRequest, signal?: AbortSignal): Promise<StockQuote> {
    const symbol = request.symbol.replaceAll('.', '-');
    const response = await this.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=${String(request.includeExtended)}`, signal);
    const result = yahooSchema.parse(await response.json()).chart.result?.[0];
    if (!result || identity(result.meta.symbol) !== identity(request.symbol) || result.meta.currency !== 'USD') throw new Error('Yahoo 行情标的或币种不匹配');
    let quote: StockQuote = { symbol: request.symbol, price: price(result.meta.regularMarketPrice), observedAt: iso(result.meta.regularMarketTime), provider: 'yahoo', currency: 'USD', session: 'regular', priceBasis: 'stock' };
    if (request.includeExtended) {
      const closes = result.indicators?.quote[0]?.close ?? [];
      for (let index = closes.length - 1; index >= 0; index--) {
        const close = closes[index]; const timestamp = result.timestamp?.[index];
        if (close === null || close === undefined || close <= 0 || timestamp === undefined || timestamp <= result.meta.regularMarketTime) continue;
        quote = { ...quote, price: price(close), observedAt: iso(timestamp), session: 'extended' };
        break;
      }
    }
    const previous = result.meta.chartPreviousClose ?? result.meta.previousClose;
    const changePct = previous && previous > 0 ? new Decimal(quote.price).div(previous).minus(1).times(100).toNumber() : undefined;
    return { ...quote, ...(result.meta.shortName ? { name: result.meta.shortName } : {}), ...(changePct === undefined ? {} : { changePct }) };
  }

  private async binance(request: StockQuoteRequest, signal?: AbortSignal): Promise<StockQuote> {
    if (this.equitiesExpireAt <= this.now().getTime()) {
      this.equitiesPending ??= (async () => {
        const response = await this.get('https://fapi.binance.com/fapi/v1/exchangeInfo', signal);
        this.equities = equitySchema.parse(await response.json()).symbols;
        this.equitiesExpireAt = this.now().getTime() + 300_000;
      })().finally(() => { this.equitiesPending = undefined; });
      await this.equitiesPending;
    }
    const market = this.equities.find((item) => identity(item.baseAsset) === identity(request.symbol) && item.quoteAsset === 'USDT' && item.status === 'TRADING' && item.underlyingType === 'EQUITY' && ['TRADIFI_PERPETUAL', 'PERPETUAL'].includes(item.contractType));
    if (!market) throw new Error('币安未提供该标的可交易的美股永续合约');
    const response = await this.get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(market.symbol)}`, signal);
    const mark = markSchema.parse(await response.json());
    if (mark.symbol !== market.symbol) throw new Error('币安返回的合约不匹配');
    return { symbol: request.symbol, price: price(mark.markPrice), observedAt: iso(mark.time / 1_000), provider: 'binance', currency: 'USDT', session: 'continuous', priceBasis: 'perpetual_mark' };
  }
}
