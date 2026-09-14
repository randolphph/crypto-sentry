import {
  WEB_SOCKET_OPEN,
  websocketEndpoint,
} from './websocket-port.js';
import type {
  MarketWebSocketFactory,
  MarketWebSocketHandle,
} from './websocket-port.js';

export interface SharedWebSocketFeedOptions {
  baseUrl: string;
  factory: MarketWebSocketFactory;
  onMessage(data: string): void;
  onError(error: Error): void;
  rotationMilliseconds?: number;
  reconnectBaseMilliseconds?: number;
  reconnectMaxMilliseconds?: number;
  stableConnectionMilliseconds?: number;
}

export class SharedWebSocketFeed {
  private readonly desiredStreams = new Set<string>();
  private readonly subscribedStreams = new Set<string>();
  private socket: MarketWebSocketHandle | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private rotationTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private requestId = 0;
  private generation = 0;
  private disposed = false;
  private plannedClose = false;

  public constructor(private readonly options: SharedWebSocketFeedOptions) {}

  public setStreams(streams: Iterable<string>): void {
    const next = new Set(streams);
    const removed = [...this.desiredStreams].filter((stream) => !next.has(stream));
    const added = [...next].filter((stream) => !this.desiredStreams.has(stream));
    this.desiredStreams.clear();
    for (const stream of next) this.desiredStreams.add(stream);

    if (this.disposed) return;
    if (next.size === 0) {
      this.clearReconnectTimer();
      if (this.socket !== undefined) {
        this.plannedClose = true;
        this.socket.close(1000, 'no active subscriptions');
      }
      return;
    }
    if (this.socket === undefined) {
      if (this.reconnectTimer === undefined) this.connect();
      return;
    }
    if (this.socket.readyState !== WEB_SOCKET_OPEN) return;
    if (removed.length > 0) this.sendControl('UNSUBSCRIBE', removed);
    if (added.length > 0) this.sendControl('SUBSCRIBE', added);
  }

  public close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.clearTimers();
    this.desiredStreams.clear();
    this.subscribedStreams.clear();
    this.plannedClose = true;
    this.socket?.close(1000, 'service shutdown');
    this.socket = undefined;
  }

  private connect(): void {
    if (this.disposed || this.desiredStreams.size === 0 || this.socket !== undefined) return;
    const generation = ++this.generation;
    this.plannedClose = false;
    try {
      this.socket = this.options.factory(websocketEndpoint(this.options.baseUrl), {
        open: () => this.handleOpen(generation),
        message: (data) => {
          if (generation !== this.generation) return;
          try {
            this.options.onMessage(data);
          } catch (error) {
            this.options.onError(toError(error));
          }
        },
        close: (code, reason) => this.handleClose(generation, code, reason),
        error: (error) => this.handleError(generation, error),
      });
    } catch (error) {
      this.socket = undefined;
      this.options.onError(toError(error));
      this.scheduleReconnect();
    }
  }

  private handleOpen(generation: number): void {
    if (generation !== this.generation || this.socket === undefined) return;
    this.clearReconnectTimer();
    this.subscribedStreams.clear();
    this.sendControl('SUBSCRIBE', [...this.desiredStreams]);
    this.clearRotationTimer();
    this.rotationTimer = setTimeout(() => this.rotate(), this.options.rotationMilliseconds ?? 84_600_000);
    this.stableTimer = setTimeout(() => {
      this.reconnectAttempts = 0;
    }, this.options.stableConnectionMilliseconds ?? 30_000);
  }

  private handleClose(generation: number, code: number, reason: string): void {
    if (generation !== this.generation) return;
    const planned = this.plannedClose;
    this.socket = undefined;
    this.subscribedStreams.clear();
    this.clearRotationTimer();
    this.clearStableTimer();
    if (this.disposed || this.desiredStreams.size === 0) return;
    if (!planned) this.options.onError(new Error(`WebSocket closed (${code}${reason === '' ? '' : `: ${reason}`})`));
    this.scheduleReconnect(planned ? 0 : undefined);
  }

  private handleError(generation: number, error: Error): void {
    if (generation !== this.generation || this.disposed) return;
    this.options.onError(error);
    this.socket?.terminate();
  }

  private rotate(): void {
    if (this.socket === undefined) return;
    this.plannedClose = true;
    this.socket.close(1000, 'scheduled connection rotation');
  }

  private scheduleReconnect(delay?: number): void {
    if (this.disposed || this.desiredStreams.size === 0 || this.reconnectTimer !== undefined) return;
    const calculatedDelay = delay ?? Math.min(
      (this.options.reconnectBaseMilliseconds ?? 1_000) * (2 ** this.reconnectAttempts),
      this.options.reconnectMaxMilliseconds ?? 30_000,
    );
    if (delay === undefined) this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, calculatedDelay);
  }

  private sendControl(method: 'SUBSCRIBE' | 'UNSUBSCRIBE', streams: string[]): void {
    if (streams.length === 0 || this.socket?.readyState !== WEB_SOCKET_OPEN) return;
    try {
      this.socket.send(JSON.stringify({ method, params: streams, id: ++this.requestId }));
    } catch (error) {
      this.options.onError(toError(error));
      this.socket.terminate();
      return;
    }
    const target = method === 'SUBSCRIBE' ? this.subscribedStreams : undefined;
    for (const stream of streams) {
      if (target === undefined) this.subscribedStreams.delete(stream);
      else target.add(stream);
    }
  }

  private clearTimers(): void {
    this.clearReconnectTimer();
    this.clearRotationTimer();
    this.clearStableTimer();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private clearRotationTimer(): void {
    if (this.rotationTimer !== undefined) clearTimeout(this.rotationTimer);
    this.rotationTimer = undefined;
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== undefined) clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
