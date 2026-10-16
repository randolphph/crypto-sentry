import { UsStockQuoteReader } from '../../adapters/markets/us-stock-quotes.js';
import { stockPriceMonitorConfigSchema } from '../../api/schemas.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import type { MetricPipeline } from '../metrics/metric-pipeline.js';
import type { PollingScheduler } from '../scheduling/polling-scheduler.js';

type Monitor = ReturnType<MonitorRepository['get']>;
export class UsStockCoordinator {
  private readonly generations = new Map<string, string>();
  private readonly reader: UsStockQuoteReader;
  public constructor(private readonly monitors: MonitorRepository, private readonly pipeline: MetricPipeline, private readonly scheduler: PollingScheduler,
    private readonly options: { fetch?: typeof globalThis.fetch; now?: () => Date } = {}) {
    this.reader = new UsStockQuoteReader(options.fetch, options.now);
  }
  public reconcile(): void {
    const desired = new Set<string>();
    for (const monitor of this.monitors.list()) {
      if (monitor.type !== 'stock_price' || !monitor.enabled) continue;
      desired.add(monitor.id);
      const generation = JSON.stringify([monitor.config, monitor.intervalSeconds, monitor.maxStaleSeconds]);
      if (this.generations.get(monitor.id) === generation) continue;
      this.scheduler.remove(`stock:${monitor.id}`);
      this.pipeline.forgetMonitor(monitor.id);
      this.generations.set(monitor.id, generation);
      this.scheduler.upsert({ id: `stock:${monitor.id}`, intervalMilliseconds: monitor.intervalSeconds * 1_000, run: (signal) => this.scan(monitor, generation, signal) });
    }
    for (const id of this.generations.keys()) {
      if (!desired.has(id)) { this.scheduler.remove(`stock:${id}`); this.generations.delete(id); }
    }
  }
  public close(): void {
    for (const id of this.generations.keys()) this.scheduler.remove(`stock:${id}`);
    this.generations.clear();
  }
  private async scan(monitor: Monitor, generation: string, signal: AbortSignal): Promise<void> {
    const config = stockPriceMonitorConfigSchema.parse(monitor.config);
    const current = () => !signal.aborted && this.generations.get(monitor.id) === generation;
    try {
      const quote = await this.reader.read({ ...config, maxStaleSeconds: monitor.maxStaleSeconds }, signal);
      if (!current()) return;
      const receivedAt = (this.options.now?.() ?? new Date()).toISOString();
      const age = Math.max(0, (Date.parse(receivedAt) - Date.parse(quote.observedAt)) / 1_000);
      const status = age > monitor.maxStaleSeconds ? 'stale' as const : 'ok' as const;
      const labels = { symbol: quote.symbol, provider: quote.provider, currency: quote.currency, quoteAsset: quote.currency, priceBasis: quote.priceBasis, session: quote.session };
      this.pipeline.forgetMonitor(monitor.id);
      for (const [name, value, unit] of [['price', quote.price, quote.currency], ['data_age_seconds', String(age), 'seconds']]) {
        if (!current()) return;
        await this.pipeline.ingest({ monitorId: monitor.id, source: quote.provider, target: quote.symbol, name, value, unit, observedAt: quote.observedAt, receivedAt, status, labels });
      }
    } catch (error) {
      if (!current()) return;
      const receivedAt = (this.options.now?.() ?? new Date()).toISOString();
      this.pipeline.forgetMonitor(monitor.id);
      await this.pipeline.ingest({ monitorId: monitor.id, source: config.provider, target: config.symbol, name: 'price', value: 'unavailable', observedAt: receivedAt, receivedAt, status: 'error',
        labels: { symbol: config.symbol, provider: config.provider }, context: { error: error instanceof Error ? error.message : '美股行情读取失败' } });
    }
  }
}
