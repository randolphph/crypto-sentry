import type { FastifyInstance } from 'fastify';

import type { StatusService } from '../../core/status/status-service.js';
import type { RpcRequestLogRepository } from '../../db/repositories/rpc-request-log-repository.js';

export function registerStatusRoutes(
  app: FastifyInstance,
  status: StatusService,
  rpcRequestLogs: RpcRequestLogRepository,
): void {
  app.get('/api/v1/status/summary', { schema: { tags: ['status'] } }, async () => status.summary());
  app.get('/api/v1/status/monitors', { schema: { tags: ['status'] } }, async () => ({ items: status.monitorStatuses() }));
  app.get('/api/v1/status/rpc-requests', { schema: { tags: ['status'] } }, async (request) => {
    const query = request.query as { limit?: string; taskId?: string };
    const requested = query.limit === undefined ? 100 : Number(query.limit);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 500) : 100;
    return { items: rpcRequestLogs.list({ limit, ...(query.taskId === undefined ? {} : { taskId: query.taskId }) }) };
  });
}
