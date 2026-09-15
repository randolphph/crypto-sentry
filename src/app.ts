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
import { createNodeMarketWebSocket } from './adapters/markets/websocket/websocket-port.js';
import type { MarketWebSocketFactory } from './adapters/markets/websocket/websocket-port.js';
import { loadConfig } from './config.js';
import type { AppConfig } from './config.js';
import { ConfigEventBus } from './core/config-events/config-event-bus.js';
import { BinanceMarketDataCoordinator } from './core/integrations/binance-market-data-coordinator.js';
import { AaveV3PositionCoordinator } from './core/integrations/aave-v3-position-coordinator.js';
import type { AaveV3PositionReaderFactory } from './core/integrations/aave-v3-position-coordinator.js';
import { IntegrationOperationsService } from './core/integrations/integration-operations-service.js';
import { UniswapV3PositionCoordinator } from './core/integrations/uniswap-v3-position-coordinator.js';
import type {
  UniswapV3PositionReaderFactory,
  UniswapV4OwnershipIndexerFactory,
  UniswapV4PositionReaderFactory,
} from './core/integrations/uniswap-v3-position-coordinator.js';
import { LatestMetricStore } from './core/metrics/latest-metric-store.js';
import { MarketMetricService } from './core/metrics/market-metric-service.js';
import { MetricPipeline } from './core/metrics/metric-pipeline.js';
import { RuleExecutionService } from './core/rules/rule-execution-service.js';
import { PollingScheduler } from './core/scheduling/polling-scheduler.js';
import { StatusService } from './core/status/status-service.js';
import { createDatabase } from './db/client.js';
import { AlertRepository } from './db/repositories/alert-repository.js';
import { IntegrationRepository } from './db/repositories/integration-repository.js';
import { MarketRepository } from './db/repositories/market-repository.js';
import { MonitorRepository } from './db/repositories/monitor-repository.js';
import { PriceSampleRepository } from './db/repositories/price-sample-repository.js';
import { RuleRepository } from './db/repositories/rule-repository.js';
import { RuleExecutionRepository } from './db/repositories/rule-execution-repository.js';
import { UniswapV4OwnershipRepository } from './db/repositories/uniswap-v4-ownership-repository.js';
import { EncryptionService } from './security/encryption/encryption-service.js';

export interface CreateAppOptions {
  config?: AppConfig;
  logger?: boolean;
  fetch?: typeof globalThis.fetch;
  webSocketFactory?: MarketWebSocketFactory | false;
  marketSampleIntervalMilliseconds?: number;
  aavePositionReaderFactory?: AaveV3PositionReaderFactory;
  uniswapV3PositionReaderFactory?: UniswapV3PositionReaderFactory;
  uniswapV4PositionReaderFactory?: UniswapV4PositionReaderFactory;
  uniswapV4OwnershipIndexerFactory?: UniswapV4OwnershipIndexerFactory;
  pollingMinimumIntervalMilliseconds?: number;
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
  const markets = new MarketRepository(database.db);
  const webSocketFactory = options.webSocketFactory === false
    ? createNodeMarketWebSocket
    : options.webSocketFactory ?? createNodeMarketWebSocket;
  const integrationOperations = new IntegrationOperationsService(integrations, markets, options.fetch, webSocketFactory);
  const monitors = new MonitorRepository(database.db);
  const uniswapV4Ownership = new UniswapV4OwnershipRepository(database.db);
  const rules = new RuleRepository(database.db);
  const ruleExecutionStore = new RuleExecutionRepository(database.db);
  const ruleExecution = new RuleExecutionService(ruleExecutionStore);
  const alerts = new AlertRepository(database.db);
  const status = new StatusService(database.db, [ruleExecution]);
  const latestMetrics = new LatestMetricStore();
  const metricPipeline = new MetricPipeline(monitors, latestMetrics, [ruleExecution]);
  app.decorate('metricPipeline', metricPipeline);
  const pollingScheduler = new PollingScheduler({
    onError: (taskId, error) => app.log.warn({ err: error, taskId }, 'Polling task failed'),
    ...(options.pollingMinimumIntervalMilliseconds === undefined
      ? {}
      : { minimumIntervalMilliseconds: options.pollingMinimumIntervalMilliseconds }),
  });
  const aavePositionCoordinator = new AaveV3PositionCoordinator(
    integrations,
    monitors,
    metricPipeline,
    pollingScheduler,
    {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.aavePositionReaderFactory === undefined ? {} : { readerFactory: options.aavePositionReaderFactory }),
      onError: (error) => app.log.warn({ err: error }, 'Aave V3 position scan error'),
    },
  );
  const uniswapV3PositionCoordinator = new UniswapV3PositionCoordinator(
    integrations,
    monitors,
    uniswapV4Ownership,
    metricPipeline,
    pollingScheduler,
    {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.uniswapV3PositionReaderFactory === undefined
        ? {}
        : { readerFactory: options.uniswapV3PositionReaderFactory }),
      ...(options.uniswapV4PositionReaderFactory === undefined
        ? {}
        : { v4ReaderFactory: options.uniswapV4PositionReaderFactory }),
      ...(options.uniswapV4OwnershipIndexerFactory === undefined
        ? {}
        : { v4OwnershipIndexerFactory: options.uniswapV4OwnershipIndexerFactory }),
      onError: (error) => app.log.warn({ err: error }, 'Uniswap position scan error'),
    },
  );
  const marketMetricService = options.webSocketFactory === false ? undefined : new MarketMetricService(
    new PriceSampleRepository(database.db),
    metricPipeline,
    {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.marketSampleIntervalMilliseconds === undefined
        ? {}
        : { sampleIntervalMilliseconds: options.marketSampleIntervalMilliseconds }),
      onError: (error) => app.log.warn({ err: error }, 'Market metric processing error'),
    },
  );
  const marketDataCoordinator = marketMetricService === undefined
    ? undefined
    : new BinanceMarketDataCoordinator(
      integrations,
      monitors,
      marketMetricService,
      webSocketFactory,
      (error) => app.log.warn({ err: error }, 'Binance market data stream error'),
    );

  const unsubscribeConfigEvents = events.subscribe((event) => {
    if (event.entity === 'monitor') {
      if (event.operation === 'deleted') metricPipeline.forgetMonitor(event.id);
      if (event.operation === 'updated' && monitors.findRuntimeMonitor(event.id)?.enabled === false) {
        metricPipeline.forgetMonitor(event.id);
      }
    }
    if (event.entity === 'monitor' || event.entity === 'integration' || event.entity === 'rule') {
      marketDataCoordinator?.reconcile();
    }
    if (event.entity === 'monitor' || event.entity === 'integration') {
      aavePositionCoordinator.reconcile();
      uniswapV3PositionCoordinator.reconcile();
    }
  });
  marketDataCoordinator?.reconcile();
  aavePositionCoordinator.reconcile();
  uniswapV3PositionCoordinator.reconcile();

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

  registerIntegrationRoutes(app, integrations, integrationOperations, events);
  registerMonitorRoutes(app, monitors, events, latestMetrics, rules);
  registerRuleRoutes(app, rules, events);
  registerAlertRoutes(app, alerts);
  registerStatusRoutes(app, status);

  const heartbeat = setInterval(() => status.heartbeat(), 5_000);
  heartbeat.unref();
  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    unsubscribeConfigEvents();
    marketDataCoordinator?.close();
    aavePositionCoordinator.close();
    uniswapV3PositionCoordinator.close();
    await pollingScheduler.close();
    await marketMetricService?.close();
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
