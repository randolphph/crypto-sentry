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
import { AaveV3EventCoordinator } from './core/integrations/aave-v3-event-coordinator.js';
import type { AaveV3EventReaderFactory } from './core/integrations/aave-v3-event-coordinator.js';
import { IntegrationOperationsService } from './core/integrations/integration-operations-service.js';
import type { AaveEventReaderFactory, AaveReserveCatalogReaderFactory } from './core/integrations/integration-operations-service.js';
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
import { IntegrationNetworkHealthRepository } from './db/repositories/integration-network-health-repository.js';
import { MarketRepository } from './db/repositories/market-repository.js';
import { MetricEventRepository } from './db/repositories/metric-event-repository.js';
import { MonitorRepository } from './db/repositories/monitor-repository.js';
import { PriceSampleRepository } from './db/repositories/price-sample-repository.js';
import { RuleRepository } from './db/repositories/rule-repository.js';
import { RuleExecutionRepository } from './db/repositories/rule-execution-repository.js';
import { UniswapV4OwnershipRepository } from './db/repositories/uniswap-v4-ownership-repository.js';
import { ChainScanCursorRepository } from './db/repositories/chain-scan-cursor-repository.js';
import { ProtocolMetricSampleRepository } from './db/repositories/protocol-metric-sample-repository.js';
import { UniswapPoolRepository } from './db/repositories/uniswap-pool-repository.js';
import { UniswapPoolCoordinator } from './core/integrations/uniswap-pool-coordinator.js';
import type { UniswapPoolReaderFactory } from './core/integrations/uniswap-pool-coordinator.js';
import { UniswapPoolSwapSampleRepository } from './db/repositories/uniswap-pool-swap-sample-repository.js';
import { EncryptionService } from './security/encryption/encryption-service.js';
import { MonitorService } from './core/monitors/monitor-service.js';
import { createRpcObservabilityFetch } from './adapters/evm/evm-rpc-client.js';
import { redactLogValue } from './observability/safe-log.js';

export interface CreateAppOptions {
  config?: AppConfig;
  logger?: boolean;
  fetch?: typeof globalThis.fetch;
  webSocketFactory?: MarketWebSocketFactory | false;
  marketSampleIntervalMilliseconds?: number;
  aavePositionReaderFactory?: AaveV3PositionReaderFactory;
  aaveReserveCatalogReaderFactory?: AaveReserveCatalogReaderFactory;
  aaveEventReaderFactory?: AaveV3EventReaderFactory;
  aaveCapabilityEventReaderFactory?: AaveEventReaderFactory;
  uniswapV3PositionReaderFactory?: UniswapV3PositionReaderFactory;
  uniswapV4PositionReaderFactory?: UniswapV4PositionReaderFactory;
  uniswapV4OwnershipIndexerFactory?: UniswapV4OwnershipIndexerFactory;
  pollingMinimumIntervalMilliseconds?: number;
  uniswapPoolReaderFactory?: UniswapPoolReaderFactory;
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
  const baseFetch = options.fetch ?? globalThis.fetch;
  const rpcFetch = createRpcObservabilityFetch(baseFetch, (event) => {
    const payload = {
      methods: event.methods,
      durationMilliseconds: event.durationMilliseconds,
      statusCode: event.statusCode,
      ok: event.ok,
      ...(event.errorName === undefined ? {} : { errorName: event.errorName }),
    };
    if (!event.ok || event.durationMilliseconds >= 2_000) {
      app.log.warn(payload, 'EVM RPC request failed or was slow');
    } else if (config.logLevel === 'debug' || config.logLevel === 'trace') {
      app.log.debug(payload, 'EVM RPC request');
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/')) return;
    const payload = {
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url ?? request.url.split('?')[0],
      statusCode: reply.statusCode,
      durationMilliseconds: Math.max(0, reply.elapsedTime),
      request: {
        params: redactLogValue(request.params),
        query: redactLogValue(request.query),
        body: redactLogValue(request.body),
      },
    };
    if (reply.statusCode >= 400) request.log.warn(payload, 'API request completed with error');
    else request.log.info(payload, 'API request completed');
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'CryptoSentry API', version: '0.1.0' },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
        schemas: {
          StableErrorCode: {
            type: 'string',
            enum: [
              'RPC_ROUTING_CONFIG_INVALID', 'RPC_CHAIN_UNSUPPORTED', 'RPC_CHAIN_ID_MISMATCH',
              'RPC_CONNECTION_FAILED', 'RPC_PARTIAL_FAILURE', 'MONITOR_TYPE_NOT_READY', 'PROTOCOL_NOT_READY',
              'RULE_CONDITION_INVALID', 'METRIC_NOT_AVAILABLE', 'RESOURCE_CATALOG_NOT_READY',
              'RESOURCE_NOT_FOUND', 'POSITION_NOT_FOUND', 'POOL_NOT_FOUND', 'INDEXER_WARMING_UP',
              'INDEXER_PARTIAL_FAILURE', 'VALUATION_UNAVAILABLE', 'RULE_METRIC_UNSUPPORTED',
              'RULE_LABEL_INVALID', 'EVENT_RULE_DURATION_UNSUPPORTED',
            ],
          },
          ErrorResponse: {
            type: 'object', required: ['error'], properties: { error: {
              type: 'object', required: ['code', 'message'], properties: {
                code: { $ref: '#/components/schemas/StableErrorCode' }, message: { type: 'string' },
                fields: { type: 'object', additionalProperties: { type: 'string' } },
              },
            } },
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  registerErrorHandler(app);
  registerAuthentication(app, config.apiToken);

  const encryption = new EncryptionService(config.masterEncryptionKey);
  const events = new ConfigEventBus();
  const integrations = new IntegrationRepository(database.db, encryption);
  const integrationNetworkHealth = new IntegrationNetworkHealthRepository(database.db);
  const markets = new MarketRepository(database.db);
  const chainScanCursors = new ChainScanCursorRepository(database.db);
  const uniswapPools = new UniswapPoolRepository(database.db);
  const uniswapV4Ownership = new UniswapV4OwnershipRepository(database.db);
  const webSocketFactory = options.webSocketFactory === false
    ? createNodeMarketWebSocket
    : options.webSocketFactory ?? createNodeMarketWebSocket;
  const integrationOperations = new IntegrationOperationsService(
    integrations,
    markets,
    integrationNetworkHealth,
    rpcFetch,
    webSocketFactory,
    options.aaveReserveCatalogReaderFactory,
    options.aaveCapabilityEventReaderFactory,
    uniswapPools,
    chainScanCursors,
    uniswapV4Ownership,
    options.uniswapV3PositionReaderFactory,
    options.uniswapV4PositionReaderFactory,
  );
  const monitors = new MonitorRepository(database.db, integrations);
  const monitorService = new MonitorService(monitors, integrations, integrationNetworkHealth, rpcFetch, {
    ...(options.uniswapV3PositionReaderFactory === undefined ? {} : { v3Factory: options.uniswapV3PositionReaderFactory }),
    ...(options.uniswapV4PositionReaderFactory === undefined ? {} : { v4Factory: options.uniswapV4PositionReaderFactory }),
  });
  const rules = new RuleRepository(database.db);
  const ruleExecutionStore = new RuleExecutionRepository(database.db);
  const ruleExecution = new RuleExecutionService(ruleExecutionStore);
  const alerts = new AlertRepository(database.db);
  const status = new StatusService(database.db, [ruleExecution]);
  const latestMetrics = new LatestMetricStore();
  const metricPipeline = new MetricPipeline(
    monitors,
    latestMetrics,
    [ruleExecution],
    new MetricEventRepository(database.db),
  );
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
      fetch: rpcFetch,
      ...(options.aavePositionReaderFactory === undefined ? {} : { readerFactory: options.aavePositionReaderFactory }),
      samples: new ProtocolMetricSampleRepository(database.db),
      onError: (error) => app.log.warn({ err: error }, 'Aave V3 position scan error'),
    },
  );
  const aaveEventCoordinator = new AaveV3EventCoordinator(
    integrations,
    monitors,
    chainScanCursors,
    metricPipeline,
    pollingScheduler,
    {
      fetch: rpcFetch,
      ...(options.aaveEventReaderFactory === undefined ? {} : { readerFactory: options.aaveEventReaderFactory }),
      onError: (error) => app.log.warn({ err: error }, 'Aave V3 event scan error'),
    },
  );
  const uniswapV3PositionCoordinator = new UniswapV3PositionCoordinator(
    integrations,
    monitors,
    uniswapV4Ownership,
    metricPipeline,
    pollingScheduler,
    {
      fetch: rpcFetch,
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
  const uniswapPoolCoordinator = new UniswapPoolCoordinator(
    integrations, monitors, uniswapPools, chainScanCursors, metricPipeline, pollingScheduler,
    {
      fetch: rpcFetch,
      ...(options.uniswapPoolReaderFactory === undefined ? {} : { readerFactory: options.uniswapPoolReaderFactory }),
      samples: new UniswapPoolSwapSampleRepository(database.db),
      onError: (error) => app.log.warn({ err: error }, 'Uniswap pool monitor error'),
    },
  );
  const marketMetricService = options.webSocketFactory === false ? undefined : new MarketMetricService(
    new PriceSampleRepository(database.db),
    metricPipeline,
    {
      fetch: rpcFetch,
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
    app.log.info({ entity: event.entity, operation: event.operation, id: event.id }, 'Configuration changed');
    if (event.entity === 'monitor') {
      if (event.operation === 'deleted') {
        metricPipeline.removeMonitor(event.id);
        ruleExecution.invalidateMonitor(event.id);
      }
      if (event.operation === 'updated') ruleExecution.invalidateMonitor(event.id);
      if (event.operation === 'updated' && monitors.findRuntimeMonitor(event.id)?.enabled === false) {
        metricPipeline.forgetMonitor(event.id);
      }
    }
    if (event.entity === 'rule' && (event.operation === 'updated' || event.operation === 'deleted')) {
      ruleExecution.invalidateRule(event.id);
    }
    if (event.entity === 'monitor' || event.entity === 'integration' || event.entity === 'rule') {
      marketDataCoordinator?.reconcile();
    }
    if (event.entity === 'rule') {
      aavePositionCoordinator.reconcile();
      uniswapPoolCoordinator.reconcile();
    }
    if (event.entity === 'monitor' || event.entity === 'integration') {
      aavePositionCoordinator.reconcile();
      aaveEventCoordinator.reconcile();
      uniswapV3PositionCoordinator.reconcile();
      uniswapPoolCoordinator.reconcile();
    }
  });
  marketDataCoordinator?.reconcile();
  aavePositionCoordinator.reconcile();
  aaveEventCoordinator.reconcile();
  uniswapV3PositionCoordinator.reconcile();
  uniswapPoolCoordinator.reconcile();

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
  registerMonitorRoutes(app, monitors, events, latestMetrics, rules, monitorService);
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
    aaveEventCoordinator.close();
    uniswapV3PositionCoordinator.close();
    uniswapPoolCoordinator.close();
    await pollingScheduler.close();
    await marketMetricService?.close();
    await integrationOperations.close();
    await metricPipeline.close();
    ruleExecution.close();
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
