export interface PollingTask {
  id: string;
  intervalMilliseconds: number;
  run(signal: AbortSignal): Promise<void>;
}

export interface PollingSchedulerOptions {
  onError(taskId: string, error: Error): void;
  minimumIntervalMilliseconds?: number;
  runWithContext?<T>(taskId: string, operation: () => Promise<T>): Promise<T>;
}

interface TaskState {
  task: PollingTask;
  generation: number;
  timer?: ReturnType<typeof setTimeout> | undefined;
  controller?: AbortController | undefined;
  running?: Promise<void> | undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class PollingScheduler {
  private readonly states = new Map<string, TaskState>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly minimumIntervalMilliseconds: number;
  private closed = false;

  public constructor(private readonly options: PollingSchedulerOptions) {
    this.minimumIntervalMilliseconds = options.minimumIntervalMilliseconds ?? 5_000;
  }

  public upsert(task: PollingTask): void {
    if (this.closed) throw new Error('Polling scheduler is closed');
    if (!Number.isFinite(task.intervalMilliseconds) || task.intervalMilliseconds < this.minimumIntervalMilliseconds) {
      throw new Error(`Polling task ${task.id} interval must be at least ${this.minimumIntervalMilliseconds}ms`);
    }
    const current = this.states.get(task.id);
    if (current !== undefined) {
      current.task = task;
      return;
    }
    const state: TaskState = { task, generation: 1 };
    this.states.set(task.id, state);
    this.schedule(state, 0);
  }

  public remove(taskId: string): void {
    const state = this.states.get(taskId);
    if (state === undefined) return;
    this.states.delete(taskId);
    state.generation += 1;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.controller?.abort();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.states.values()) {
      state.generation += 1;
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.controller?.abort();
    }
    this.states.clear();
    await Promise.all([...this.inFlight]);
  }

  private schedule(state: TaskState, delay: number): void {
    const generation = state.generation;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (this.closed || this.states.get(state.task.id) !== state || state.generation !== generation) return;
      const controller = new AbortController();
      state.controller = controller;
      const running = Promise.resolve()
        .then(async () => {
          const operation = () => state.task.run(controller.signal);
          return this.options.runWithContext === undefined
            ? operation()
            : this.options.runWithContext(state.task.id, operation);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) this.options.onError(state.task.id, toError(error));
        })
        .finally(() => {
          this.inFlight.delete(running);
          state.controller = undefined;
          state.running = undefined;
          if (!this.closed && this.states.get(state.task.id) === state && state.generation === generation) {
            this.schedule(state, state.task.intervalMilliseconds);
          }
        });
      state.running = running;
      this.inFlight.add(running);
    }, delay);
  }
}
