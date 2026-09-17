import type { RpcHttpRequestLog } from '../../adapters/evm/evm-rpc-client.js';
import type { RpcRequestLogRecord, RpcRequestLogRepository } from '../../db/repositories/rpc-request-log-repository.js';

const DEFAULT_FLUSH_MILLISECONDS = 1_000;
const DEFAULT_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_PRUNE_INTERVAL_MILLISECONDS = 60 * 60 * 1_000;

/**
 * Batches safe transport metadata so observing RPC use does not create one SQLite
 * transaction per outbound request. Sensitive endpoint configuration and request
 * parameters are intentionally unavailable to this service.
 */
export class RpcRequestAuditService {
  private pending: RpcRequestLogRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private lastPrunedAt = 0;

  public constructor(
    private readonly repository: RpcRequestLogRepository,
    private readonly options: {
      now?: () => Date;
      flushMilliseconds?: number;
      retentionMilliseconds?: number;
      pruneIntervalMilliseconds?: number;
    } = {},
  ) {}

  public record(event: RpcHttpRequestLog, taskId?: string): void {
    if (this.closed) return;
    this.pending.push({
      observedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      ...(taskId === undefined ? {} : { taskId }),
      methods: [...event.methods],
      durationMilliseconds: event.durationMilliseconds,
      statusCode: event.statusCode,
      ok: event.ok,
      ...(event.errorName === undefined ? {} : { errorName: event.errorName }),
    });
    if (this.pending.length >= 50) {
      this.flush();
      return;
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), this.options.flushMilliseconds ?? DEFAULT_FLUSH_MILLISECONDS);
      this.timer.unref();
    }
  }

  public flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    const records = this.pending;
    this.pending = [];
    this.repository.append(records);
    const now = (this.options.now ?? (() => new Date()))().getTime();
    if (now - this.lastPrunedAt >= (this.options.pruneIntervalMilliseconds ?? DEFAULT_PRUNE_INTERVAL_MILLISECONDS)) {
      this.repository.pruneBefore(new Date(now - (this.options.retentionMilliseconds ?? DEFAULT_RETENTION_MILLISECONDS)).toISOString());
      this.lastPrunedAt = now;
    }
  }

  public close(): void {
    this.closed = true;
    this.flush();
  }
}
