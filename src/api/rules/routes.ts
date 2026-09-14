import type { FastifyInstance } from 'fastify';

import type { ConfigEventBus } from '../../core/config-events/config-event-bus.js';
import type { RuleRepository } from '../../db/repositories/rule-repository.js';
import { AppError } from '../errors.js';
import { idParamsSchema, ruleCreateSchema, rulePatchSchema } from '../schemas.js';

export function registerRuleRoutes(
  app: FastifyInstance,
  repository: RuleRepository,
  events: ConfigEventBus,
): void {
  app.get('/api/v1/rules', { schema: { tags: ['rules'] } }, async () => ({ items: repository.list() }));

  app.post('/api/v1/rules', { schema: { tags: ['rules'] } }, async (request, reply) => {
    const created = repository.create(ruleCreateSchema.parse(request.body));
    events.publish({ entity: 'rule', operation: 'created', id: created.id });
    return reply.status(201).send(created);
  });

  app.get('/api/v1/rules/:id', { schema: { tags: ['rules'] } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return repository.get(id);
  });

  app.patch('/api/v1/rules/:id', { schema: { tags: ['rules'] } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const updated = repository.update(id, rulePatchSchema.parse(request.body));
    events.publish({ entity: 'rule', operation: 'updated', id });
    return updated;
  });

  app.delete('/api/v1/rules/:id', { schema: { tags: ['rules'] } }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    repository.delete(id);
    events.publish({ entity: 'rule', operation: 'deleted', id });
    return reply.status(204).send();
  });

  app.post('/api/v1/rules/:id/test', { schema: { tags: ['rules'] } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    repository.get(id);
    throw new AppError(409, 'METRIC_NOT_AVAILABLE', 'No live metric is available before a monitor adapter is started');
  });
}
