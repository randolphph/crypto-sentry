import { EvmRpcClient } from '../../adapters/evm/evm-rpc-client.js';
import { UniswapV3PositionReader } from '../../adapters/uniswap/uniswap-v3-position-reader.js';
import { UniswapV4PositionReader } from '../../adapters/uniswap/uniswap-v4-position-reader.js';
import { PancakeV3PositionReader } from '../../adapters/pancake/pancake-v3-position-reader.js';
import { BSC_PANCAKE_V3 } from '../../adapters/pancake/pancake-v3-position-reader.js';
import { UniswapPoolReader } from '../../adapters/uniswap/uniswap-pool-reader.js';
import { AppError } from '../../api/errors.js';
import {
  rpcIntegrationConfigSchema,
  uniswapPoolMonitorConfigSchema,
  uniswapPositionMonitorConfigSchema,
  pancakePoolMonitorConfigSchema,
  pancakePositionMonitorConfigSchema,
  pancakeWalletMonitorConfigSchema,
} from '../../api/schemas.js';
import type { MonitorCreate, MonitorPatch } from '../../api/schemas.js';
import type { IntegrationNetworkHealthRepository } from '../../db/repositories/integration-network-health-repository.js';
import type { IntegrationRepository } from '../../db/repositories/integration-repository.js';
import type { MonitorRepository } from '../../db/repositories/monitor-repository.js';
import { resolveEvmRpcRequest } from '../integrations/evm-rpc-config.js';
import type {
  UniswapV3PositionReaderFactory,
  UniswapV4PositionReaderFactory,
} from '../integrations/uniswap-v3-position-coordinator.js';
import type { UniswapPoolReaderFactory } from '../integrations/uniswap-pool-coordinator.js';

export class MonitorService {
  private readonly v3Factory: UniswapV3PositionReaderFactory;
  private readonly v4Factory: UniswapV4PositionReaderFactory;
  private readonly pancakeV3Factory: UniswapV3PositionReaderFactory;
  private readonly pancakePoolFactory: UniswapPoolReaderFactory;

  public constructor(
    private readonly monitors: MonitorRepository,
    private readonly integrations: IntegrationRepository,
    private readonly health: IntegrationNetworkHealthRepository,
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
    options: {
      v3Factory?: UniswapV3PositionReaderFactory;
      v4Factory?: UniswapV4PositionReaderFactory;
      pancakeV3Factory?: UniswapV3PositionReaderFactory;
      pancakePoolFactory?: UniswapPoolReaderFactory;
    } = {},
  ) {
    this.v3Factory = options.v3Factory ?? { create: (readerOptions) => new UniswapV3PositionReader({
      ...readerOptions, fetch: this.fetchImplementation,
    }) };
    this.v4Factory = options.v4Factory ?? { create: (readerOptions) => new UniswapV4PositionReader({
      ...readerOptions, fetch: this.fetchImplementation,
    }) };
    this.pancakeV3Factory = options.pancakeV3Factory ?? { create: (readerOptions) => new PancakeV3PositionReader({
      ...readerOptions, fetch: this.fetchImplementation,
    }) };
    this.pancakePoolFactory = options.pancakePoolFactory ?? { create: (readerOptions) => new UniswapPoolReader({
      ...readerOptions, fetch: this.fetchImplementation,
    }) };
  }

  public async create(input: MonitorCreate) {
    if (input.type === 'uniswap_position') {
      await this.validateUniswapPosition(uniswapPositionMonitorConfigSchema.parse(input.config));
    }
    if (input.type === 'uniswap_pool') {
      this.validateUniswapCapability(uniswapPoolMonitorConfigSchema.parse(input.config));
    }
    if (input.type === 'pancake_position') {
      await this.validatePancakePosition(pancakePositionMonitorConfigSchema.parse(input.config));
    }
    if (input.type === 'pancake_pool') {
      await this.validatePancakePool(pancakePoolMonitorConfigSchema.parse(input.config));
    }
    if (input.type === 'pancake_wallet') {
      const config = pancakeWalletMonitorConfigSchema.parse(input.config);
      this.validatePancakeCapability({ rpcIntegrationId: config.rpcIntegrationId, chainId: 56, version: 'v3' });
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
    if (current.type === 'uniswap_pool' && input.config !== undefined) {
      const before = uniswapPoolMonitorConfigSchema.parse(current.config);
      const after = uniswapPoolMonitorConfigSchema.parse({ ...current.config, ...input.config });
      if (before.rpcIntegrationId !== after.rpcIntegrationId || before.chainId !== after.chainId ||
        before.version !== after.version || before.poolAddress !== after.poolAddress || before.poolId !== after.poolId) {
        this.validateUniswapCapability(after);
      }
    }
    if (current.type === 'pancake_position' && input.config !== undefined) {
      const before = pancakePositionMonitorConfigSchema.parse(current.config);
      const after = pancakePositionMonitorConfigSchema.parse({ ...current.config, ...input.config });
      if (before.rpcIntegrationId !== after.rpcIntegrationId || before.tokenId !== after.tokenId) {
        await this.validatePancakePosition(after);
      }
    }
    if (current.type === 'pancake_pool' && input.config !== undefined) {
      const before = pancakePoolMonitorConfigSchema.parse(current.config);
      const after = pancakePoolMonitorConfigSchema.parse({ ...current.config, ...input.config });
      if (before.rpcIntegrationId !== after.rpcIntegrationId || before.poolAddress !== after.poolAddress) {
        await this.validatePancakePool(after);
      }
    }
    if (current.type === 'pancake_wallet' && input.config !== undefined) {
      const before = pancakeWalletMonitorConfigSchema.parse(current.config);
      const after = pancakeWalletMonitorConfigSchema.parse({ ...current.config, ...input.config });
      if (before.rpcIntegrationId !== after.rpcIntegrationId) {
        this.validatePancakeCapability({ rpcIntegrationId: after.rpcIntegrationId, chainId: 56, version: 'v3' });
      }
    }
    return this.monitors.update(id, input);
  }

  private validateUniswapCapability(config: { rpcIntegrationId: string; chainId: number; version: 'v3' | 'v4' }): void {
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
  }

  private async validateUniswapPosition(config: {
    rpcIntegrationId: string; chainId: number; version: 'v3' | 'v4'; tokenId: string;
  }): Promise<void> {
    this.validateUniswapCapability(config);
    const integration = this.integrations.getRuntime(config.rpcIntegrationId);
    const rpc = rpcIntegrationConfigSchema.parse(integration.config);
    const resolved = resolveEvmRpcRequest(rpc, config.chainId);
    const options = {
      rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: config.chainId,
      timeoutMilliseconds: rpc.timeoutMilliseconds,
      multicallBatchSizeBytes: rpc.multicallBatchSizeBytes,
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

  private validatePancakeCapability(config: { rpcIntegrationId: string; chainId: 56; version: 'v3' }): void {
    const integration = this.integrations.getRuntime(config.rpcIntegrationId);
    if (!integration.enabled || integration.type !== 'evm_rpc') {
      throw new AppError(400, 'INVALID_MONITOR_CONFIG', 'An enabled EVM RPC integration is required');
    }
    const rpc = rpcIntegrationConfigSchema.parse(integration.config);
    if (!rpc.chainIds.includes(56)) throw new AppError(400, 'RPC_CHAIN_UNSUPPORTED', 'The selected RPC does not cover BNB Smart Chain');
    const health = this.health.get(config.rpcIntegrationId, 56);
    if (health?.rpcStatus !== 'ok' || health.pancakeV3Status !== 'ok') {
      throw new AppError(409, 'PROTOCOL_NOT_READY', 'Test PancakeSwap V3 on the selected BNB Smart Chain RPC before creating this monitor');
    }
  }

  private async validatePancakePosition(config: { rpcIntegrationId: string; chainId: 56; version: 'v3'; tokenId: string }): Promise<void> {
    this.validatePancakeCapability(config);
    const integration = this.integrations.getRuntime(config.rpcIntegrationId);
    const rpc = rpcIntegrationConfigSchema.parse(integration.config);
    const resolved = resolveEvmRpcRequest(rpc, 56);
    const options = {
      rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: 56,
      timeoutMilliseconds: rpc.timeoutMilliseconds, multicallBatchSizeBytes: rpc.multicallBatchSizeBytes,
    };
    try {
      const position = await this.pancakeV3Factory.create(options).read(config.tokenId);
      if (position.protocol !== 'pancakeswap' || position.chainId !== 56 || position.version !== 'v3' || position.tokenId !== config.tokenId) {
        throw new AppError(404, 'POSITION_NOT_FOUND', 'The tokenId is not a PancakeSwap V3 position on BNB Smart Chain');
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      try {
        await new EvmRpcClient({ ...options, fetch: this.fetchImplementation }).testConnectivity();
      } catch {
        throw new AppError(502, 'RPC_CONNECTION_FAILED', 'The selected RPC could not validate this position');
      }
      throw new AppError(404, 'POSITION_NOT_FOUND', 'The PancakeSwap V3 position was not found');
    }
  }

  private async validatePancakePool(config: { rpcIntegrationId: string; chainId: 56; version: 'v3'; poolAddress: string }): Promise<void> {
    this.validatePancakeCapability(config);
    const integration = this.integrations.getRuntime(config.rpcIntegrationId);
    const rpc = rpcIntegrationConfigSchema.parse(integration.config);
    const resolved = resolveEvmRpcRequest(rpc, 56);
    try {
      const reader = this.pancakePoolFactory.create({
        rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: 56,
        timeoutMilliseconds: rpc.timeoutMilliseconds, expectedV3FactoryAddress: BSC_PANCAKE_V3.factoryAddress,
      });
      if (reader.describeV3 === undefined) throw new Error('Pool metadata reader is unavailable');
      await reader.describeV3(config.poolAddress);
    } catch {
      try {
        await new EvmRpcClient({
          rpcUrl: resolved.rpcUrl, headers: resolved.headers, expectedChainId: 56,
          timeoutMilliseconds: rpc.timeoutMilliseconds, fetch: this.fetchImplementation,
        }).testConnectivity();
      } catch {
        throw new AppError(502, 'RPC_CONNECTION_FAILED', 'The selected RPC could not validate this pool');
      }
      throw new AppError(404, 'POOL_NOT_FOUND', 'The address is not an official PancakeSwap V3 pool');
    }
  }
}
