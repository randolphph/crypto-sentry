import { Decimal } from 'decimal.js';

import { BinanceRestClient } from '../../adapters/markets/binance/binance-rest-client.js';
import type { MarketType } from '../../adapters/markets/market.js';
import type { MetricPipeline } from './metric-pipeline.js';
import type { Metric } from './metric.js';

export const MARKET_SAMPLE_INTERVAL_MILLISECONDS = 5_000;
export const MARKET_SAMPLE_RETENTION_MILLISECONDS = 30 * 60 * 1_000;
export const DEFAULT_PRICE_CHANGE_WINDOW_SECONDS = 5 * 60;

export interface PriceSample {
  observedAt: string;
  price: string;
}

export interface PriceSampleStore {
  loadSince(monitorId: string, cutoff: string): PriceSample[];
  saveAndPrune(monitorId: string, samples: PriceSample[], cutoff: string): void;
  clear(monitorId: string): void;
  loadMetricSince?(monitorId: string, metricName: string, cutoff: string): Array<{ observedAt: string; value: string }>;
  saveMetricAndPrune?(
    monitorId: string,
    metricName: string,
    samples: Array<{ observedAt: string; value: string }>,
    cutoff: string,
  ): void;
}

export interface MarketMetricRuntime {
  monitorId: string;
  integrationId: string;
  marketType: MarketType;
  providerSymbol: string;
  canonicalSymbol?: string | undefined;
  priceType?: 'last' | 'mark' | undefined;
  baseAsset?: string | undefined;
  quoteAsset?: string | undefined;
  intervalSeconds?: number;
  maxStaleSeconds: number;
  windowSeconds?: number[];
  priceWindowSeconds?: number[];
  openInterestWindowSeconds?: number[];
  spotRestUrl: string;
  futuresRestUrl: string;
}

export interface MarketMetricServiceOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  sampleIntervalMilliseconds?: number;
  autoStart?: boolean;
  onError(error: Error): void;
}

type NormalizedMarketMetricRuntime = MarketMetricRuntime & {
  intervalSeconds: number;
  priceWindowSeconds: number[];
  openInterestWindowSeconds: number[];
};

interface MonitorState {
  config: NormalizedMarketMetricRuntime;
  identity: string;
  generation: number;
  samples: PriceSample[];
  openInterestSamples: Array<{ observedAt: string; value: string }>;
  latestPrice?: Metric | undefined;
  latestOpenInterest?: Metric | undefined;
  nextOpenInterestAt: number;
  warmup?: Promise<void> | undefined;
  warmupFailures: number;
  nextWarmupAt: number;
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function targetFor(config: MarketMetricRuntime): string {
  return config.canonicalSymbol ?? config.providerSymbol;
}

function labelsFor(config: MarketMetricRuntime): Record<string, string> {
  return {
    marketType: config.marketType,
    priceType: config.priceType ?? (config.marketType === 'spot' ? 'last' : 'mark'),
    providerSymbol: config.providerSymbol,
    canonicalSymbol: config.canonicalSymbol ?? config.providerSymbol,
  };
}

function uniqueWindows(windows: number[]): number[] {
  return [...new Set([DEFAULT_PRICE_CHANGE_WINDOW_SECONDS, ...windows])]
    .filter((window) => Number.isInteger(window) && window > 0)
    .sort((left, right) => left - right);
}

function mergeSamples(current: PriceSample[], incoming: PriceSample[], cutoffMilliseconds: number): PriceSample[] {
  const byTimestamp = new Map<string, PriceSample>();
  for (const sample of [...current, ...incoming]) {
    if (Date.parse(sample.observedAt) >= cutoffMilliseconds) byTimestamp.set(sample.observedAt, sample);
  }
  return [...byTimestamp.values()].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
}

function findReference(samples: PriceSample[], targetMilliseconds: number): PriceSample | undefined {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    if (sample !== undefined && Date.parse(sample.observedAt) <= targetMilliseconds) return sample;
  }
  return undefined;
}

export class MarketMetricService {
  private readonly states = new Map<string, MonitorState>();
  private readonly now: () => Date;
  private readonly sampleIntervalMilliseconds: number;
  private readonly autoStart: boolean;
  private readonly timer?: NodeJS.Timeout | undefined;
  private cycleQueue: Promise<void> = Promise.resolve();
  private closed = false;

  public constructor(
    private readonly samples: PriceSampleStore,
    private readonly metricPipeline: MetricPipeline,
    private readonly options: MarketMetricServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.sampleIntervalMilliseconds = options.sampleIntervalMilliseconds ?? MARKET_SAMPLE_INTERVAL_MILLISECONDS;
    this.autoStart = options.autoStart !== false;
    if (this.autoStart) {
      this.timer = setInterval(() => this.enqueueCycle(), this.sampleIntervalMilliseconds);
      this.timer.unref();
    }
  }

  public reconcile(configurations: MarketMetricRuntime[]): void {
    if (this.closed) return;
    const activeIds = new Set(configurations.map((configuration) => configuration.monitorId));
    for (const [monitorId] of this.states) {
      if (!activeIds.has(monitorId)) {
        this.states.delete(monitorId);
        this.samples.clear(monitorId);
      }
    }

    const timestamp = this.now().getTime();
    const cutoff = new Date(timestamp - MARKET_SAMPLE_RETENTION_MILLISECONDS).toISOString();
    for (const configuration of configurations) {
      const config = {
        ...configuration,
        intervalSeconds: configuration.intervalSeconds ?? 20,
        priceWindowSeconds: uniqueWindows(configuration.priceWindowSeconds ?? configuration.windowSeconds ?? []),
        openInterestWindowSeconds: uniqueWindows(configuration.openInterestWindowSeconds ?? []),
      };
      const identity = [config.integrationId, config.marketType, config.providerSymbol, targetFor(config), config.priceType].join(':');
      const existing = this.states.get(config.monitorId);
      if (existing !== undefined && existing.identity === identity) {
        existing.config = config;
        this.ensureWarmup(existing, timestamp);
        continue;
      }
      if (existing !== undefined) this.samples.clear(config.monitorId);
      const state: MonitorState = {
        config,
        identity,
        generation: (existing?.generation ?? 0) + 1,
        samples: this.samples.loadSince(config.monitorId, cutoff),
        openInterestSamples: this.samples.loadMetricSince?.(config.monitorId, 'open_interest', cutoff) ?? [],
        nextOpenInterestAt: 0,
        warmupFailures: 0,
        nextWarmupAt: 0,
      };
      this.states.set(config.monitorId, state);
      this.ensureWarmup(state, timestamp);
    }
    if (this.autoStart) this.enqueueCycle();
  }

  public async ingestPrice(metric: Metric): Promise<void> {
    await this.ingestMetric(metric);
  }

  public async ingestMetric(metric: Metric): Promise<void> {
    const state = this.states.get(metric.monitorId);
    if (state !== undefined && metric.name === 'price' && metric.status === 'ok') {
      const currentObservedAt = state.latestPrice === undefined ? Number.NEGATIVE_INFINITY : Date.parse(state.latestPrice.observedAt);
      if (Date.parse(metric.observedAt) > currentObservedAt) state.latestPrice = metric;
    }
    await this.metricPipeline.ingest(metric);
    if (state !== undefined) await this.emitDataAge(state, this.now());
  }

  public async runCycle(at: Date = this.now()): Promise<void> {
    if (this.closed) return;
    for (const state of this.states.values()) {
      await this.processMonitor(state, at);
    }
    await this.pollOpenInterest(at);
  }

  public async waitForWarmups(): Promise<void> {
    await Promise.all([...this.states.values()].flatMap((state) => state.warmup === undefined ? [] : [state.warmup]));
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.states.clear();
    await this.cycleQueue;
  }

  private enqueueCycle(): void {
    this.cycleQueue = this.cycleQueue
      .then(async () => this.runCycle())
      .catch((error: unknown) => this.options.onError(errorValue(error)));
  }

  private ensureWarmup(state: MonitorState, timestamp: number): void {
    if (state.warmup !== undefined || timestamp < state.nextWarmupAt || this.hasAllReferences(state, timestamp)) return;
    const generation = state.generation;
    const client = new BinanceRestClient({
      spotRestUrl: state.config.spotRestUrl,
      futuresRestUrl: state.config.futuresRestUrl,
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
    });
    const warmup = client.loadPriceSamples({
      marketType: state.config.marketType,
      providerSymbol: state.config.providerSymbol,
      startTime: timestamp - MARKET_SAMPLE_RETENTION_MILLISECONDS,
      endTime: timestamp,
    }).then((loaded) => {
      const current = this.states.get(state.config.monitorId);
      if (current !== state || current.generation !== generation || this.closed) return;
      const cutoffMilliseconds = timestamp - MARKET_SAMPLE_RETENTION_MILLISECONDS;
      current.samples = mergeSamples(current.samples, loaded, cutoffMilliseconds);
      this.samples.saveAndPrune(current.config.monitorId, loaded, new Date(cutoffMilliseconds).toISOString());
      if (this.hasAllReferences(current, this.now().getTime())) {
        current.warmupFailures = 0;
        current.nextWarmupAt = 0;
      } else {
        this.deferWarmup(current);
      }
    }).catch((error: unknown) => {
      if (this.states.get(state.config.monitorId) === state && !this.closed) {
        this.deferWarmup(state);
        this.options.onError(new Error(`Market warmup failed for ${state.config.monitorId}: ${errorValue(error).message}`));
      }
    }).finally(() => {
      if (this.states.get(state.config.monitorId) === state) state.warmup = undefined;
    });
    state.warmup = warmup;
  }

  private deferWarmup(state: MonitorState): void {
    state.warmupFailures += 1;
    const delay = Math.min(60_000 * 2 ** (state.warmupFailures - 1), 15 * 60_000);
    state.nextWarmupAt = this.now().getTime() + delay;
  }

  private hasAllReferences(state: MonitorState, timestamp: number): boolean {
    return state.config.priceWindowSeconds.every((window) =>
      findReference(state.samples, timestamp - window * 1_000) !== undefined);
  }

  private async processMonitor(state: MonitorState, at: Date): Promise<void> {
    const timestamp = at.getTime();
    const cutoffMilliseconds = timestamp - MARKET_SAMPLE_RETENTION_MILLISECONDS;
    const latest = state.latestPrice;
    if (latest !== undefined && timestamp - Date.parse(latest.observedAt) <= state.config.maxStaleSeconds * 1_000) {
      const sample = { observedAt: at.toISOString(), price: String(latest.value) };
      state.samples = mergeSamples(state.samples, [sample], cutoffMilliseconds);
      this.samples.saveAndPrune(state.config.monitorId, [sample], new Date(cutoffMilliseconds).toISOString());
    } else {
      state.samples = mergeSamples(state.samples, [], cutoffMilliseconds);
      this.samples.saveAndPrune(state.config.monitorId, [], new Date(cutoffMilliseconds).toISOString());
    }

    await this.emitDataAge(state, at);
    for (const windowSeconds of state.config.priceWindowSeconds) {
      await this.emitPriceChange(state, at, windowSeconds);
    }
    this.ensureWarmup(state, timestamp);
  }

  private async pollOpenInterest(at: Date): Promise<void> {
    const due = [...this.states.values()].filter((state) => (
      state.config.marketType === 'perpetual' && at.getTime() >= state.nextOpenInterestAt
    ));
    const groups = new Map<string, MonitorState[]>();
    for (const state of due) {
      const key = `${state.config.integrationId}:${state.config.providerSymbol.toUpperCase()}`;
      const current = groups.get(key) ?? [];
      current.push(state);
      groups.set(key, current);
    }
    await Promise.all([...groups.values()].map(async (states) => {
      const first = states[0];
      if (first === undefined) return;
      for (const state of states) {
        state.nextOpenInterestAt = at.getTime() + state.config.intervalSeconds * 1_000;
      }
      const client = new BinanceRestClient({
        spotRestUrl: first.config.spotRestUrl,
        futuresRestUrl: first.config.futuresRestUrl,
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      });
      try {
        const result = await client.loadOpenInterest(first.config.providerSymbol);
        for (const state of states) await this.acceptOpenInterest(state, result.openInterest, result.observedAt, at);
      } catch (error) {
        this.options.onError(new Error(`Open interest polling failed for ${first.config.providerSymbol}: ${errorValue(error).message}`));
        for (const state of states) {
          await this.metricPipeline.ingest({
            monitorId: state.config.monitorId,
            source: 'binance',
            target: targetFor(state.config),
            name: 'open_interest',
            value: state.latestOpenInterest === undefined ? 'unavailable' : String(state.latestOpenInterest.value),
            unit: 'contracts',
            observedAt: at.toISOString(),
            receivedAt: this.now().toISOString(),
            status: 'error',
            labels: labelsFor(state.config),
          });
        }
      }
    }));
  }

  private async acceptOpenInterest(state: MonitorState, value: string, observedAt: string, at: Date): Promise<void> {
    const metric: Metric = {
      monitorId: state.config.monitorId,
      source: 'binance',
      target: targetFor(state.config),
      name: 'open_interest',
      value,
      unit: 'contracts',
      observedAt,
      receivedAt: this.now().toISOString(),
      status: 'ok',
      labels: labelsFor(state.config),
    };
    state.latestOpenInterest = metric;
    const cutoffMilliseconds = at.getTime() - MARKET_SAMPLE_RETENTION_MILLISECONDS;
    const sample = { observedAt, value };
    const byTimestamp = new Map(state.openInterestSamples.map((item) => [item.observedAt, item]));
    byTimestamp.set(observedAt, sample);
    state.openInterestSamples = [...byTimestamp.values()]
      .filter((item) => Date.parse(item.observedAt) >= cutoffMilliseconds)
      .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
    this.samples.saveMetricAndPrune?.(
      state.config.monitorId,
      'open_interest',
      [sample],
      new Date(cutoffMilliseconds).toISOString(),
    );
    await this.metricPipeline.ingest(metric);
    for (const windowSeconds of state.config.openInterestWindowSeconds) {
      const reference = [...state.openInterestSamples].reverse()
        .find((item) => Date.parse(item.observedAt) <= at.getTime() - windowSeconds * 1_000);
      const common = {
        monitorId: state.config.monitorId,
        source: 'binance',
        target: targetFor(state.config),
        name: 'open_interest_change_percent',
        unit: 'percent',
        observedAt: at.toISOString(),
        receivedAt: this.now().toISOString(),
        labels: { ...labelsFor(state.config), windowSeconds: String(windowSeconds) },
      } as const;
      if (reference === undefined || new Decimal(reference.value).isZero()) {
        await this.metricPipeline.ingest({ ...common, value: 'unavailable', status: 'warming_up' });
        continue;
      }
      const change = new Decimal(value).div(reference.value).minus(1).times(100).toSignificantDigits(18).toString();
      await this.metricPipeline.ingest({ ...common, value: change, status: 'ok' });
    }
  }

  private async emitDataAge(state: MonitorState, at: Date): Promise<void> {
    const latest = state.latestPrice;
    const ageSeconds = latest === undefined
      ? 0
      : Math.max(0, new Decimal(at.getTime()).minus(Date.parse(latest.observedAt)).dividedBy(1_000).toNumber());
    await this.metricPipeline.ingest({
      monitorId: state.config.monitorId,
      source: 'binance',
      target: targetFor(state.config),
      name: 'data_age_seconds',
      value: new Decimal(ageSeconds).toDecimalPlaces(3).toString(),
      unit: 'seconds',
      observedAt: at.toISOString(),
      receivedAt: this.now().toISOString(),
      status: latest === undefined ? 'warming_up' : ageSeconds > state.config.maxStaleSeconds ? 'stale' : 'ok',
      labels: labelsFor(state.config),
    });
  }

  private async emitPriceChange(state: MonitorState, at: Date, windowSeconds: number): Promise<void> {
    const latest = state.latestPrice;
    const reference = findReference(state.samples, at.getTime() - windowSeconds * 1_000);
    const latestIsStale = latest !== undefined &&
      at.getTime() - Date.parse(latest.observedAt) > state.config.maxStaleSeconds * 1_000;
    const common = {
      monitorId: state.config.monitorId,
      source: 'binance',
      target: targetFor(state.config),
      name: 'price_change_percent',
      unit: 'percent',
      observedAt: at.toISOString(),
      receivedAt: this.now().toISOString(),
      labels: { ...labelsFor(state.config), windowSeconds: String(windowSeconds) },
    } as const;
    if (latest === undefined || reference === undefined) {
      await this.metricPipeline.ingest({ ...common, value: 'unavailable', status: latestIsStale ? 'stale' : 'warming_up' });
      return;
    }
    const change = new Decimal(String(latest.value)).dividedBy(reference.price).minus(1).times(100);
    await this.metricPipeline.ingest({
      ...common,
      value: change.toSignificantDigits(18).toString(),
      status: latestIsStale ? 'stale' : 'ok',
    });
  }
}
