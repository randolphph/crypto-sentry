import type { FastifyInstance } from 'fastify';

import type { ConfigEventBus } from '../../core/config-events/config-event-bus.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import { AppError } from '../errors.js';
import { idParamsSchema, monitorCreateSchema, monitorPatchSchema } from '../schemas.js';

export function registerMonitorRoutes(
  app: FastifyInstance,
  repository: MonitorRepository,
  events: ConfigEventBus,
): void {
  app.get('/api/v1/monitors', { schema: { tags: ['monitors'] } }, async () => ({ items: repository.list() }));

  app.post('/api/v1/monitors', { schema: { tags: ['monitors'] } }, async (request, reply) => {
    const created = repository.create(monitorCreateSchema.parse(request.body));
    events.publish({ entity: 'monitor', operation: 'created', id: created.id });
    return reply.status(201).send(created);
  });

  app.get('/api/v1/monitors/:id', { schema: { tags: ['monitors'] } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return repository.get(id);
  });

  app.patch('/api/v1/monitors/:id', { schema: { tags: ['monitors'] } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const updated = repository.update(id, monitorPatchSchema.parse(request.body));
    events.publish({ entity: 'monitor', operation: 'updated', id });
    return updated;
  });

  app.delete('/api/v1/monitors/:id', { schema: { tags: ['monitors'] } }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    repository.delete(id);
    events.publish({ entity: 'monitor', operation: 'deleted', id });
    return reply.status(204).send();
  });

  app.post('/api/v1/monitors/:id/test', { schema: { tags: ['monitors'] } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    repository.get(id);
    throw new AppError(409, 'ADAPTER_NOT_READY', 'This monitor adapter is not available in the current development stage');
  });

  app.get('/api/v1/monitors/:id/metrics', { schema: { tags: ['monitors'] } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    repository.get(id);
    return { items: [] };
  });
}
