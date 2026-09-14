import type { Metric } from './metric.js';

export interface MetricSnapshotReader {
  list(monitorId: string): Metric[];
}

function metricKey(metric: Metric): string {
  const labels = Object.entries(metric.labels ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([metric.source, metric.target, metric.name, labels]);
}

function cloneMetric(metric: Metric): Metric {
  return {
    ...metric,
    ...(metric.labels === undefined ? {} : { labels: { ...metric.labels } }),
  };
}

export class LatestMetricStore implements MetricSnapshotReader {
  private readonly metricsByMonitor = new Map<string, Map<string, Metric>>();

  public put(metric: Metric): boolean {
    const metrics = this.metricsByMonitor.get(metric.monitorId) ?? new Map<string, Metric>();
    const key = metricKey(metric);
    const current = metrics.get(key);
    if (current !== undefined && Date.parse(metric.observedAt) <= Date.parse(current.observedAt)) return false;

    metrics.set(key, cloneMetric(metric));
    this.metricsByMonitor.set(metric.monitorId, metrics);
    return true;
  }

  public list(monitorId: string): Metric[] {
    return [...(this.metricsByMonitor.get(monitorId)?.values() ?? [])]
      .sort((left, right) => left.name.localeCompare(right.name) || left.target.localeCompare(right.target))
      .map(cloneMetric);
  }

  public removeMonitor(monitorId: string): void {
    this.metricsByMonitor.delete(monitorId);
  }

  public clear(): void {
    this.metricsByMonitor.clear();
  }
}
