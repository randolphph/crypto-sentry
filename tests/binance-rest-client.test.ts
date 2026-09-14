import { describe, expect, it, vi } from 'vitest';

import {
  BinanceRestClient,
  BinanceRestError,
  canonicalizeBinanceSymbol,
} from '../src/adapters/markets/binance/binance-rest-client.js';
import { normalizeBinanceFuturesWebsocketUrl } from '../src/api/schemas.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Binance REST client', () => {
  it('maps active spot and USDⓈ-M perpetual markets into canonical symbols', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if (path === '/api/v3/exchangeInfo') {
        return jsonResponse({ symbols: [
          { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', quotePrecision: 8, isSpotTradingAllowed: true },
          { symbol: 'ETHUSDC', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'USDC', quoteAssetPrecision: 8 },
          { symbol: 'OLDUSDT', status: 'BREAK', baseAsset: 'OLD', quoteAsset: 'USDT' },
          { symbol: 'NOSPOTUSDT', status: 'TRADING', baseAsset: 'NOSPOT', quoteAsset: 'USDT', isSpotTradingAllowed: false },
        ] });
      }
      if (path === '/fapi/v1/exchangeInfo') {
        return jsonResponse({ symbols: [
          { symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'BTC', quoteAsset: 'USDT', pricePrecision: 2 },
          { symbol: 'ETHUSDT_261225', status: 'TRADING', contractType: 'CURRENT_QUARTER', baseAsset: 'ETH', quoteAsset: 'USDT', pricePrecision: 2 },
          { symbol: 'OLDUSDT', status: 'SETTLING', contractType: 'PERPETUAL', baseAsset: 'OLD', quoteAsset: 'USDT', pricePrecision: 3 },
        ] });
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const client = new BinanceRestClient({
      spotRestUrl: 'https://spot.example',
      futuresRestUrl: 'https://futures.example',
      fetch: fetchMock,
    });

    await expect(client.discoverMarkets()).resolves.toEqual([
      expect.objectContaining({ marketType: 'spot', providerSymbol: 'BTCUSDT', canonicalSymbol: 'BTC/USD' }),
      expect.objectContaining({ marketType: 'spot', providerSymbol: 'ETHUSDC', canonicalSymbol: 'ETH/USD' }),
      expect.objectContaining({ marketType: 'perpetual', providerSymbol: 'BTCUSDT', canonicalSymbol: 'BTC/USD' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('tests both spot and perpetual endpoints and reports upstream failures', async () => {
    const healthyFetch = vi.fn(async (_input: string | URL | Request) => jsonResponse({}));
    const healthyClient = new BinanceRestClient({
      spotRestUrl: 'https://spot.example',
      futuresRestUrl: 'https://futures.example',
      fetch: healthyFetch,
    });
    await expect(healthyClient.testConnectivity()).resolves.toEqual({ spot: 'ok', perpetual: 'ok' });
    expect(healthyFetch.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : input).pathname).sort()).toEqual([
      '/api/v3/ping',
      '/fapi/v1/ping',
    ]);

    const failingClient = new BinanceRestClient({
      spotRestUrl: 'https://spot.example',
      futuresRestUrl: 'https://futures.example',
      fetch: vi.fn(async () => jsonResponse({ message: 'unavailable' }, 503)),
    });
    await expect(failingClient.testConnectivity()).rejects.toBeInstanceOf(BinanceRestError);
  });

  it('loads spot close prices and perpetual mark-price closes for window warmup', async () => {
    const closeTime = 1_725_000_059_999;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.searchParams.get('symbol')).toBe('BTCUSDT');
      expect(url.searchParams.get('interval')).toBe('1m');
      return jsonResponse([
        [1_725_000_000_000, '90', '101', '89', '100.25', '1', closeTime, '1', 1, '1', '1', '0'],
        [1_725_000_060_000, 'bad', '101', '89', '-1', '1', closeTime + 60_000, '1', 1, '1', '1', '0'],
      ]);
    });
    const client = new BinanceRestClient({
      spotRestUrl: 'https://spot.example',
      futuresRestUrl: 'https://futures.example',
      fetch: fetchMock,
    });

    const request = { providerSymbol: 'btcusdt', startTime: 1_725_000_000_000, endTime: 1_725_001_800_000 };
    await expect(client.loadPriceSamples({ ...request, marketType: 'spot' })).resolves.toEqual([
      { observedAt: new Date(closeTime).toISOString(), price: '100.25' },
    ]);
    await expect(client.loadPriceSamples({ ...request, marketType: 'perpetual' })).resolves.toHaveLength(1);
    expect(fetchMock.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : input).pathname)).toEqual([
      '/api/v3/klines',
      '/fapi/v1/markPriceKlines',
    ]);
  });

  it('only collapses USD-equivalent quote assets', () => {
    expect(canonicalizeBinanceSymbol('btc', 'fdusd')).toBe('BTC/USD');
    expect(canonicalizeBinanceSymbol('eth', 'btc')).toBe('ETH/BTC');
  });

  it('migrates the retired USDⓈ-M WebSocket root to the market endpoint', () => {
    expect(normalizeBinanceFuturesWebsocketUrl('wss://fstream.binance.com')).toBe('wss://fstream.binance.com/market');
    expect(normalizeBinanceFuturesWebsocketUrl('wss://proxy.example/custom')).toBe('wss://proxy.example/custom');
  });
});
