import { isActionableMetric, parseMetric } from './metric.js';
import type { Metric, MetricStatus } from './metric.js';
import type { LatestMetricStore } from './latest-metric-store.js';

export interface RuntimeMonitor {
  id: string;
  enabled: boolean;
}

export interface MonitorRuntimeState {
  status: Exclude<MetricStatus, 'unsupported'>;
  lastDataAt?: string | undefined;
  lastError: string | null;
}

export interface MonitorRuntimeStateStore {
  findRuntimeMonitor(id: string): RuntimeMonitor | undefined;
  updateRuntimeState(id: string, state: MonitorRuntimeState): void;
}

export interface MetricConsumer {
  consumeUnknownMetrics?: boolean;
  consume(metric: Metric): Promise<void>;
}

export interface MetricIngestionResult {
  accepted: boolean;
  reason?: 'monitor_not_found' | 'monitor_disabled' | 'out_of_order';
  forwardedToConsumers: boolean;
  consumerErrors: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function latestSuccessfulObservation(metrics: Metric[]): string | undefined {
  return metrics
    .filter((metric) => metric.status === 'ok')
    .reduce<Metric | undefined>((latest, metric) => {
      return latest === undefined || Date.parse(metric.observedAt) > Date.parse(latest.observedAt) ? metric : latest;
    }, undefined)
    ?.observedAt;
}

function aggregateMonitorState(metrics: Metric[]): MonitorRuntimeState {
  const evaluatedMetrics = metrics.filter((metric) => metric.status !== 'unsupported');
  const failed = evaluatedMetrics.find((metric) => metric.status === 'error');
  const status: MonitorRuntimeState['status'] =
    failed !== undefined ? 'error' :
    evaluatedMetrics.some((metric) => metric.status === 'stale') ? 'stale' :
    evaluatedMetrics.length === 0 || evaluatedMetrics.some((metric) => metric.status === 'warming_up') ? 'warming_up' :
    'ok';
  const lastDataAt = latestSuccessfulObservation(evaluatedMetrics);

  return {
    status,
    ...(lastDataAt === undefined ? {} : { lastDataAt }),
    lastError: failed === undefined ? null : `${failed.name} metric reported an error`,
  };
}

export class MetricPipeline {
  private readonly queues = new Map<string, Promise<void>>();

  public constructor(
    private readonly monitorStates: MonitorRuntimeStateStore,
    private readonly latestMetrics: LatestMetricStore,
    private readonly consumers: MetricConsumer[] = [],
  ) {}

  public async ingest(input: unknown): Promise<MetricIngestionResult> {
    const metric = parseMetric(input);
    const previous = this.queues.get(metric.monitorId) ?? Promise.resolve();
    const task = previous.then(
      async () => this.process(metric),
      async () => this.process(metric),
    );
    const queue = task.then(() => undefined, () => undefined);
    this.queues.set(metric.monitorId, queue);
    void queue.then(() => {
      if (this.queues.get(metric.monitorId) === queue) this.queues.delete(metric.monitorId);
    });
    return task;
  }

  public list(monitorId: string): Metric[] {
    return this.latestMetrics.list(monitorId);
  }

  public forgetMonitor(monitorId: string): void {
    this.latestMetrics.removeMonitor(monitorId);
  }

  public async close(): Promise<void> {
    await Promise.all(this.queues.values());
    this.latestMetrics.clear();
  }

  private async process(metric: Metric): Promise<MetricIngestionResult> {
    const monitor = this.monitorStates.findRuntimeMonitor(metric.monitorId);
    if (monitor === undefined) {
      return { accepted: false, reason: 'monitor_not_found', forwardedToConsumers: false, consumerErrors: [] };
    }
    if (!monitor.enabled) {
      return { accepted: false, reason: 'monitor_disabled', forwardedToConsumers: false, consumerErrors: [] };
    }
    if (!this.latestMetrics.put(metric)) {
      return { accepted: false, reason: 'out_of_order', forwardedToConsumers: false, consumerErrors: [] };
    }

    this.monitorStates.updateRuntimeState(metric.monitorId, aggregateMonitorState(this.latestMetrics.list(metric.monitorId)));
    const consumers = isActionableMetric(metric)
      ? this.consumers
      : this.consumers.filter((consumer) => consumer.consumeUnknownMetrics === true);
    const consumerResults = await Promise.allSettled(consumers.map(async (consumer) => consumer.consume(metric)));
    const consumerErrors = consumerResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => errorMessage(result.reason));
    return { accepted: true, forwardedToConsumers: consumers.length > 0, consumerErrors };
  }
}
