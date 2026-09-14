import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BinanceMarketStreamManager } from '../src/adapters/markets/binance/binance-market-stream-manager.js';
import { decodeBinancePriceEvent } from '../src/adapters/markets/binance/binance-stream-message.js';
import { SharedWebSocketFeed } from '../src/adapters/markets/websocket/shared-websocket-feed.js';
import type {
  MarketWebSocketFactory,
  MarketWebSocketHandle,
  MarketWebSocketHandlers,
} from '../src/adapters/markets/websocket/websocket-port.js';
import { websocketEndpoint } from '../src/adapters/markets/websocket/websocket-port.js';
import type { Metric } from '../src/core/metrics/metric.js';

class FakeSocket implements MarketWebSocketHandle {
  public readyState = 0;
  public readonly sent: string[] = [];

  public constructor(
    public readonly url: string,
    private readonly handlers: MarketWebSocketHandlers,
  ) {}

  public open(): void {
    this.readyState = 1;
    this.handlers.open();
  }

  public message(payload: unknown): void {
    this.handlers.message(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  public unexpectedClose(code = 1006, reason = 'network lost'): void {
    this.readyState = 3;
    this.handlers.close(code, reason);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.handlers.close(code, reason);
  }

  public terminate(): void {
    this.unexpectedClose();
  }
}

function createFakeFactory(): { factory: MarketWebSocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: (url, handlers) => {
      const socket = new FakeSocket(url, handlers);
      sockets.push(socket);
      return socket;
    },
  };
}

function parseControlMessage(message: string): { method: string; params: string[]; id: number } {
  return JSON.parse(message) as { method: string; params: string[]; id: number };
}

describe('Binance WebSocket messages', () => {
  it('builds raw subscription endpoints from root and routed base URLs', () => {
    expect(websocketEndpoint('wss://stream.binance.com:9443')).toBe('wss://stream.binance.com:9443/ws');
    expect(websocketEndpoint('wss://fstream.binance.com/market')).toBe('wss://fstream.binance.com/market/ws');
  });

  it('decodes spot last prices and perpetual mark prices and ignores invalid payloads', () => {
    expect(decodeBinancePriceEvent('spot', JSON.stringify({
      e: '24hrMiniTicker', E: 1_725_000_000_000, s: 'BTCUSDT', c: '90123.456789',
    }))).toEqual({
      marketType: 'spot',
      providerSymbol: 'BTCUSDT',
      priceType: 'last',
      price: '90123.456789',
      eventTime: 1_725_000_000_000,
    });
    expect(decodeBinancePriceEvent('perpetual', JSON.stringify({
      stream: 'ethusdt@markPrice@1s',
      data: { e: 'markPriceUpdate', E: 1_725_000_000_100, s: 'ETHUSDT', p: '2456.78' },
    }))).toEqual(expect.objectContaining({ priceType: 'mark', price: '2456.78' }));
    expect(decodeBinancePriceEvent('spot', '{invalid')).toBeUndefined();
    expect(decodeBinancePriceEvent('spot', JSON.stringify({
      e: '24hrMiniTicker', E: 1_725_000_000_000, s: 'BTCUSDT', c: '-1',
    }))).toBeUndefined();
    expect(decodeBinancePriceEvent('spot', JSON.stringify({ result: null, id: 1 }))).toBeUndefined();
  });
});

describe('Shared WebSocket feed lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('updates subscriptions, reconnects with backoff, and resubscribes', async () => {
    const { factory, sockets } = createFakeFactory();
    const errors: Error[] = [];
    const messages: string[] = [];
    const feed = new SharedWebSocketFeed({
      baseUrl: 'wss://stream.example',
      factory,
      onMessage: (message) => messages.push(message),
      onError: (error) => errors.push(error),
      reconnectBaseMilliseconds: 1_000,
      reconnectMaxMilliseconds: 30_000,
    });

    feed.setStreams(['btcusdt@miniTicker', 'ethusdt@miniTicker']);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe('wss://stream.example/ws');
    sockets[0]?.open();
    expect(parseControlMessage(sockets[0]?.sent[0] ?? '{}')).toMatchObject({
      method: 'SUBSCRIBE',
      params: ['btcusdt@miniTicker', 'ethusdt@miniTicker'],
    });

    feed.setStreams(['btcusdt@miniTicker', 'solusdt@miniTicker']);
    expect(sockets[0]?.sent.slice(1).map(parseControlMessage)).toEqual([
      expect.objectContaining({ method: 'UNSUBSCRIBE', params: ['ethusdt@miniTicker'] }),
      expect.objectContaining({ method: 'SUBSCRIBE', params: ['solusdt@miniTicker'] }),
    ]);

    sockets[0]?.unexpectedClose();
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    expect(parseControlMessage(sockets[1]?.sent[0] ?? '{}')).toMatchObject({
      method: 'SUBSCRIBE',
      params: ['btcusdt@miniTicker', 'solusdt@miniTicker'],
    });
    sockets[0]?.message('ignored from old connection');
    sockets[1]?.message('received after reconnect');
    expect(messages).toEqual(['received after reconnect']);
    feed.close();
  });

  it('rotates a healthy connection without reporting an error', async () => {
    const { factory, sockets } = createFakeFactory();
    const errors: Error[] = [];
    const feed = new SharedWebSocketFeed({
      baseUrl: 'wss://stream.example/ws',
      factory,
      onMessage: () => undefined,
      onError: (error) => errors.push(error),
      rotationMilliseconds: 100,
    });
    feed.setStreams(['btcusdt@miniTicker']);
    sockets[0]?.open();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersToNextTimerAsync();
    expect(sockets).toHaveLength(2);
    expect(errors).toEqual([]);
    feed.close();
  });
});

describe('Binance market stream manager', () => {
  it('shares connections and emits one normalized Metric per monitor', async () => {
    const { factory, sockets } = createFakeFactory();
    const metrics: Metric[] = [];
    const manager = new BinanceMarketStreamManager({
      spotWebsocketUrl: 'wss://spot.example',
      futuresWebsocketUrl: 'wss://futures.example',
      webSocketFactory: factory,
      emitMetric: async (metric) => {
        metrics.push(metric);
      },
      onError: () => undefined,
    });
    manager.setSubscriptions([
      { monitorId: 'mon_spot_1', marketType: 'spot', providerSymbol: 'BTCUSDT', canonicalSymbol: 'BTC/USD' },
      { monitorId: 'mon_spot_2', marketType: 'spot', providerSymbol: 'BTCUSDT' },
      { monitorId: 'mon_perp', marketType: 'perpetual', providerSymbol: 'ETHUSDT', canonicalSymbol: 'ETH/USD' },
    ]);
    expect(sockets).toHaveLength(2);
    const spot = sockets.find((socket) => socket.url.includes('spot'));
    const perpetual = sockets.find((socket) => socket.url.includes('futures'));
    spot?.open();
    perpetual?.open();
    spot?.message({ e: '24hrMiniTicker', E: 1_725_000_000_000, s: 'BTCUSDT', c: '90000.01' });
    perpetual?.message({ e: 'markPriceUpdate', E: 1_725_000_000_100, s: 'ETHUSDT', p: '2500.02' });
    await Promise.resolve();

    expect(metrics).toHaveLength(3);
    expect(metrics.find((metric) => metric.monitorId === 'mon_spot_1')).toMatchObject({
      target: 'BTC/USD', value: '90000.01', labels: { priceType: 'last' },
    });
    expect(metrics.find((metric) => metric.monitorId === 'mon_spot_2')).toMatchObject({
      target: 'BTCUSDT', value: '90000.01',
    });
    expect(metrics.find((metric) => metric.monitorId === 'mon_perp')).toMatchObject({
      target: 'ETH/USD', value: '2500.02', labels: { priceType: 'mark' },
    });
    manager.close();
  });
});
