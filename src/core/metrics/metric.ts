export type MetricStatus = 'ok' | 'stale' | 'error' | 'unsupported' | 'warming_up';

export interface Metric {
  monitorId: string;
  source: string;
  target: string;
  name: string;
  value: string | boolean;
  unit?: string;
  observedAt: string;
  receivedAt: string;
  status: MetricStatus;
  labels?: Record<string, string>;
}

export interface AdapterContext<TConfig> {
  monitorId: string;
  config: TConfig;
  emitMetric(metric: Metric): Promise<void>;
  signal: AbortSignal;
}

export interface MonitorAdapter<TConfig> {
  readonly type: string;
  validateConfig(config: unknown): Promise<TConfig>;
  test(config: TConfig): Promise<{ ok: boolean; message: string }>;
  start(context: AdapterContext<TConfig>): Promise<void>;
  update(context: AdapterContext<TConfig>): Promise<void>;
  stop(monitorId: string): Promise<void>;
}
