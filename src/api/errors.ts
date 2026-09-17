import { ZodError } from 'zod';
import type { FastifyInstance } from 'fastify';

interface RequestValidationIssue {
  instancePath?: string;
  params: { missingProperty?: string };
  message?: string;
}

function isRequestValidationError(error: unknown): error is { validation: RequestValidationIssue[] } {
  return typeof error === 'object' && error !== null && 'validation' in error && Array.isArray(error.validation);
}

export class AppError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (isRequestValidationError(error)) {
      const fields = Object.fromEntries(error.validation.map((issue) => [
        issue.instancePath || issue.params.missingProperty?.toString() || 'request',
        issue.message ?? 'Invalid value',
      ]));
      return reply.status(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Request validation failed', fields },
      });
    }

    if (error instanceof ZodError) {
      const fields = Object.fromEntries(
        error.issues.map((issue) => [issue.path.join('.') || 'request', issue.message]),
      );
      return reply.status(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Request validation failed', fields },
      });
    }

    if (error instanceof AppError) {
      request.log.warn({
        requestId: request.id,
        statusCode: error.statusCode,
        code: error.code,
        fields: error.fields,
      }, 'API request rejected');
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.fields === undefined ? {} : { fields: error.fields }),
        },
      });
    }

    request.log.error({
      requestId: request.id,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    }, 'Unhandled request error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  });
}
