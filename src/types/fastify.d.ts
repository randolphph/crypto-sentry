import type { MetricPipeline } from '../core/metrics/metric-pipeline.js';

declare module 'fastify' {
  interface FastifyInstance {
    metricPipeline: MetricPipeline;
  }
}
