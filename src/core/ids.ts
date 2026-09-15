import { randomUUID } from 'node:crypto';

export function createId(prefix: 'int' | 'mon' | 'rule' | 'condition' | 'alert'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}
