import { describe, expect, it, vi } from 'vitest';

import { LatestMetricStore } from '../src/core/metrics/latest-metric-store.js';
import { MarketMetricService } from '../src/core/metrics/market-metric-service.js';
import type { MarketMetricRuntime, PriceSample, PriceSampleStore } from '../src/core/metrics/market-metric-service.js';
import { MetricPipeline } from '../src/core/metrics/metric-pipeline.js';
import type { MonitorRuntimeState, RuntimeMonitor } from '../src/core/metrics/metric-pipeline.js';
import type { Metric } from '../src/core/metrics/metric.js';

class FakePriceSampleStore implements PriceSampleStore {
  public readonly byMonitor = new Map<string, PriceSample[]>();

  public loadSince(monitorId: string, cutoff: string): PriceSample[] {
    return (this.byMonitor.get(monitorId) ?? []).filter((sample) => Date.parse(sample.observedAt) >= Date.parse(cutoff));
  }

  public saveAndPrune(monitorId: string, samples: PriceSample[], cutoff: string): void {
    const merged = new Map((this.byMonitor.get(monitorId) ?? []).map((sample) => [sample.observedAt, sample]));
    for (const sample of samples) merged.set(sample.observedAt, sample);
    this.byMonitor.set(monitorId, [...merged.values()]
      .filter((sample) => Date.parse(sample.observedAt) >= Date.parse(cutoff))
      .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt)));
  }

  public clear(monitorId: string): void {
    this.byMonitor.delete(monitorId);
  }
}

class FakeMonitorStore {
  public readonly monitors = new Map<string, RuntimeMonitor>([['mon_btc', { id: 'mon_btc', enabled: true }]]);
  public readonly states = new Map<string, MonitorRuntimeState>();

  public findRuntimeMonitor(id: string): RuntimeMonitor | undefined {
    return this.monitors.get(id);
  }

  public updateRuntimeState(id: string, state: MonitorRuntimeState): void {
    this.states.set(id, state);
  }
}

const runtime: MarketMetricRuntime = {
  monitorId: 'mon_btc',
  integrationId: 'int_binance',
  marketType: 'spot',
  providerSymbol: 'BTCUSDT',
  canonicalSymbol: 'BTC/USD',
  priceType: 'last',
  maxStaleSeconds: 90,
  windowSeconds: [300],
  spotRestUrl: 'https://spot.example',
  futuresRestUrl: 'https://futures.example',
};

function price(value: string, observedAt: string): Metric {
  return {
    monitorId: 'mon_btc',
    source: 'binance',
    target: 'BTC/USD',
    name: 'price',
    value,
    observedAt,
    receivedAt: observedAt,
    status: 'ok',
    labels: { marketType: 'spot', priceType: 'last', providerSymbol: 'BTCUSDT' },
  };
}

function setup(sampleStore: FakePriceSampleStore, now: () => Date, fetch?: typeof globalThis.fetch) {
  const monitorStore = new FakeMonitorStore();
  const latest = new LatestMetricStore();
  const pipeline = new MetricPipeline(monitorStore, latest);
  const errors: Error[] = [];
  const service = new MarketMetricService(sampleStore, pipeline, {
    now,
    autoStart: false,
    ...(fetch === undefined ? {} : { fetch }),
    onError: (error) => errors.push(error),
  });
  return { errors, latest, monitorStore, pipeline, service };
}

describe('MarketMetricService', () => {
  it('restores a window, samples every cycle, calculates change, and marks stale data', async () => {
    let current = new Date('2026-09-14T12:05:00.000Z');
    const samples = new FakePriceSampleStore();
    samples.byMonitor.set('mon_btc', [
      { observedAt: '2026-09-14T11:59:55.000Z', price: '90' },
      { observedAt: '2026-09-14T12:00:00.000Z', price: '100' },
      { observedAt: '2026-09-14T12:00:05.000Z', price: '200' },
    ]);
    const { latest, monitorStore, service } = setup(samples, () => current);
    service.reconcile([runtime]);

    await service.ingestPrice(price('110', current.toISOString()));
    await service.runCycle(current);

    expect(samples.byMonitor.get('mon_btc')).toContainEqual({ observedAt: current.toISOString(), price: '110' });
    expect(latest.list('mon_btc')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'price', value: '110', status: 'ok' }),
      expect.objectContaining({ name: 'data_age_seconds', value: '0', status: 'ok' }),
      expect.objectContaining({ name: 'price_change_percent', value: '10', status: 'ok' }),
    ]));
    expect(latest.list('mon_btc').find((metric) => metric.name === 'price_change_percent')?.labels?.windowSeconds).toBe('300');

    current = new Date('2026-09-14T12:06:31.000Z');
    await service.runCycle(current);
    expect(latest.list('mon_btc')).toContainEqual(expect.objectContaining({
      name: 'data_age_seconds', value: '91', status: 'stale',
    }));
    expect(latest.list('mon_btc')).toContainEqual(expect.objectContaining({
      name: 'price_change_percent', status: 'stale',
    }));
    expect(monitorStore.states.get('mon_btc')?.status).toBe('stale');
    expect(samples.byMonitor.get('mon_btc')).not.toContainEqual({ observedAt: current.toISOString(), price: '110' });
    await service.close();
  });

  it('uses spot klines to warm an empty window before emitting an actionable change', async () => {
    const current = new Date('2026-09-14T12:05:00.000Z');
    const closeTime = Date.parse('2026-09-14T12:00:00.000Z');
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify([
      [closeTime - 59_999, '99', '101', '98', '100', '1', closeTime, '1', 1, '1', '1', '0'],
    ]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const samples = new FakePriceSampleStore();
    const { errors, latest, service } = setup(samples, () => current, fetchMock);
    service.reconcile([runtime]);
    await service.waitForWarmups();
    await service.ingestPrice(price('110', current.toISOString()));
    await service.runCycle(current);

    expect(fetchMock).toHaveBeenCalledOnce();
    const requestInput = fetchMock.mock.calls[0]?.[0];
    expect(requestInput).toBeDefined();
    if (requestInput === undefined) throw new Error('Expected a warmup request');
    const requestUrl = new URL(requestInput instanceof Request ? requestInput.url : requestInput);
    expect(requestUrl.pathname).toBe('/api/v3/klines');
    expect(requestUrl.searchParams.get('symbol')).toBe('BTCUSDT');
    expect(errors).toEqual([]);
    expect(latest.list('mon_btc')).toContainEqual(expect.objectContaining({
      name: 'price_change_percent', value: '10', status: 'ok',
    }));
    await service.close();
  });

  it('keeps price change warming and reports warmup failures without forwarding a false zero', async () => {
    const current = new Date('2026-09-14T12:05:00.000Z');
    const samples = new FakePriceSampleStore();
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response('{}', { status: 503 }));
    const { errors, latest, service } = setup(samples, () => current, fetchMock);
    service.reconcile([runtime]);
    await service.waitForWarmups();
    await service.ingestPrice(price('110', current.toISOString()));
    await service.runCycle(current);

    expect(errors[0]?.message).toContain('Market warmup failed for mon_btc');
    expect(latest.list('mon_btc')).toContainEqual(expect.objectContaining({
      name: 'price_change_percent', value: '0', status: 'warming_up',
    }));
    await service.close();
  });
});
