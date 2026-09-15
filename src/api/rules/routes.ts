import type { FastifyInstance } from 'fastify';

import type { ConfigEventBus } from '../../core/config-events/config-event-bus.js';
import type { RuleRepository } from '../../db/repositories/rule-repository.js';
import type { RuleCreate, RulePatch } from '../schemas.js';
import { AppError } from '../errors.js';
import { openApiSchema } from '../openapi.js';
import { idParamsSchema, rulePatchSchema } from '../schemas.js';

const ruleGroupBodySchema = {
  type: 'object',
  description: 'Rule Group request. Legacy single-condition metric/operator/threshold fields are also accepted.',
  properties: {
    monitorId: { type: 'string' }, name: { type: 'string' }, combinator: { enum: ['and', 'or'] },
    conditions: { type: 'array', minItems: 1, maxItems: 20, items: {
      type: 'object', required: ['metric', 'operator', 'threshold'],
      properties: {
        metric: { type: 'string' }, labels: { type: 'object', additionalProperties: { type: 'string' } },
        operator: { enum: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'] }, threshold: { type: 'string' },
        windowSeconds: { type: 'integer' }, hysteresis: { type: 'string' },
      },
    } },
    durationSeconds: { type: 'integer' }, cooldownSeconds: { type: 'integer' },
    severity: { enum: ['info', 'warning', 'critical', 'emergency'] },
    notificationIntegrationIds: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' },
  },
} as const;

export function registerRuleRoutes(
  app: FastifyInstance,
  repository: RuleRepository,
  events: ConfigEventBus,
): void {
  app.get('/api/v1/rules', { schema: { tags: ['rules'] } }, async () => ({ items: repository.list() }));

  app.post('/api/v1/rules', { schema: {
    tags: ['rules'],
    summary: 'Create a monitoring rule',
    body: ruleGroupBodySchema,
  } }, async (request, reply) => {
    const created = repository.create(request.body as RuleCreate);
    events.publish({ entity: 'rule', operation: 'created', id: created.id });
    return reply.status(201).send(created);
  });

  app.get('/api/v1/rules/:id', { schema: { tags: ['rules'], params: openApiSchema(idParamsSchema) } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return repository.get(id);
  });

  app.patch('/api/v1/rules/:id', { schema: {
    tags: ['rules'],
    summary: 'Update a rule and reset condition state when required',
    params: openApiSchema(idParamsSchema),
    body: openApiSchema(rulePatchSchema),
  } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const updated = repository.update(id, request.body as RulePatch);
    events.publish({ entity: 'rule', operation: 'updated', id });
    return updated;
  });

  app.delete('/api/v1/rules/:id', { schema: { tags: ['rules'], params: openApiSchema(idParamsSchema) } }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    repository.delete(id);
    events.publish({ entity: 'rule', operation: 'deleted', id });
    return reply.status(204).send();
  });

  app.post('/api/v1/rules/:id/test', { schema: { tags: ['rules'], params: openApiSchema(idParamsSchema) } }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    repository.get(id);
    throw new AppError(409, 'METRIC_NOT_AVAILABLE', 'No live metric is available before a monitor adapter is started');
  });
}
