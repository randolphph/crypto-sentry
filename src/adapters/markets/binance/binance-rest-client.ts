import { z } from 'zod';
import { Decimal } from 'decimal.js';

import type { DiscoveredMarket } from '../market.js';
import type { MarketType } from '../market.js';

const pingResponseSchema = z.object({}).passthrough();
const spotExchangeInfoSchema = z.object({
  symbols: z.array(z.object({
    symbol: z.string().min(1),
    status: z.string(),
    baseAsset: z.string().min(1),
    quoteAsset: z.string().min(1),
    isSpotTradingAllowed: z.boolean().optional(),
  }).passthrough()),
}).passthrough();
const futuresExchangeInfoSchema = z.object({
  symbols: z.array(z.object({
    symbol: z.string().min(1),
    status: z.string(),
    contractType: z.string(),
    baseAsset: z.string().min(1),
    quoteAsset: z.string().min(1),
  }).passthrough()),
}).passthrough();
const klineResponseSchema = z.array(z.array(z.unknown()).min(7));
const openInterestResponseSchema = z.object({
  symbol: z.string().min(1),
  openInterest: z.string().min(1),
  time: z.number().int().nonnegative().optional(),
}).passthrough();

const usdEquivalentQuotes = new Set(['USD', 'USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD']);

export interface BinanceRestClientOptions {
  spotRestUrl: string;
  futuresRestUrl: string;
  fetch?: typeof globalThis.fetch;
  timeoutMilliseconds?: number;
}

export interface BinanceKlineRequest {
  marketType: MarketType;
  providerSymbol: string;
  startTime: number;
  endTime: number;
}

export interface BinancePriceSample {
  observedAt: string;
  price: string;
}

export interface BinanceOpenInterest {
  providerSymbol: string;
  openInterest: string;
  observedAt: string;
}

export class BinanceRestError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'BinanceRestError';
  }
}

export function canonicalizeBinanceSymbol(baseAsset: string, quoteAsset: string): string {
  const canonicalQuote = usdEquivalentQuotes.has(quoteAsset.toUpperCase()) ? 'USD' : quoteAsset.toUpperCase();
  return `${baseAsset.toUpperCase()}/${canonicalQuote}`;
}

export class BinanceRestClient {
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly timeoutMilliseconds: number;

  public constructor(private readonly options: BinanceRestClientOptions) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 5_000;
  }

  public async testConnectivity(): Promise<{ spot: 'ok'; perpetual: 'ok' }> {
    await Promise.all([
      this.request(this.options.spotRestUrl, '/api/v3/ping', pingResponseSchema),
      this.request(this.options.futuresRestUrl, '/fapi/v1/ping', pingResponseSchema),
    ]);
    return { spot: 'ok', perpetual: 'ok' };
  }

  public async discoverMarkets(): Promise<DiscoveredMarket[]> {
    const [spot, futures] = await Promise.all([
      this.request(this.options.spotRestUrl, '/api/v3/exchangeInfo', spotExchangeInfoSchema),
      this.request(this.options.futuresRestUrl, '/fapi/v1/exchangeInfo', futuresExchangeInfoSchema),
    ]);

    const spotMarkets: DiscoveredMarket[] = spot.symbols
      .filter((symbol) => symbol.status === 'TRADING' && symbol.isSpotTradingAllowed !== false)
      .map((symbol) => ({
        marketType: 'spot',
        providerSymbol: symbol.symbol,
        canonicalSymbol: canonicalizeBinanceSymbol(symbol.baseAsset, symbol.quoteAsset),
        baseAsset: symbol.baseAsset,
        quoteAsset: symbol.quoteAsset,
        status: 'active',
      }));
    const perpetualMarkets: DiscoveredMarket[] = futures.symbols
      .filter((symbol) => symbol.status === 'TRADING' && symbol.contractType === 'PERPETUAL')
      .map((symbol) => ({
        marketType: 'perpetual',
        providerSymbol: symbol.symbol,
        canonicalSymbol: canonicalizeBinanceSymbol(symbol.baseAsset, symbol.quoteAsset),
        baseAsset: symbol.baseAsset,
        quoteAsset: symbol.quoteAsset,
        status: 'active',
      }));

    return [...spotMarkets, ...perpetualMarkets];
  }

  public async loadPriceSamples(input: BinanceKlineRequest): Promise<BinancePriceSample[]> {
    const path = input.marketType === 'spot' ? '/api/v3/klines' : '/fapi/v1/markPriceKlines';
    const baseUrl = input.marketType === 'spot' ? this.options.spotRestUrl : this.options.futuresRestUrl;
    const parameters = new URLSearchParams({
      symbol: input.providerSymbol.toUpperCase(),
      interval: '1m',
      startTime: String(input.startTime),
      endTime: String(input.endTime),
      limit: '1000',
    });
    const rows = await this.request(baseUrl, `${path}?${parameters.toString()}`, klineResponseSchema);
    return rows.flatMap((row) => {
      const close = row[4];
      const closeTime = row[6];
      if (typeof close !== 'string' || typeof closeTime !== 'number' || !Number.isSafeInteger(closeTime)) return [];
      try {
        const price = new Decimal(close);
        const observedAt = new Date(closeTime);
        if (
          !price.isFinite() ||
          !price.isPositive() ||
          Number.isNaN(observedAt.getTime()) ||
          closeTime < input.startTime ||
          closeTime > input.endTime
        ) return [];
        return [{ observedAt: observedAt.toISOString(), price: close }];
      } catch {
        return [];
      }
    });
  }

  public async loadOpenInterest(providerSymbol: string): Promise<BinanceOpenInterest> {
    const parameters = new URLSearchParams({ symbol: providerSymbol.toUpperCase() });
    const result = await this.request(
      this.options.futuresRestUrl,
      `/fapi/v1/openInterest?${parameters.toString()}`,
      openInterestResponseSchema,
    );
    try {
      const value = new Decimal(result.openInterest);
      if (!value.isFinite() || value.isNegative()) throw new Error('invalid open interest');
    } catch (error) {
      throw new BinanceRestError('Binance returned invalid open interest', error);
    }
    return {
      providerSymbol: result.symbol,
      openInterest: result.openInterest,
      observedAt: new Date(result.time ?? Date.now()).toISOString(),
    };
  }

  private async request<Output>(baseUrl: string, path: string, schema: z.ZodType<Output>): Promise<Output> {
    const url = new URL(path, ensureTrailingSlash(baseUrl));
    try {
      const response = await this.fetchImplementation(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      });
      if (!response.ok) {
        throw new BinanceRestError(`Binance returned HTTP ${response.status}`);
      }
      return schema.parse(await response.json());
    } catch (error) {
      if (error instanceof BinanceRestError) throw error;
      throw new BinanceRestError('Binance REST request failed', error);
    }
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
