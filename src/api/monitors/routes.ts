import type { FastifyInstance } from 'fastify';

import type { ConfigEventBus } from '../../core/config-events/config-event-bus.js';
import type { MetricSnapshotReader } from '../../core/metrics/latest-metric-store.js';
import { AavePositionSnapshotService } from '../../core/positions/aave-position-snapshot-service.js';
import { UniswapV3PositionSnapshotService } from '../../core/positions/uniswap-v3-position-snapshot-service.js';
import { MonitorSnapshotService } from '../../core/positions/monitor-snapshot-service.js';
import { AaveRiskRulePresetService } from '../../core/rules/aave-risk-rule-preset-service.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import type { RuleRepository } from '../../db/repositories/rule-repository.js';
import { AppError } from '../errors.js';
import { openApiSchema } from '../openapi.js';
import { aaveRiskRulePresetSchema, idParamsSchema, monitorCreateSchema, monitorPatchSchema } from '../schemas.js';

export function registerMonitorRoutes(
  app: FastifyInstance,
  repository: MonitorRepository,
  events: ConfigEventBus,
  metrics: MetricSnapshotReader,
  rules: RuleRepository,
): void {
  const aavePositions = new AavePositionSnapshotService(repository, metrics);
  const uniswapPositions = new UniswapV3PositionSnapshotService(repository, metrics);
  const aaveRiskRules = new AaveRiskRulePresetService(aavePositions, rules);
  const snapshots = new MonitorSnapshotService(repository, metrics);
  app.get('/api/v1/monitors', { schema: { tags: ['monitors'] } }, async () => ({ items: repository.list() }));

  app.post('/api/v1/monitors', { schema: {
    tags: ['monitors'],
    summary: 'Create a monitor',
    body: openApiSchema(monitorCreateSchema),
  } }, async (request, reply) => {
    const created = repository.create(monitorCreateSchema.parse(request.body));
    events.publish({ entity: 'monitor', operation: 'created', id: created.id });
    return reply.status(201).send(created);
  });

  app.get('/api/v1/monitors/:id', { schema: { tags: ['monitors'], params: openApiSchema(idParamsSchema) } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return repository.get(id);
  });

  app.patch('/api/v1/monitors/:id', { schema: {
    tags: ['monitors'],
    summary: 'Update, enable, or disable a monitor',
    params: openApiSchema(idParamsSchema),
    body: openApiSchema(monitorPatchSchema),
  } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const updated = repository.update(id, monitorPatchSchema.parse(request.body));
    events.publish({ entity: 'monitor', operation: 'updated', id });
    return updated;
  });

  app.delete('/api/v1/monitors/:id', { schema: { tags: ['monitors'], params: openApiSchema(idParamsSchema) } }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    repository.delete(id);
    events.publish({ entity: 'monitor', operation: 'deleted', id });
    return reply.status(204).send();
  });

  app.post('/api/v1/monitors/:id/test', { schema: { tags: ['monitors'], params: openApiSchema(idParamsSchema) } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    repository.get(id);
    throw new AppError(409, 'ADAPTER_NOT_READY', 'This monitor adapter is not available in the current development stage');
  });

  app.get('/api/v1/monitors/:id/metrics', { schema: { tags: ['monitors'], params: openApiSchema(idParamsSchema) } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    repository.get(id);
    return { items: metrics.list(id) };
  });

  app.get('/api/v1/monitors/:id/snapshot', { schema: {
    tags: ['monitors'],
    summary: 'Get the normalized current snapshot for any monitor type',
    params: openApiSchema(idParamsSchema),
  } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return snapshots.get(id);
  });

  app.get('/api/v1/monitors/:id/positions', { schema: {
    tags: ['monitors'],
    summary: 'Get a structured Aave V3 position snapshot',
    params: openApiSchema(idParamsSchema),
  } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return aavePositions.get(id);
  });

  app.get('/api/v1/monitors/:id/uniswap-position', { schema: {
    tags: ['monitors'],
    summary: 'Get a legacy single-token Uniswap V3/V4 LP position snapshot',
    params: openApiSchema(idParamsSchema),
  } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return uniswapPositions.getLegacy(id);
  });

  app.get('/api/v1/monitors/:id/uniswap-positions', { schema: {
    tags: ['monitors'],
    summary: 'Get wallet-discovered Uniswap V3/V4 LP position snapshots',
    params: openApiSchema(idParamsSchema),
  } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return uniswapPositions.get(id);
  });

  app.post('/api/v1/monitors/:id/aave-risk-rules', { schema: {
    tags: ['monitors', 'rules'],
    summary: 'Create chain-scoped default Aave V3 health-factor rules',
    params: openApiSchema(idParamsSchema),
    body: openApiSchema(aaveRiskRulePresetSchema),
  } }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const result = aaveRiskRules.create(id, aaveRiskRulePresetSchema.parse(request.body));
    for (const item of result.items) {
      if (item.created) events.publish({ entity: 'rule', operation: 'created', id: item.id });
    }
    return reply.status(result.createdCount > 0 ? 201 : 200).send(result);
  });
}
