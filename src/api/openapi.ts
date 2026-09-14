import { toJSONSchema } from 'zod';
import type { ZodType } from 'zod';

export function openApiSchema(schema: ZodType): Record<string, unknown> {
  return toJSONSchema(schema, {
    target: 'openapi-3.0',
    reused: 'inline',
    unrepresentable: 'any',
    io: 'input',
  });
}
