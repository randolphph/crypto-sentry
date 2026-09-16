import { Decimal } from 'decimal.js';
import { z } from 'zod';

import type { MarketType } from '../market.js';

const spotMiniTickerSchema = z.object({
  e: z.literal('24hrMiniTicker'),
  E: z.number().int().nonnegative().max(8_640_000_000_000_000),
  s: z.string().min(1),
  c: z.string().min(1),
  v: z.string().min(1).optional(),
  q: z.string().min(1).optional(),
}).passthrough();
const perpetualMarkPriceSchema = z.object({
  e: z.literal('markPriceUpdate'),
  E: z.number().int().nonnegative().max(8_640_000_000_000_000),
  s: z.string().min(1),
  p: z.string().min(1),
  r: z.string().optional(),
  T: z.number().int().nonnegative().max(8_640_000_000_000_000).optional(),
}).passthrough();
const combinedMessageSchema = z.object({ data: z.unknown() }).passthrough();

export interface BinancePriceEvent {
  marketType: MarketType;
  providerSymbol: string;
  priceType: 'last' | 'mark';
  price: string;
  eventTime: number;
}

export type BinanceMarketEvent =
  | {
      type: 'ticker'; marketType: MarketType; providerSymbol: string; eventTime: number;
      lastPrice: string; baseVolume24h?: string; quoteVolume24h?: string;
    }
  | {
      type: 'mark_price'; marketType: 'perpetual'; providerSymbol: string; eventTime: number;
      markPrice: string; fundingRatePercent?: string; nextFundingTime?: string;
    };

export function decodeBinanceMarketEvent(marketType: MarketType, rawMessage: string): BinanceMarketEvent | undefined {
  let input: unknown;
  try {
    input = JSON.parse(rawMessage);
  } catch {
    return undefined;
  }
  const combined = combinedMessageSchema.safeParse(input);
  const payload = combined.success ? combined.data.data : input;
  const ticker = spotMiniTickerSchema.safeParse(payload);
  if (ticker.success && validPrice(ticker.data.c) &&
    (ticker.data.v === undefined || validNonNegative(ticker.data.v)) &&
    (ticker.data.q === undefined || validNonNegative(ticker.data.q))) {
    return {
      type: 'ticker', marketType, providerSymbol: ticker.data.s, eventTime: ticker.data.E,
      lastPrice: ticker.data.c,
      ...(ticker.data.v === undefined ? {} : { baseVolume24h: ticker.data.v }),
      ...(ticker.data.q === undefined ? {} : { quoteVolume24h: ticker.data.q }),
    };
  }
  if (marketType !== 'perpetual') return undefined;
  const mark = perpetualMarkPriceSchema.safeParse(payload);
  if (!mark.success || !validPrice(mark.data.p) ||
    (mark.data.r !== undefined && !validDecimal(mark.data.r))) return undefined;
  return {
    type: 'mark_price', marketType, providerSymbol: mark.data.s, eventTime: mark.data.E,
    markPrice: mark.data.p,
    ...(mark.data.r === undefined ? {} : {
      fundingRatePercent: new Decimal(mark.data.r).times(100).toSignificantDigits(30).toString(),
    }),
    ...(mark.data.T === undefined ? {} : { nextFundingTime: String(mark.data.T) }),
  };
}

export function decodeBinancePriceEvent(marketType: MarketType, rawMessage: string): BinancePriceEvent | undefined {
  const event = decodeBinanceMarketEvent(marketType, rawMessage);
  if (event === undefined) return undefined;
  if (event.type === 'ticker' && marketType === 'spot') {
    return {
      marketType,
      providerSymbol: event.providerSymbol,
      priceType: 'last',
      price: event.lastPrice,
      eventTime: event.eventTime,
    };
  }
  if (event.type !== 'mark_price') return undefined;
  return {
    marketType,
    providerSymbol: event.providerSymbol,
    priceType: 'mark',
    price: event.markPrice,
    eventTime: event.eventTime,
  };
}

function validDecimal(value: string): boolean {
  try {
    return new Decimal(value).isFinite();
  } catch {
    return false;
  }
}

function validNonNegative(value: string): boolean {
  try {
    return new Decimal(value).isFinite() && new Decimal(value).gte(0);
  } catch {
    return false;
  }
}

function validPrice(value: string): boolean {
  try {
    return new Decimal(value).isFinite() && new Decimal(value).gt(0);
  } catch {
    return false;
  }
}
