import { describe, expect, it } from 'vitest';

import { BinanceMarketStreamManager } from '../src/adapters/markets/binance/binance-market-stream-manager.js';
import type {
  MarketWebSocketFactory,
  MarketWebSocketHandle,
  MarketWebSocketHandlers,
} from '../src/adapters/markets/websocket/websocket-port.js';
import { LatestMetricStore } from '../src/core/metrics/latest-metric-store.js';
import { MarketMetricService } from '../src/core/metrics/market-metric-service.js';
import type { MarketMetricRuntime, PriceSample, PriceSampleStore } from '../src/core/metrics/market-metric-service.js';
import { MetricPipeline } from '../src/core/metrics/metric-pipeline.js';
import type { MonitorRuntimeState, RuntimeMonitor } from '../src/core/metrics/metric-pipeline.js';
import type { Metric } from '../src/core/metrics/metric.js';

class CapacitySocket implements MarketWebSocketHandle {
  public readyState = 0;
  public readonly sent: string[] = [];

  public constructor(private readonly handlers: MarketWebSocketHandlers) {}

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
    this.readyState = 3;
    this.handlers.close(code, reason);
  }

  public terminate(): void {
    this.close(1006, 'terminated');
  }
}

class CapacitySampleStore implements PriceSampleStore {
  public readonly byMonitor = new Map<string, PriceSample[]>();
  public savedSamples = 0;

  public loadSince(monitorId: string, cutoff: string): PriceSample[] {
    return (this.byMonitor.get(monitorId) ?? []).filter((sample) => Date.parse(sample.observedAt) >= Date.parse(cutoff));
  }

  public saveAndPrune(monitorId: string, samples: PriceSample[], cutoff: string): void {
    this.savedSamples += samples.length;
    const current = [...(this.byMonitor.get(monitorId) ?? []), ...samples]
      .filter((sample) => Date.parse(sample.observedAt) >= Date.parse(cutoff));
    this.byMonitor.set(monitorId, current);
  }

  public clear(monitorId: string): void {
    this.byMonitor.delete(monitorId);
  }
}

class CapacityMonitorStore {
  public readonly monitors = new Map<string, RuntimeMonitor>();
  public readonly states = new Map<string, MonitorRuntimeState>();

  public findRuntimeMonitor(id: string): RuntimeMonitor | undefined {
    return this.monitors.get(id);
  }

  public updateRuntimeState(id: string, state: MonitorRuntimeState): void {
    this.states.set(id, state);
  }
}

function symbolAt(index: number): string {
  return `ASSET${String(index).padStart(3, '0')}USDT`;
}

describe('Binance 100-market capacity', () => {
  it('uses one shared WebSocket and fans out one hundred independent price metrics', async () => {
    const sockets: CapacitySocket[] = [];
    const factory: MarketWebSocketFactory = (_url, handlers) => {
      const socket = new CapacitySocket(handlers);
      sockets.push(socket);
      return socket;
    };
    const metrics: Metric[] = [];
    const manager = new BinanceMarketStreamManager({
      spotWebsocketUrl: 'wss://spot.example',
      futuresWebsocketUrl: 'wss://futures.example',
      webSocketFactory: factory,
      emitMetric: async (metric) => { metrics.push(metric); },
      onError: () => undefined,
    });
    manager.setSubscriptions(Array.from({ length: 100 }, (_, index) => ({
      monitorId: `mon_${index}`,
      marketType: 'spot' as const,
      providerSymbol: symbolAt(index),
    })));

    expect(sockets).toHaveLength(1);
    sockets[0]?.open();
    const subscribe = JSON.parse(sockets[0]?.sent[0] ?? '{}') as { method: string; params: string[] };
    expect(subscribe).toMatchObject({ method: 'SUBSCRIBE' });
    expect(subscribe.params).toHaveLength(100);
    for (let index = 0; index < 100; index += 1) {
      sockets[0]?.message({
        e: '24hrMiniTicker',
        E: 1_789_387_500_000 + index,
        s: symbolAt(index),
        c: String(100 + index),
      });
    }
    await Promise.resolve();
    expect(metrics).toHaveLength(100);
    expect(new Set(metrics.map((metric) => metric.monitorId)).size).toBe(100);
    manager.close();
  });

  it('samples and derives freshness and rolling change for one hundred monitors within one cycle', async () => {
    const current = new Date('2026-09-14T12:05:00.000Z');
    const referenceTime = new Date(current.getTime() - 300_000).toISOString();
    const sampleStore = new CapacitySampleStore();
    const monitorStore = new CapacityMonitorStore();
    const runtimes: MarketMetricRuntime[] = Array.from({ length: 100 }, (_, index) => {
      const monitorId = `mon_${index}`;
      monitorStore.monitors.set(monitorId, { id: monitorId, enabled: true });
      sampleStore.byMonitor.set(monitorId, [{ observedAt: referenceTime, price: '100' }]);
      return {
        monitorId,
        integrationId: 'int_binance',
        marketType: 'spot',
        providerSymbol: symbolAt(index),
        maxStaleSeconds: 90,
        windowSeconds: [300],
        spotRestUrl: 'https://spot.example',
        futuresRestUrl: 'https://futures.example',
      };
    });
    const latest = new LatestMetricStore();
    const pipeline = new MetricPipeline(monitorStore, latest);
    const errors: Error[] = [];
    const service = new MarketMetricService(sampleStore, pipeline, {
      now: () => current,
      autoStart: false,
      onError: (error) => errors.push(error),
    });
    service.reconcile(runtimes);
    const startedAt = performance.now();
    for (let index = 0; index < 100; index += 1) {
      await service.ingestPrice({
        monitorId: `mon_${index}`,
        source: 'binance',
        target: symbolAt(index),
        name: 'price',
        value: '110',
        observedAt: current.toISOString(),
        receivedAt: current.toISOString(),
        status: 'ok',
      });
    }
    await service.runCycle(current);
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(sampleStore.savedSamples).toBe(100);
    expect(errors).toEqual([]);
    expect(monitorStore.states.size).toBe(100);
    expect(latest.list('mon_99')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'price', value: '110' }),
      expect.objectContaining({ name: 'data_age_seconds', value: '0', status: 'ok' }),
      expect.objectContaining({ name: 'price_change_percent', value: '10', status: 'ok' }),
    ]));
    expect(elapsedMilliseconds).toBeLessThan(5_000);
    await service.close();
    await pipeline.close();
  }, 10_000);
});
