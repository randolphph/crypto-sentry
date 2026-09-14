import { Decimal } from 'decimal.js';
import { z } from 'zod';

import type { MarketType } from '../market.js';

const spotMiniTickerSchema = z.object({
  e: z.literal('24hrMiniTicker'),
  E: z.number().int().nonnegative().max(8_640_000_000_000_000),
  s: z.string().min(1),
  c: z.string().min(1),
}).passthrough();
const perpetualMarkPriceSchema = z.object({
  e: z.literal('markPriceUpdate'),
  E: z.number().int().nonnegative().max(8_640_000_000_000_000),
  s: z.string().min(1),
  p: z.string().min(1),
}).passthrough();
const combinedMessageSchema = z.object({ data: z.unknown() }).passthrough();

export interface BinancePriceEvent {
  marketType: MarketType;
  providerSymbol: string;
  priceType: 'last' | 'mark';
  price: string;
  eventTime: number;
}

export function decodeBinancePriceEvent(marketType: MarketType, rawMessage: string): BinancePriceEvent | undefined {
  let input: unknown;
  try {
    input = JSON.parse(rawMessage);
  } catch {
    return undefined;
  }
  const combined = combinedMessageSchema.safeParse(input);
  const payload = combined.success ? combined.data.data : input;
  if (marketType === 'spot') {
    const parsed = spotMiniTickerSchema.safeParse(payload);
    if (!parsed.success || !validPrice(parsed.data.c)) return undefined;
    return {
      marketType,
      providerSymbol: parsed.data.s,
      priceType: 'last',
      price: parsed.data.c,
      eventTime: parsed.data.E,
    };
  }
  const parsed = perpetualMarkPriceSchema.safeParse(payload);
  if (!parsed.success || !validPrice(parsed.data.p)) return undefined;
  return {
    marketType,
    providerSymbol: parsed.data.s,
    priceType: 'mark',
    price: parsed.data.p,
    eventTime: parsed.data.E,
  };
}

function validPrice(value: string): boolean {
  try {
    return new Decimal(value).isFinite() && new Decimal(value).gt(0);
  } catch {
    return false;
  }
}
