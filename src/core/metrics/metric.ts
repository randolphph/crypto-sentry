import { z } from 'zod';

export const metricStatusSchema = z.enum(['ok', 'stale', 'error', 'unsupported', 'warming_up']);
export type MetricStatus = z.infer<typeof metricStatusSchema>;

export const metricSchema = z.object({
  monitorId: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  name: z.string().min(1),
  value: z.union([z.string().min(1), z.boolean()]),
  unit: z.string().min(1).optional(),
  observedAt: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
  status: metricStatusSchema,
  labels: z.record(z.string(), z.string()).optional(),
});

export type Metric = z.infer<typeof metricSchema>;

export function parseMetric(input: unknown): Metric {
  return metricSchema.parse(input);
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
