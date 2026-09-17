import { AsyncLocalStorage } from 'node:async_hooks';

export interface RpcRequestContext {
  taskId: string;
}

/** Carries a scheduler task identity down to the shared RPC transport safely. */
export class RpcRequestContextStore {
  private readonly storage = new AsyncLocalStorage<RpcRequestContext>();

  public run<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    return this.storage.run({ taskId }, operation);
  }

  public taskId(): string | undefined {
    return this.storage.getStore()?.taskId;
  }
}
