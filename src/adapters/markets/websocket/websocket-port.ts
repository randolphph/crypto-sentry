import WebSocket from 'ws';

export interface MarketWebSocketHandlers {
  open(): void;
  message(data: string): void;
  close(code: number, reason: string): void;
  error(error: Error): void;
}

export interface MarketWebSocketHandle {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export type MarketWebSocketFactory = (
  url: string,
  handlers: MarketWebSocketHandlers,
) => MarketWebSocketHandle;

export const WEB_SOCKET_OPEN = 1;

export const createNodeMarketWebSocket: MarketWebSocketFactory = (url, handlers) => {
  const socket = new WebSocket(url, { autoPong: false });
  socket.on('open', () => handlers.open());
  socket.on('message', (data) => handlers.message(
    Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString('utf8')
        : data.toString('utf8'),
  ));
  socket.on('close', (code, reason) => handlers.close(code, reason.toString()));
  socket.on('error', (error) => handlers.error(error));
  socket.on('ping', (data) => socket.pong(data));
  return {
    get readyState() {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    terminate: () => socket.terminate(),
  };
};

export function websocketEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/$/, '');
  if (!path.endsWith('/ws') && !path.endsWith('/stream')) url.pathname = `${path}/ws`;
  return url.toString();
}

export async function testWebSocketConnectivity(
  baseUrl: string,
  factory: MarketWebSocketFactory,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let socket: MarketWebSocketHandle | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket?.terminate();
      reject(new Error('WebSocket connection timed out'));
    }, timeoutMilliseconds);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };

    try {
      socket = factory(websocketEndpoint(baseUrl), {
        open: () => {
          socket?.close(1000, 'connectivity test complete');
          finish();
        },
        message: () => undefined,
        close: () => finish(new Error('WebSocket closed before connecting')),
        error: (error) => finish(error),
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
