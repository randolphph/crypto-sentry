import { and, asc, eq } from 'drizzle-orm';

import { AppError } from '../../api/errors.js';
import {
  aaveMonitorConfigSchema,
  aaveAccountMonitorConfigSchema,
  lpMonitorConfigSchema,
  marketMonitorConfigSchema,
  validateMonitorConfig,
  monitorConfigSchema,
  uniswapPositionMonitorConfigSchema,
  uniswapWalletMonitorConfigSchema,
} from '../../api/schemas.js';
import type { MonitorCreate, MonitorPatch } from '../../api/schemas.js';
import { createId } from '../../core/ids.js';
import type { MonitorRuntimeState, MonitorRuntimeStateStore, RuntimeMonitor } from '../../core/metrics/metric-pipeline.js';
import type { AppDatabase } from '../client.js';
import { integrationMarkets, integrations, monitors, rules } from '../schema/index.js';
import { ruleConditions } from '../schema/index.js';
import type { IntegrationRepository } from './integration-repository.js';
import { normalizeEvmRpcConfig } from '../../core/integrations/evm-rpc-config.js';

export type AaveRuntimeMonitor = {
  monitorId: string;
  intervalSeconds: number;
  maxStaleSeconds: number;
  walletAddress: string;
} & ({ legacy: true } | { legacy: false; rpcIntegrationId: string; chainId: 1 });

export type UniswapRuntimeMonitor = {
  monitorId: string;
  intervalSeconds: number;
  maxStaleSeconds: number;
  rpcIntegrationId: string;
  variants: Array<{ chainId: number; version: 'v3' | 'v4' }>;
} & ({ walletAddress: string } | { tokenId: string });

export class MonitorRepository implements MonitorRuntimeStateStore {
  public constructor(
    private readonly database: AppDatabase['db'],
    private readonly integrationRepository?: IntegrationRepository,
  ) {}

  public list() {
    return this.database.select().from(monitors).orderBy(asc(monitors.createdAt)).all().map(this.present);
  }

  public get(id: string) {
    const row = this.database.select().from(monitors).where(eq(monitors.id, id)).get();
    if (row === undefined) throw new AppError(404, 'MONITOR_NOT_FOUND', 'Monitor was not found');
    return this.present(row);
  }

  public findRuntimeMonitor(id: string): RuntimeMonitor | undefined {
    return this.database
      .select({ id: monitors.id, enabled: monitors.enabled })
      .from(monitors)
      .where(eq(monitors.id, id))
      .get();
  }

  public listEnabledMarketSubscriptions() {
    const windowsByMonitor = new Map<string, { price: number[]; openInterest: number[] }>();
    for (const rule of this.database
      .select({ monitorId: rules.monitorId, metric: ruleConditions.metric, windowSeconds: ruleConditions.windowSeconds })
      .from(ruleConditions)
      .innerJoin(rules, eq(ruleConditions.ruleId, rules.id))
      .where(eq(rules.enabled, true))
      .all()) {
      if (rule.windowSeconds === null || !['price_change_percent', 'open_interest_change_percent'].includes(rule.metric)) continue;
      const windows = windowsByMonitor.get(rule.monitorId) ?? { price: [], openInterest: [] };
      (rule.metric === 'price_change_percent' ? windows.price : windows.openInterest).push(rule.windowSeconds);
      windowsByMonitor.set(rule.monitorId, windows);
    }
    return this.database
      .select({
        id: monitors.id,
        configJson: monitors.configJson,
        intervalSeconds: monitors.intervalSeconds,
        maxStaleSeconds: monitors.maxStaleSeconds,
      })
      .from(monitors)
      .where(and(eq(monitors.enabled, true), eq(monitors.type, 'market')))
      .all()
      .flatMap((row) => {
        const config = marketMonitorConfigSchema.safeParse(JSON.parse(row.configJson));
        if (!config.success) return [];
        const market = this.database.select({
          canonicalSymbol: integrationMarkets.canonicalSymbol,
          baseAsset: integrationMarkets.baseAsset,
          quoteAsset: integrationMarkets.quoteAsset,
        }).from(integrationMarkets).where(and(
          eq(integrationMarkets.integrationId, config.data.integrationId),
          eq(integrationMarkets.marketType, config.data.marketType),
          eq(integrationMarkets.providerSymbol, config.data.providerSymbol),
        )).get();
        const windows = windowsByMonitor.get(row.id) ?? { price: [], openInterest: [] };
        return [{
          monitorId: row.id,
          intervalSeconds: row.intervalSeconds,
          maxStaleSeconds: row.maxStaleSeconds,
          priceWindowSeconds: windows.price,
          openInterestWindowSeconds: windows.openInterest,
          ...(market === undefined ? {} : market),
          ...config.data,
        }];
      });
  }

  public listEnabledAaveMonitors(): AaveRuntimeMonitor[] {
    return this.database
      .select({
        id: monitors.id,
        configJson: monitors.configJson,
        intervalSeconds: monitors.intervalSeconds,
        maxStaleSeconds: monitors.maxStaleSeconds,
      })
      .from(monitors)
      .where(eq(monitors.enabled, true))
      .all()
      .flatMap<AaveRuntimeMonitor>((row) => {
        const raw: unknown = JSON.parse(row.configJson);
        const legacy = aaveMonitorConfigSchema.safeParse(raw);
        const current = aaveAccountMonitorConfigSchema.safeParse(raw);
        return legacy.success ? [{
          monitorId: row.id,
          intervalSeconds: row.intervalSeconds,
          maxStaleSeconds: row.maxStaleSeconds,
          ...legacy.data,
          legacy: true as const,
        }] : current.success ? [{
          monitorId: row.id,
          intervalSeconds: row.intervalSeconds,
          maxStaleSeconds: row.maxStaleSeconds,
          ...current.data,
          legacy: false as const,
        }] : [];
      });
  }

  public listEnabledUniswapMonitors(): UniswapRuntimeMonitor[] {
    return this.database
      .select({
        id: monitors.id,
        configJson: monitors.configJson,
        intervalSeconds: monitors.intervalSeconds,
        maxStaleSeconds: monitors.maxStaleSeconds,
      })
      .from(monitors)
      .where(eq(monitors.enabled, true))
      .all()
      .flatMap<UniswapRuntimeMonitor>((row) => {
        const raw: unknown = JSON.parse(row.configJson);
        const legacy = lpMonitorConfigSchema.safeParse(raw);
        const position = uniswapPositionMonitorConfigSchema.safeParse(raw);
        const wallet = uniswapWalletMonitorConfigSchema.safeParse(raw);
        return legacy.success ? [{
          monitorId: row.id,
          intervalSeconds: row.intervalSeconds,
          maxStaleSeconds: row.maxStaleSeconds,
          rpcIntegrationId: legacy.data.rpcIntegrationId,
          variants: [{ chainId: legacy.data.chainId, version: legacy.data.version }],
          ...('walletAddress' in legacy.data ? { walletAddress: legacy.data.walletAddress } : { tokenId: legacy.data.tokenId }),
        }] : position.success ? [{
          monitorId: row.id,
          intervalSeconds: row.intervalSeconds,
          maxStaleSeconds: row.maxStaleSeconds,
          rpcIntegrationId: position.data.rpcIntegrationId,
          tokenId: position.data.tokenId,
          variants: [{ chainId: position.data.chainId, version: position.data.version }],
        }] : wallet.success ? [{
          monitorId: row.id,
          intervalSeconds: row.intervalSeconds,
          maxStaleSeconds: row.maxStaleSeconds,
          rpcIntegrationId: wallet.data.rpcIntegrationId,
          walletAddress: wallet.data.walletAddress,
          variants: wallet.data.chainIds.flatMap((chainId) => wallet.data.versions.map((version) => ({ chainId, version }))),
        }] : [];
      });
  }

  public updateRuntimeState(id: string, state: MonitorRuntimeState): void {
    this.database
      .update(monitors)
      .set({
        lastStatus: state.status,
        lastError: state.lastError,
        ...(state.lastDataAt === undefined ? {} : { lastDataAt: state.lastDataAt }),
      })
      .where(eq(monitors.id, id))
      .run();
  }

  public create(input: MonitorCreate) {
    const normalizedConfig = this.validateFinalConfiguration(input.type, input.config);
    const timestamp = new Date().toISOString();
    const row = {
      id: createId('mon'),
      name: input.name,
      type: input.type,
      enabled: input.enabled,
      intervalSeconds: input.intervalSeconds,
      maxStaleSeconds: input.maxStaleSeconds,
      configJson: JSON.stringify(normalizedConfig),
      lastStatus: 'warming_up',
      lastDataAt: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.database.insert(monitors).values(row).run();
    return this.present(row);
  }

  public update(id: string, input: MonitorPatch) {
    const row = this.database.select().from(monitors).where(eq(monitors.id, id)).get();
    if (row === undefined) throw new AppError(404, 'MONITOR_NOT_FOUND', 'Monitor was not found');
    const currentConfig = JSON.parse(row.configJson) as Record<string, unknown>;
    const finalConfig = input.config === undefined ? currentConfig : { ...currentConfig, ...input.config };
    const normalizedConfig = this.validateFinalConfiguration(row.type as MonitorCreate['type'], finalConfig);
    const updated = {
      ...row,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.intervalSeconds === undefined ? {} : { intervalSeconds: input.intervalSeconds }),
      ...(input.maxStaleSeconds === undefined ? {} : { maxStaleSeconds: input.maxStaleSeconds }),
      ...(input.config === undefined ? {} : { configJson: JSON.stringify(normalizedConfig) }),
      updatedAt: new Date().toISOString(),
    };
    this.database.update(monitors).set(updated).where(eq(monitors.id, id)).run();
    return this.present(updated);
  }

  public delete(id: string): void {
    const result = this.database.delete(monitors).where(eq(monitors.id, id)).run();
    if (result.changes === 0) throw new AppError(404, 'MONITOR_NOT_FOUND', 'Monitor was not found');
  }

  private present(this: void, row: typeof monitors.$inferSelect) {
    const { configJson: _, ...publicRow } = row;
    return { ...publicRow, config: JSON.parse(row.configJson) as Record<string, unknown> };
  }

  private validateFinalConfiguration(
    monitorType: MonitorCreate['type'],
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    if (monitorType === 'aave_pool' || monitorType === 'uniswap_pool') {
      throw new AppError(409, 'MONITOR_TYPE_NOT_READY', `${monitorType} is planned but is not runnable yet`);
    }
    const normalized = monitorConfigSchema(monitorType).parse(config) as Record<string, unknown>;
    if ((monitorType === 'uniswap_position' && normalized.chainId !== 4_663) ||
      (monitorType === 'uniswap_wallet' && (normalized.chainIds as number[]).some((chainId) => chainId !== 4_663))) {
      throw new AppError(409, 'PROTOCOL_NOT_READY', 'Ethereum Uniswap monitoring is planned but not implemented');
    }
    this.validateIntegrationReference(monitorType, normalized);
    return normalized;
  }

  private validateIntegrationReference(monitorType: string, config: Record<string, unknown>): void {
    validateMonitorConfig(monitorType as MonitorCreate['type'], config);
    if (monitorType === 'aave_position') {
      const rpcIntegration = this.database
        .select({ id: integrations.id })
        .from(integrations)
        .where(and(eq(integrations.type, 'evm_rpc'), eq(integrations.enabled, true)))
        .get();
      if (rpcIntegration === undefined) {
        throw new AppError(400, 'INVALID_MONITOR_CONFIG', 'At least one enabled evm_rpc integration is required');
      }
      return;
    }
    if (monitorType === 'aave_pool' || monitorType === 'uniswap_pool') return;
    const referenceKey = monitorType === 'market' ? 'integrationId' : 'rpcIntegrationId';
    const integrationId = config[referenceKey];
    if (typeof integrationId !== 'string') {
      throw new AppError(400, 'INVALID_MONITOR_CONFIG', `config.${referenceKey} is required`);
    }
    const integration = this.database.select().from(integrations).where(eq(integrations.id, integrationId)).get();
    const expectedType = monitorType === 'market' ? 'market_data' : 'evm_rpc';
    if (integration === undefined || integration.type !== expectedType || !integration.enabled) {
      throw new AppError(400, 'INVALID_MONITOR_CONFIG', `config.${referenceKey} must reference an enabled ${expectedType} integration`, {
        [referenceKey]: 'Integration was not found or has the wrong type',
      });
    }
    if (expectedType === 'evm_rpc') {
      if (this.integrationRepository === undefined) return;
      const runtime = this.integrationRepository.getRuntime(integrationId);
      const rpc = normalizeEvmRpcConfig(runtime.config);
      const selectedChainIds = monitorType === 'uniswap_wallet'
        ? (config.chainIds as number[])
        : [config.chainId as number];
      const unsupported = selectedChainIds.find((chainId) => !rpc.chainIds.includes(chainId));
      if (unsupported !== undefined) {
        throw new AppError(400, 'RPC_CHAIN_UNSUPPORTED', 'The selected RPC integration does not support every monitor chain', {
          chainId: `Chain ${unsupported} is not configured on integration ${integrationId}`,
        });
      }
    }
  }
}
