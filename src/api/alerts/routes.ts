import type { FastifyInstance } from 'fastify';

import type { AlertRepository } from '../../db/repositories/alert-repository.js';
import { openApiSchema } from '../openapi.js';
import { alertListQuerySchema, idParamsSchema } from '../schemas.js';

export function registerAlertRoutes(app: FastifyInstance, repository: AlertRepository): void {
  app.get('/api/v1/alerts', { schema: {
    tags: ['alerts'],
    summary: 'List historical alerts',
    querystring: openApiSchema(alertListQuerySchema),
  } }, async (request) => {
    return repository.list(alertListQuerySchema.parse(request.query));
  });

  app.get('/api/v1/alerts/:id', { schema: { tags: ['alerts'], params: openApiSchema(idParamsSchema) } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return repository.get(id);
  });

  app.post('/api/v1/alerts/:id/acknowledge', { schema: { tags: ['alerts'], params: openApiSchema(idParamsSchema) } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return repository.acknowledge(id);
  });

  app.post('/api/v1/alerts/:id/resolve', { schema: { tags: ['alerts'], params: openApiSchema(idParamsSchema) } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return repository.resolve(id);
  });
}
