import type { FastifyInstance } from 'fastify';

import type { StatusService } from '../../core/status/status-service.js';

export function registerStatusRoutes(app: FastifyInstance, status: StatusService): void {
  app.get('/api/v1/status/summary', { schema: { tags: ['status'] } }, async () => status.summary());
  app.get('/api/v1/status/monitors', { schema: { tags: ['status'] } }, async () => ({ items: status.monitorStatuses() }));
}
