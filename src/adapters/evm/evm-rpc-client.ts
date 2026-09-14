import { createPublicClient, http } from 'viem';
import type { PublicClient } from 'viem';

export interface EvmRpcClientOptions {
  rpcUrl: string;
  expectedChainId: number;
  fetch?: typeof globalThis.fetch;
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
  return createPublicClient({
    transport: http(options.rpcUrl, {
      retryCount: 0,
      timeout: options.timeoutMilliseconds ?? 5_000,
      ...(options.fetch === undefined ? {} : { fetchFn: options.fetch }),
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
