import { z } from 'zod';

import type { DiscoveredMarket } from '../market.js';

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

const usdEquivalentQuotes = new Set(['USD', 'USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD']);

export interface BinanceRestClientOptions {
  spotRestUrl: string;
  futuresRestUrl: string;
  fetch?: typeof globalThis.fetch;
  timeoutMilliseconds?: number;
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
