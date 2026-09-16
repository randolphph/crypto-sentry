import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ConfigEventBus } from '../../core/config-events/config-event-bus.js';
import type { IntegrationOperationsService } from '../../core/integrations/integration-operations-service.js';
import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import { openApiSchema } from '../openapi.js';
import { AppError } from '../errors.js';
import { idParamsSchema, integrationCreateSchema, integrationPatchSchema } from '../schemas.js';

const aaveReserveQuerySchema = z.object({ chainId: z.coerce.number().int().min(1) });

export function registerIntegrationRoutes(
  app: FastifyInstance,
  repository: IntegrationRepository,
  operations: IntegrationOperationsService,
  events: ConfigEventBus,
): void {
  app.get('/api/v1/integrations', { schema: { tags: ['integrations'] } }, async () => ({ items: repository.list() }));

  app.get('/api/v1/integrations/catalog', { schema: {
    tags: ['integrations'],
    summary: 'List supported data-source providers, networks, and safe defaults',
  } }, async () => operations.catalog());

  app.get('/api/v1/integrations/readiness', { schema: {
    tags: ['integrations'],
    summary: 'Report whether Aave and Binance data sources are ready for monitors',
  } }, async () => operations.readiness());

  app.get('/api/v1/integrations/:id/aave/reserves', { schema: {
    tags: ['integrations', 'aave'],
    summary: 'List Aave V3 Ethereum reserves from the official deployment',
    params: openApiSchema(idParamsSchema),
    querystring: openApiSchema(aaveReserveQuerySchema),
  } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const { chainId } = aaveReserveQuerySchema.parse(request.query);
    return operations.aaveReserves(id, chainId);
  });

  app.post('/api/v1/integrations/binance/default', { schema: {
    tags: ['integrations'],
    summary: 'Idempotently create the default credential-free Binance market-data source',
  } }, async (_request, reply) => {
    const result = operations.ensureDefaultBinance();
    if (result.created) events.publish({ entity: 'integration', operation: 'created', id: result.integration.id });
    return reply.status(result.created ? 201 : 200).send(result);
  });

  app.post('/api/v1/integrations', { schema: {
    tags: ['integrations'],
    summary: 'Create an integration',
    body: openApiSchema(integrationCreateSchema),
  } }, async (request, reply) => {
    const parsed = integrationCreateSchema.safeParse(request.body);
    if (!parsed.success && typeof request.body === 'object' && request.body !== null &&
      'type' in request.body && request.body.type === 'evm_rpc') {
      throw new AppError(400, 'RPC_ROUTING_CONFIG_INVALID', 'EVM RPC routing configuration is invalid', {
        config: parsed.error.issues.map((issue) => issue.message).join('; '),
      });
    }
    const input = parsed.success ? parsed.data : integrationCreateSchema.parse(request.body);
    const created = repository.create(input);
    events.publish({ entity: 'integration', operation: 'created', id: created.id });
    return reply.status(201).send(created);
  });

  app.get('/api/v1/integrations/:id', { schema: { tags: ['integrations'], params: openApiSchema(idParamsSchema) } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return repository.get(id);
  });

  app.patch('/api/v1/integrations/:id', { schema: {
    tags: ['integrations'],
    summary: 'Update an integration and hot-reload its configuration',
    params: openApiSchema(idParamsSchema),
    body: openApiSchema(integrationPatchSchema),
  } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const updated = repository.update(id, integrationPatchSchema.parse(request.body));
    operations.invalidateTestResults(id);
    events.publish({ entity: 'integration', operation: 'updated', id });
    return updated;
  });

  app.delete('/api/v1/integrations/:id', { schema: { tags: ['integrations'], params: openApiSchema(idParamsSchema) } }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    repository.delete(id);
    operations.invalidateTestResults(id);
    events.publish({ entity: 'integration', operation: 'deleted', id });
    return reply.status(204).send();
  });

  app.post('/api/v1/integrations/:id/test', { schema: { tags: ['integrations'], params: openApiSchema(idParamsSchema) } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return operations.test(id);
  });

  app.post('/api/v1/integrations/:id/sync-markets', { schema: { tags: ['integrations'], params: openApiSchema(idParamsSchema) } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return operations.syncMarkets(id);
  });

  app.get('/api/v1/integrations/:id/markets', { schema: { tags: ['integrations'], params: openApiSchema(idParamsSchema) } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return operations.listMarkets(id);
  });
}
