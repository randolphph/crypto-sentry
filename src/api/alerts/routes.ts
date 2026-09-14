import type { FastifyInstance } from 'fastify';

import type { AlertRepository } from '../../db/repositories/alert-repository.js';
import { alertListQuerySchema, idParamsSchema } from '../schemas.js';

export function registerAlertRoutes(app: FastifyInstance, repository: AlertRepository): void {
  app.get('/api/v1/alerts', { schema: { tags: ['alerts'] } }, async (request) => {
    return repository.list(alertListQuerySchema.parse(request.query));
  });

  app.get('/api/v1/alerts/:id', { schema: { tags: ['alerts'] } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return repository.get(id);
  });

  app.post('/api/v1/alerts/:id/acknowledge', { schema: { tags: ['alerts'] } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return repository.acknowledge(id);
  });

  app.post('/api/v1/alerts/:id/resolve', { schema: { tags: ['alerts'] } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return repository.resolve(id);
  });
}
