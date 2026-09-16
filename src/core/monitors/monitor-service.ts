import { EvmRpcClient } from '../../adapters/evm/evm-rpc-client.js';
import { UniswapV3PositionReader } from '../../adapters/uniswap/uniswap-v3-position-reader.js';
import { UniswapV4PositionReader } from '../../adapters/uniswap/uniswap-v4-position-reader.js';
import { AppError } from '../../api/errors.js';
import { rpcIntegrationConfigSchema, uniswapPositionMonitorConfigSchema } from '../../api/schemas.js';
import type { MonitorCreate, MonitorPatch } from '../../api/schemas.js';
import type { IntegrationNetworkHealthRepository } from '../../db/repositories/integration-network-health-repository.js';
import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import { resolveEvmRpcRequest } from '../integrations/evm-rpc-config.js';
import type {
  UniswapV3PositionReaderFactory,
  UniswapV4PositionReaderFactory,
} from '../integrations/uniswap-v3-position-coordinator.js';

export class MonitorService {
  private readonly v3Factory: UniswapV3PositionReaderFactory;
  private readonly v4Factory: UniswapV4PositionReaderFactory;

  public constructor(
    private readonly monitors: MonitorRepository,
    private readonly integrations: IntegrationRepository,
    private readonly health: IntegrationNetworkHealthRepository,
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
    options: {
      v3Factory?: UniswapV3PositionReaderFactory;
      v4Factory?: UniswapV4PositionReaderFactory;
    } = {},
  ) {
    this.v3Factory = options.v3Factory ?? { create: (readerOptions) => new UniswapV3PositionReader({
      ...readerOptions, fetch: this.fetchImplementation,
    }) };
    this.v4Factory = options.v4Factory ?? { create: (readerOptions) => new UniswapV4PositionReader({
      ...readerOptions, fetch: this.fetchImplementation,
    }) };
  }

  public async create(input: MonitorCreate) {
    if (input.type === 'uniswap_position') {
      await this.validateUniswapPosition(uniswapPositionMonitorConfigSchema.parse(input.config));
    }
    return this.monitors.create(input);
  }

  public async update(id: string, input: MonitorPatch) {
    const current = this.monitors.get(id);
    if (current.type === 'uniswap_position' && input.config !== undefined) {
      const before = uniswapPositionMonitorConfigSchema.parse(current.config);
      const after = uniswapPositionMonitorConfigSchema.parse({ ...current.config, ...input.config });
      if (before.rpcIntegrationId !== after.rpcIntegrationId || before.chainId !== after.chainId ||
        before.version !== after.version || before.tokenId !== after.tokenId) {
        await this.validateUniswapPosition(after);
      }
    }
    return this.monitors.update(id, input);
  }

  private async validateUniswapPosition(config: {
    rpcIntegrationId: string; chainId: number; version: 'v3' | 'v4'; tokenId: string;
  }): Promise<void> {
    const integration = this.integrations.getRuntime(config.rpcIntegrationId);
    if (!integration.enabled || integration.type !== 'evm_rpc') {
      throw new AppError(400, 'INVALID_MONITOR_CONFIG', 'An enabled EVM RPC integration is required');
    }
    const rpc = rpcIntegrationConfigSchema.parse(integration.config);
    if (!rpc.chainIds.includes(config.chainId)) {
      throw new AppError(400, 'RPC_CHAIN_UNSUPPORTED', 'The selected RPC does not cover this chain');
    }
    const health = this.health.get(config.rpcIntegrationId, config.chainId);
    const capability = config.version === 'v3' ? health?.uniswapV3Status : health?.uniswapV4Status;
    if (health?.rpcStatus !== 'ok' || capability !== 'ok') {
      throw new AppError(409, 'PROTOCOL_NOT_READY', 'Test the selected Uniswap network and version before creating this monitor');
    }
    const resolved = resolveEvmRpcRequest(rpc, config.chainId);
    const options = {
      rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: config.chainId,
      timeoutMilliseconds: rpc.timeoutMilliseconds,
    };
    try {
      const position = config.version === 'v3'
        ? await this.v3Factory.create(options).read(config.tokenId)
        : await this.v4Factory.create(options).read(config.tokenId);
      if (position.chainId !== config.chainId || position.version !== config.version || position.tokenId !== config.tokenId) {
        throw new AppError(404, 'POSITION_NOT_FOUND', 'The tokenId does not belong to the selected chain and version');
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      try {
        await new EvmRpcClient({ ...options, fetch: this.fetchImplementation }).testConnectivity();
      } catch {
        throw new AppError(502, 'RPC_CONNECTION_FAILED', 'The selected RPC could not validate this position');
      }
      throw new AppError(404, 'POSITION_NOT_FOUND', 'The Uniswap position was not found');
    }
  }
}
