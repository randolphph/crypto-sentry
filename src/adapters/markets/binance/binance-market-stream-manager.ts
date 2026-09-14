import type { Metric } from '../../../core/metrics/metric.js';
import type { MarketType } from '../market.js';
import { SharedWebSocketFeed } from '../websocket/shared-websocket-feed.js';
import type { MarketWebSocketFactory } from '../websocket/websocket-port.js';
import { decodeBinancePriceEvent } from './binance-stream-message.js';
import type { BinancePriceEvent } from './binance-stream-message.js';

export interface BinanceMonitorSubscription {
  monitorId: string;
  marketType: MarketType;
  providerSymbol: string;
  canonicalSymbol?: string | undefined;
  priceType?: 'last' | 'mark' | undefined;
}

export interface BinanceMarketStreamManagerOptions {
  spotWebsocketUrl: string;
  futuresWebsocketUrl: string;
  webSocketFactory: MarketWebSocketFactory;
  emitMetric(metric: Metric): Promise<void>;
  onError(error: Error): void;
  rotationMilliseconds?: number;
  reconnectBaseMilliseconds?: number;
  reconnectMaxMilliseconds?: number;
  stableConnectionMilliseconds?: number;
}

export class BinanceMarketStreamManager {
  private subscriptions = new Map<string, BinanceMonitorSubscription[]>();
  private readonly spotFeed: SharedWebSocketFeed;
  private readonly perpetualFeed: SharedWebSocketFeed;

  public constructor(private readonly options: BinanceMarketStreamManagerOptions) {
    const lifecycleOptions = {
      factory: options.webSocketFactory,
      onError: (error: Error) => options.onError(error),
      ...(options.rotationMilliseconds === undefined ? {} : { rotationMilliseconds: options.rotationMilliseconds }),
      ...(options.reconnectBaseMilliseconds === undefined ? {} : { reconnectBaseMilliseconds: options.reconnectBaseMilliseconds }),
      ...(options.reconnectMaxMilliseconds === undefined ? {} : { reconnectMaxMilliseconds: options.reconnectMaxMilliseconds }),
      ...(options.stableConnectionMilliseconds === undefined ? {} : { stableConnectionMilliseconds: options.stableConnectionMilliseconds }),
    };
    this.spotFeed = new SharedWebSocketFeed({
      ...lifecycleOptions,
      baseUrl: options.spotWebsocketUrl,
      onMessage: (message) => this.handleMessage('spot', message),
    });
    this.perpetualFeed = new SharedWebSocketFeed({
      ...lifecycleOptions,
      baseUrl: options.futuresWebsocketUrl,
      onMessage: (message) => this.handleMessage('perpetual', message),
    });
  }

  public setSubscriptions(subscriptions: BinanceMonitorSubscription[]): void {
    const next = new Map<string, BinanceMonitorSubscription[]>();
    for (const subscription of subscriptions) {
      const key = subscriptionKey(subscription.marketType, subscription.providerSymbol);
      const current = next.get(key) ?? [];
      current.push(subscription);
      next.set(key, current);
    }
    this.subscriptions = next;
    this.spotFeed.setStreams(uniqueStreams(subscriptions, 'spot', '@miniTicker'));
    this.perpetualFeed.setStreams(uniqueStreams(subscriptions, 'perpetual', '@markPrice@1s'));
  }

  public close(): void {
    this.spotFeed.close();
    this.perpetualFeed.close();
    this.subscriptions.clear();
  }

  private handleMessage(marketType: MarketType, message: string): void {
    const event = decodeBinancePriceEvent(marketType, message);
    if (event === undefined) return;
    const subscriptions = this.subscriptions.get(subscriptionKey(marketType, event.providerSymbol)) ?? [];
    for (const subscription of subscriptions) {
      void this.options.emitMetric(toMetric(subscription, event)).catch((error: unknown) => {
        this.options.onError(error instanceof Error ? error : new Error(String(error)));
      });
    }
  }
}

function uniqueStreams(
  subscriptions: BinanceMonitorSubscription[],
  marketType: MarketType,
  suffix: string,
): string[] {
  return [...new Set(
    subscriptions
      .filter((subscription) => subscription.marketType === marketType)
      .map((subscription) => `${subscription.providerSymbol.toLowerCase()}${suffix}`),
  )];
}

function subscriptionKey(marketType: MarketType, providerSymbol: string): string {
  return `${marketType}:${providerSymbol.toUpperCase()}`;
}

function toMetric(subscription: BinanceMonitorSubscription, event: BinancePriceEvent): Metric {
  const receivedAt = new Date().toISOString();
  return {
    monitorId: subscription.monitorId,
    source: 'binance',
    target: subscription.canonicalSymbol ?? subscription.providerSymbol,
    name: 'price',
    value: event.price,
    observedAt: new Date(event.eventTime).toISOString(),
    receivedAt,
    status: 'ok',
    labels: {
      marketType: event.marketType,
      priceType: event.priceType,
      providerSymbol: event.providerSymbol,
    },
  };
}
