import type { Metric } from '../../../core/metrics/metric.js';
import type { MarketType } from '../market.js';
import { SharedWebSocketFeed } from '../websocket/shared-websocket-feed.js';
import type { MarketWebSocketFactory } from '../websocket/websocket-port.js';
import { decodeBinanceMarketEvent } from './binance-stream-message.js';
import type { BinanceMarketEvent } from './binance-stream-message.js';

export interface BinanceMonitorSubscription {
  monitorId: string;
  marketType: MarketType;
  providerSymbol: string;
  canonicalSymbol?: string | undefined;
  baseAsset?: string | undefined;
  quoteAsset?: string | undefined;
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
    this.perpetualFeed.setStreams([
      ...uniqueStreams(subscriptions, 'perpetual', '@markPrice@1s'),
      ...uniqueStreams(subscriptions, 'perpetual', '@miniTicker'),
    ]);
  }

  public close(): void {
    this.spotFeed.close();
    this.perpetualFeed.close();
    this.subscriptions.clear();
  }

  private handleMessage(marketType: MarketType, message: string): void {
    const event = decodeBinanceMarketEvent(marketType, message);
    if (event === undefined) return;
    const subscriptions = this.subscriptions.get(subscriptionKey(marketType, event.providerSymbol)) ?? [];
    for (const subscription of subscriptions) {
      for (const metric of toMetrics(subscription, event)) {
        void this.options.emitMetric(metric).catch((error: unknown) => {
          this.options.onError(error instanceof Error ? error : new Error(String(error)));
        });
      }
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

function inferredAssets(symbol: string): { baseAsset: string; quoteAsset: string } {
  const knownQuotes = ['FDUSD', 'USDT', 'USDC', 'BUSD', 'TUSD', 'BTC', 'ETH', 'BNB'];
  const quoteAsset = knownQuotes.find((quote) => symbol.toUpperCase().endsWith(quote)) ?? symbol.toUpperCase();
  const baseAsset = symbol.toUpperCase().slice(0, -quoteAsset.length) || symbol.toUpperCase();
  return { baseAsset, quoteAsset };
}

function toMetrics(subscription: BinanceMonitorSubscription, event: BinanceMarketEvent): Metric[] {
  const receivedAt = new Date().toISOString();
  const assets = inferredAssets(event.providerSymbol);
  const common = {
    monitorId: subscription.monitorId,
    source: 'binance',
    target: subscription.canonicalSymbol ?? subscription.providerSymbol,
    observedAt: new Date(event.eventTime).toISOString(),
    receivedAt,
    status: 'ok',
    labels: {
      marketType: event.marketType,
      providerSymbol: event.providerSymbol,
      canonicalSymbol: subscription.canonicalSymbol ?? subscription.providerSymbol,
    },
  } as const;
  if (event.type === 'mark_price') {
    return [
      { ...common, name: 'price', value: event.markPrice, labels: { ...common.labels, priceType: 'mark' } },
      ...(event.fundingRatePercent === undefined ? [] : [{
        ...common, name: 'funding_rate_percent', value: event.fundingRatePercent, unit: 'percent',
      }]),
      ...(event.nextFundingTime === undefined ? [] : [{
        ...common, name: 'next_funding_time', value: event.nextFundingTime, unit: 'unix_milliseconds',
      }]),
    ];
  }
  const baseAsset = subscription.baseAsset ?? assets.baseAsset;
  const quoteAsset = subscription.quoteAsset ?? assets.quoteAsset;
  return [
    ...(event.marketType === 'spot' ? [{
      ...common, name: 'price', value: event.lastPrice, labels: { ...common.labels, priceType: 'last' },
    }] : []),
    ...(event.baseVolume24h === undefined ? [] : [{
      ...common, name: 'base_volume_24h', value: event.baseVolume24h, unit: 'base_asset',
      labels: { ...common.labels, baseAsset, quoteAsset },
    }]),
    ...(event.quoteVolume24h === undefined ? [] : [{
      ...common, name: 'quote_volume_24h', value: event.quoteVolume24h, unit: 'quote_asset',
      labels: { ...common.labels, baseAsset, quoteAsset },
    }]),
  ];
}
