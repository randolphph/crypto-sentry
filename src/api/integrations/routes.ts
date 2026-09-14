import type { FastifyInstance } from 'fastify';

import type { ConfigEventBus } from '../../core/config-events/config-event-bus.js';
import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import { AppError } from '../errors.js';
import { openApiSchema } from '../openapi.js';
import { idParamsSchema, integrationCreateSchema, integrationPatchSchema } from '../schemas.js';

export function registerIntegrationRoutes(
  app: FastifyInstance,
  repository: IntegrationRepository,
  events: ConfigEventBus,
): void {
  app.get('/api/v1/integrations', { schema: { tags: ['integrations'] } }, async () => ({ items: repository.list() }));

  app.post('/api/v1/integrations', { schema: {
    tags: ['integrations'],
    summary: 'Create an integration',
    body: openApiSchema(integrationCreateSchema),
  } }, async (request, reply) => {
    const input = integrationCreateSchema.parse(request.body);
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
    events.publish({ entity: 'integration', operation: 'updated', id });
    return updated;
  });

  app.delete('/api/v1/integrations/:id', { schema: { tags: ['integrations'], params: openApiSchema(idParamsSchema) } }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    repository.delete(id);
    events.publish({ entity: 'integration', operation: 'deleted', id });
    return reply.status(204).send();
  });

  app.post('/api/v1/integrations/:id/test', { schema: { tags: ['integrations'], params: openApiSchema(idParamsSchema) } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    repository.get(id);
    throw new AppError(409, 'ADAPTER_NOT_READY', 'This integration adapter is not available in the current development stage');
  });

  app.post('/api/v1/integrations/:id/sync-markets', { schema: { tags: ['integrations'], params: openApiSchema(idParamsSchema) } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    repository.get(id);
    throw new AppError(409, 'ADAPTER_NOT_READY', 'Market synchronization will be enabled with the Binance adapter');
  });

  app.get('/api/v1/integrations/:id/markets', { schema: { tags: ['integrations'], params: openApiSchema(idParamsSchema) } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    repository.get(id);
    return { items: [] };
  });
}
