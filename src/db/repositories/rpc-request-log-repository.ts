import { desc, eq, sql } from 'drizzle-orm';

import type { AppDatabase } from '../client.js';
import { rpcRequestLogs } from '../schema/index.js';

export interface RpcRequestLogRecord {
  observedAt: string;
  taskId?: string | undefined;
  methods: string[];
  durationMilliseconds: number;
  statusCode: number | null;
  ok: boolean;
  errorName?: string | undefined;
}

export class RpcRequestLogRepository {
  public constructor(private readonly database: AppDatabase['db']) {}

  public append(records: RpcRequestLogRecord[]): void {
    if (records.length === 0) return;
    this.database.insert(rpcRequestLogs).values(records.map((record) => ({
      observedAt: record.observedAt,
      taskId: record.taskId ?? null,
      methodsJson: JSON.stringify(record.methods),
      durationMilliseconds: Math.max(0, Math.round(record.durationMilliseconds)),
      statusCode: record.statusCode,
      ok: record.ok,
      errorName: record.errorName ?? null,
    }))).run();
  }

  public pruneBefore(observedAt: string): void {
    this.database.delete(rpcRequestLogs).where(sql`${rpcRequestLogs.observedAt} < ${observedAt}`).run();
  }

  public list(input: { limit: number; taskId?: string | undefined }) {
    const where = input.taskId === undefined ? undefined : eq(rpcRequestLogs.taskId, input.taskId);
    return this.database.select({
      id: rpcRequestLogs.id,
      observedAt: rpcRequestLogs.observedAt,
      taskId: rpcRequestLogs.taskId,
      methodsJson: rpcRequestLogs.methodsJson,
      durationMilliseconds: rpcRequestLogs.durationMilliseconds,
      statusCode: rpcRequestLogs.statusCode,
      ok: rpcRequestLogs.ok,
      errorName: rpcRequestLogs.errorName,
    }).from(rpcRequestLogs).where(where).orderBy(desc(rpcRequestLogs.id)).limit(input.limit).all().map((row) => ({
      id: row.id,
      observedAt: row.observedAt,
      taskId: row.taskId,
      methods: JSON.parse(row.methodsJson) as string[],
      durationMilliseconds: row.durationMilliseconds,
      statusCode: row.statusCode,
      ok: row.ok,
      errorName: row.errorName,
    }));
  }
}
