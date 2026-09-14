import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { pathToFileURL } from 'node:url';

import { registerAlertRoutes } from './api/alerts/routes.js';
import { registerAuthentication } from './api/auth/plugin.js';
import { registerErrorHandler } from './api/errors.js';
import { registerIntegrationRoutes } from './api/integrations/routes.js';
import { registerMonitorRoutes } from './api/monitors/routes.js';
import { registerRuleRoutes } from './api/rules/routes.js';
import { registerStatusRoutes } from './api/status/routes.js';
import { loadConfig } from './config.js';
import type { AppConfig } from './config.js';
import { ConfigEventBus } from './core/config-events/config-event-bus.js';
import { LatestMetricStore } from './core/metrics/latest-metric-store.js';
import { MetricPipeline } from './core/metrics/metric-pipeline.js';
import { StatusService } from './core/status/status-service.js';
import { createDatabase } from './db/client.js';
import { AlertRepository } from './db/repositories/alert-repository.js';
import { IntegrationRepository } from './db/repositories/integration-repository.js';
import { MonitorRepository } from './db/repositories/monitor-repository.js';
import { RuleRepository } from './db/repositories/rule-repository.js';
import { EncryptionService } from './security/encryption/encryption-service.js';

export interface CreateAppOptions {
  config?: AppConfig;
  logger?: boolean;
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const database = createDatabase(config.databasePath);
  const app = Fastify({
    logger: options.logger === false ? false : {
      level: config.logLevel,
      redact: {
        paths: ['req.headers.authorization', 'request.headers.authorization'],
        censor: '[REDACTED]',
      },
    },
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'CryptoSentry API', version: '0.1.0' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearerAuth: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  registerErrorHandler(app);
  registerAuthentication(app, config.apiToken);

  const encryption = new EncryptionService(config.masterEncryptionKey);
  const events = new ConfigEventBus();
  const integrations = new IntegrationRepository(database.db, encryption);
  const monitors = new MonitorRepository(database.db);
  const rules = new RuleRepository(database.db);
  const alerts = new AlertRepository(database.db);
  const status = new StatusService(database.db);
  const latestMetrics = new LatestMetricStore();
  const metricPipeline = new MetricPipeline(monitors, latestMetrics);
  app.decorate('metricPipeline', metricPipeline);

  const unsubscribeConfigEvents = events.subscribe((event) => {
    if (event.entity !== 'monitor') return;
    if (event.operation === 'deleted') {
      metricPipeline.forgetMonitor(event.id);
      return;
    }
    if (event.operation === 'updated' && monitors.findRuntimeMonitor(event.id)?.enabled === false) {
      metricPipeline.forgetMonitor(event.id);
    }
  });

  app.get('/health', { schema: { security: [], tags: ['health'] } }, async () => {
    database.sqlite.prepare('SELECT 1').get();
    const summary = status.summary();
    return {
      status: summary.status === 'unhealthy' ? 'unhealthy' : 'ok',
      database: 'ok',
      engine: summary.status === 'unhealthy' ? 'error' : 'ok',
      serverTime: summary.serverTime,
    };
  });

  registerIntegrationRoutes(app, integrations, events);
  registerMonitorRoutes(app, monitors, events, latestMetrics);
  registerRuleRoutes(app, rules, events);
  registerAlertRoutes(app, alerts);
  registerStatusRoutes(app, status);

  const heartbeat = setInterval(() => status.heartbeat(), 5_000);
  heartbeat.unref();
  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    unsubscribeConfigEvents();
    await metricPipeline.close();
    database.close();
  });

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp({ config });

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, 'Graceful shutdown started');
    await app.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
}

const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
