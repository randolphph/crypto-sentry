import { randomUUID } from 'node:crypto';

export function createId(prefix: 'int' | 'mon' | 'rule' | 'alert'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}
