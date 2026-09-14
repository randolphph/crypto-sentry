import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type {
  MarketWebSocketFactory,
  MarketWebSocketHandle,
  MarketWebSocketHandlers,
} from '../src/adapters/markets/websocket/websocket-port.js';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

class ControlledSocket implements MarketWebSocketHandle {
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
    this.handlers.message(JSON.stringify(payload));
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
    this.close(1006, 'terminated');
  }
}

const token = 'coordinator-api-token-that-is-long-enough';
const authorization = { authorization: `Bearer ${token}` };
const config: AppConfig = {
  databasePath: ':memory:',
  apiToken: token,
  masterEncryptionKey: Buffer.alloc(32, 6),
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
};

describe('Binance market data hot reload', () => {
  let app: FastifyInstance;
  let sockets: ControlledSocket[];

  beforeEach(async () => {
    sockets = [];
    const factory: MarketWebSocketFactory = (url, handlers) => {
      const socket = new ControlledSocket(url, handlers);
      sockets.push(socket);
      return socket;
    };
    app = await createApp({ config, logger: false, webSocketFactory: factory });
  });

  afterEach(async () => {
    await app.close();
  });

  it('subscribes enabled monitors, feeds the Metric pipeline, and hot-unsubscribes', async () => {
    const integrationResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: authorization,
      payload: {
        name: 'Binance Stream',
        type: 'market_data',
        provider: 'binance',
        config: {
          restUrl: 'https://spot-rest.example',
          spotWebsocketUrl: 'wss://spot-stream.example',
          futuresWebsocketUrl: 'wss://futures-stream.example',
        },
      },
    });
    const integrationId = integrationResponse.json<{ id: string }>().id;
    const monitorResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: authorization,
      payload: {
        name: 'BTC spot stream',
        type: 'market',
        config: {
          integrationId,
          marketType: 'spot',
          providerSymbol: 'BTCUSDT',
          canonicalSymbol: 'BTC/USD',
          priceType: 'last',
        },
      },
    });
    expect(monitorResponse.statusCode).toBe(201);
    const monitorId = monitorResponse.json<{ id: string }>().id;
    expect(sockets).toHaveLength(1);
    sockets[0]?.open();
    expect(JSON.parse(sockets[0]?.sent[0] ?? '{}')).toMatchObject({
      method: 'SUBSCRIBE',
      params: ['btcusdt@miniTicker'],
    });

    sockets[0]?.message({
      e: '24hrMiniTicker',
      E: Date.now(),
      s: 'BTCUSDT',
      c: '91234.5678',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const metricsResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/monitors/${monitorId}/metrics`,
      headers: authorization,
    });
    expect(metricsResponse.json<{ items: Array<{ value: string; target: string }> }>().items).toEqual([
      expect.objectContaining({ value: '91234.5678', target: 'BTC/USD' }),
    ]);

    const disableResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v1/monitors/${monitorId}`,
      headers: authorization,
      payload: { enabled: false },
    });
    expect(disableResponse.statusCode).toBe(200);
    expect(sockets[0]?.readyState).toBe(3);
    const emptyMetrics = await app.inject({
      method: 'GET',
      url: `/api/v1/monitors/${monitorId}/metrics`,
      headers: authorization,
    });
    expect(emptyMetrics.json<{ items: unknown[] }>().items).toEqual([]);

    const enableResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v1/monitors/${monitorId}`,
      headers: authorization,
      payload: { enabled: true },
    });
    expect(enableResponse.statusCode).toBe(200);
    expect(sockets).toHaveLength(2);
  });
});
