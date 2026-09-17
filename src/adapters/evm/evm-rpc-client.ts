import { createPublicClient, http } from 'viem';
import type { PublicClient } from 'viem';

type RpcFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RpcHttpRequestLog {
  methods: string[];
  durationMilliseconds: number;
  statusCode: number | null;
  ok: boolean;
  errorName?: string;
}

export type RpcHttpRequestLogger = (event: RpcHttpRequestLog) => void;

const MAX_CONCURRENT_RPC_REQUESTS = 8;

class RpcRequestLimiter {
  private active = 0;
  private readonly queue: Array<{
    task: () => Promise<Response>;
    resolve: (response: Response) => void;
    reject: (error: unknown) => void;
  }> = [];

  public constructor(private readonly maximumConcurrency: number) {}

  public run(task: () => Promise<Response>): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.maximumConcurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      if (item === undefined) return;
      this.active += 1;
      void item.task().then(item.resolve, item.reject).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }
}

const requestLimiters = new Map<string, RpcRequestLimiter>();

function jsonRpcMethods(init: RequestInit | undefined): string[] {
  if (typeof init?.body !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(init.body);
    if (Array.isArray(parsed)) {
      return parsed.flatMap((item: unknown) => (
        typeof item === 'object' && item !== null && 'method' in item && typeof item.method === 'string'
          ? [item.method]
          : []
      ));
    }
    return typeof parsed === 'object' && parsed !== null && 'method' in parsed && typeof parsed.method === 'string'
      ? [parsed.method]
      : [];
  } catch {
    return [];
  }
}

/**
 * Adds safe JSON-RPC request observability without logging URL, headers or params.
 * Only JSON-RPC requests are observed; Binance REST and other HTTP traffic passes through.
 */
export function createRpcObservabilityFetch(
  fetchImplementation: RpcFetch,
  logger: RpcHttpRequestLogger,
): RpcFetch {
  return async (input, init) => {
    const methods = jsonRpcMethods(init);
    if (methods.length === 0) return fetchImplementation(input, init);
    const startedAt = Date.now();
    try {
      const response = await fetchImplementation(input, init);
      logger({
        methods,
        durationMilliseconds: Math.max(0, Date.now() - startedAt),
        statusCode: response.status,
        ok: response.ok,
      });
      return response;
    } catch (error) {
      logger({
        methods,
        durationMilliseconds: Math.max(0, Date.now() - startedAt),
        statusCode: null,
        ok: false,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
  };
}

function limiterKey(rpcUrl: string, headers: Record<string, string> | undefined): string {
  const headerFingerprint = Object.entries(headers ?? {}).sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}`).join('|');
  return `${rpcUrl}|${headerFingerprint}`;
}

function limitedFetch(rpcUrl: string, headers: Record<string, string> | undefined, fetchImplementation: RpcFetch): RpcFetch {
  const key = limiterKey(rpcUrl, headers);
  const limiter = requestLimiters.get(key) ?? new RpcRequestLimiter(MAX_CONCURRENT_RPC_REQUESTS);
  requestLimiters.set(key, limiter);
  return (input, init) => limiter.run(() => fetchImplementation(input, init));
}

export interface EvmRpcClientOptions {
  rpcUrl: string;
  expectedChainId: number;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  timeoutMilliseconds?: number;
}

export interface EvmRpcProbeResult {
  chainId: number;
  blockNumber: string;
}

export class EvmRpcError extends Error {
  public constructor(message = 'EVM RPC request failed', cause?: unknown) {
    super(message, { cause });
    this.name = 'EvmRpcError';
  }
}

export class EvmChainMismatchError extends EvmRpcError {
  public constructor(
    public readonly expectedChainId: number,
    public readonly actualChainId: number,
  ) {
    super(`EVM RPC chain ID mismatch: expected ${expectedChainId}, received ${actualChainId}`);
    this.name = 'EvmChainMismatchError';
  }
}

export function createEvmPublicClient(options: EvmRpcClientOptions): PublicClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return createPublicClient({
    transport: http(options.rpcUrl, {
      retryCount: 2,
      retryDelay: 250,
      timeout: options.timeoutMilliseconds ?? 5_000,
      fetchFn: limitedFetch(options.rpcUrl, options.headers, fetchImplementation),
      ...(options.headers === undefined ? {} : { fetchOptions: { headers: options.headers } }),
    }),
  });
}

export class EvmRpcClient {
  public readonly publicClient: PublicClient;

  public constructor(private readonly options: EvmRpcClientOptions) {
    this.publicClient = createEvmPublicClient(options);
  }

  public async testConnectivity(): Promise<EvmRpcProbeResult> {
    try {
      const chainId = await this.publicClient.getChainId();
      if (chainId !== this.options.expectedChainId) {
        throw new EvmChainMismatchError(this.options.expectedChainId, chainId);
      }
      const blockNumber = await this.publicClient.getBlockNumber({ cacheTime: 0 });
      return { chainId, blockNumber: blockNumber.toString() };
    } catch (error) {
      if (error instanceof EvmChainMismatchError) throw error;
      throw new EvmRpcError('EVM RPC request failed', error);
    }
  }
}
