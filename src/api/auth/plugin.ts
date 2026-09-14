import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../errors.js';

function tokensMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function registerAuthentication(app: FastifyInstance, apiToken: string): void {
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/v1')) return;

    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      throw new AppError(401, 'UNAUTHORIZED', 'A valid Bearer token is required');
    }

    const suppliedToken = authorization.slice('Bearer '.length);
    if (!tokensMatch(suppliedToken, apiToken)) {
      throw new AppError(401, 'UNAUTHORIZED', 'A valid Bearer token is required');
    }
  });
}
