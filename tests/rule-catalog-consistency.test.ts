import { afterEach, describe, expect, it } from 'vitest';

import { AppError } from '../src/api/errors.js';
import { RULE_METRICS, ruleMetricDefinition } from '../src/core/rules/rule-metric-catalog.js';
import { createDatabase } from '../src/db/client.js';
import type { AppDatabase } from '../src/db/client.js';
import { IntegrationRepository } from '../src/db/repositories/integration-repository.js';
import { MonitorRepository } from '../src/db/repositories/monitor-repository.js';
import { RuleRepository } from '../src/db/repositories/rule-repository.js';
import { UniswapPoolRepository } from '../src/db/repositories/uniswap-pool-repository.js';
import { EncryptionService } from '../src/security/encryption/encryption-service.js';

const databases: AppDatabase[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe('rule metric catalog consistency', () => {
  it('only exposes metrics whose definitions include the requested monitor type', () => {
    for (const [monitorType, definitions] of Object.entries(RULE_METRICS)) {
      for (const definition of definitions) {
        expect(definition.monitorTypes).toContain(monitorType);
        expect(ruleMetricDefinition(monitorType, definition.id)).toBe(definition);
      }
    }
    for (const walletOnly of [
      'in_range_count', 'out_of_range_count', 'failed_position_count', 'aggregate_value_usd', 'aggregate_fees_usd',
    ]) {
      expect(ruleMetricDefinition('uniswap_position', walletOnly)).toBeUndefined();
      expect(ruleMetricDefinition('uniswap_wallet', walletOnly)).toBeDefined();
    }
  });

  it('contains every actionable metric emitted by each current producer', () => {
    const emitted: Record<keyof typeof RULE_METRICS, string[]> = {
      market: [
        'price', 'price_change_percent', 'base_volume_24h', 'quote_volume_24h', 'funding_rate_percent',
        'next_funding_time', 'open_interest', 'open_interest_change_percent', 'data_age_seconds',
      ],
      aave_account: [
        'health_factor', 'health_factor_infinite', 'total_collateral_base', 'total_debt_base',
        'available_borrows_base', 'supplied_amount', 'total_debt_amount', 'usage_as_collateral',
        'total_collateral_change_base', 'total_collateral_change_percent', 'total_debt_change_base',
        'total_debt_change_percent', 'account_supply', 'account_withdraw', 'account_borrow', 'account_repay',
        'account_liquidation', 'account_position_opened', 'account_position_closed',
      ],
      aave_pool: ['aave_event_amount_token', 'aave_event_amount_usd'],
      uniswap_position: [
        'in_range', 'current_tick', 'tick_lower', 'tick_upper', 'distance_to_lower_tick', 'distance_to_upper_tick',
        'distance_to_nearest_boundary_percent', 'liquidity', 'token0_amount', 'token1_amount',
        'fees_owed_token0', 'fees_owed_token1', 'position_value_usd', 'fees_value_usd', 'position_closed',
        'position_count',
      ],
      uniswap_wallet: [
        'in_range', 'current_tick', 'tick_lower', 'tick_upper', 'distance_to_lower_tick', 'distance_to_upper_tick',
        'distance_to_nearest_boundary_percent', 'liquidity', 'token0_amount', 'token1_amount',
        'fees_owed_token0', 'fees_owed_token1', 'position_value_usd', 'fees_value_usd', 'position_closed',
        'position_count', 'in_range_count', 'out_of_range_count', 'failed_position_count',
        'aggregate_value_usd', 'aggregate_fees_usd',
      ],
      uniswap_pool: [
        'current_tick', 'token0_price', 'token1_price', 'active_liquidity', 'tvl_token0', 'tvl_token1',
        'tvl_usd', 'volume_token0', 'volume_token1', 'volume_usd', 'volume_change_percent',
        'swap', 'mint', 'burn', 'fee_collection',
      ],
    };
    for (const [monitorType, metricIds] of Object.entries(emitted)) {
      const catalogIds = new Set(RULE_METRICS[monitorType as keyof typeof RULE_METRICS].map((metric) => metric.id));
      for (const metricId of metricIds) expect(catalogIds, `${monitorType}.${metricId}`).toContain(metricId);
    }
  });

  it('rejects every metric excluded from a monitor catalog and enforces market/version restrictions', () => {
    const database = createDatabase(':memory:');
    databases.push(database);
    const integrations = new IntegrationRepository(database.db, new EncryptionService(Buffer.alloc(32, 3)));
    const marketIntegration = integrations.create({
      name: 'Binance', type: 'market_data', provider: 'binance', enabled: true,
      config: {
        restUrl: 'https://api.binance.com', futuresRestUrl: 'https://fapi.binance.com',
        spotWebsocketUrl: 'wss://stream.binance.com', futuresWebsocketUrl: 'wss://fstream.binance.com',
      },
    });
    const ethereum = integrations.create({
      name: 'Ethereum', type: 'evm_rpc', provider: 'custom', enabled: true,
      config: { chainId: 1, rpcUrl: 'https://eth.invalid' },
    });
    const robinhood = integrations.create({
      name: 'Robinhood', type: 'evm_rpc', provider: 'custom', enabled: true,
      config: { chainId: 4_663, rpcUrl: 'https://hood.invalid' },
    });
    const pools = new UniswapPoolRepository(database.db);
    const poolAddress = '0x00000000000000000000000000000000000000aa';
    pools.upsert({
      integrationId: robinhood.id, chainId: 4_663, version: 'v3', resourceId: poolAddress,
      poolAddress, poolId: null,
      token0Address: '0x0000000000000000000000000000000000000010', token0Symbol: 'USDG',
      token0Decimals: 6, token0Native: false,
      token1Address: '0x0000000000000000000000000000000000000020', token1Symbol: 'WETH',
      token1Decimals: 18, token1Native: false, feeTier: 500, tickSpacing: 10, hooksAddress: null,
      discoveredAtBlock: '1', updatedAt: '2026-09-16T00:00:00.000Z',
    });
    const monitors = new MonitorRepository(database.db, integrations);
    const defaults = { enabled: false as const, intervalSeconds: 20, maxStaleSeconds: 90 };
    const monitorByType = {
      market: monitors.create({
        ...defaults, name: 'Spot', type: 'market',
        config: { integrationId: marketIntegration.id, marketType: 'spot', providerSymbol: 'BTCUSDT' },
      }),
      aave_account: monitors.create({
        ...defaults, name: 'Aave', type: 'aave_account',
        config: { rpcIntegrationId: ethereum.id, chainId: 1, walletAddress: '0x0000000000000000000000000000000000000001' },
      }),
      aave_pool: monitors.create({
        ...defaults, name: 'Aave pool', type: 'aave_pool',
        config: { rpcIntegrationId: ethereum.id, chainId: 1, reserveAssetAddresses: [] },
      }),
      uniswap_position: monitors.create({
        ...defaults, name: 'V4 position', type: 'uniswap_position',
        config: { rpcIntegrationId: robinhood.id, chainId: 4_663, version: 'v4', tokenId: '1' },
      }),
      uniswap_wallet: monitors.create({
        ...defaults, name: 'Wallet', type: 'uniswap_wallet',
        config: {
          rpcIntegrationId: robinhood.id, chainIds: [4_663], versions: ['v3', 'v4'],
          walletAddress: '0x0000000000000000000000000000000000000001',
        },
      }),
      uniswap_pool: monitors.create({
        ...defaults, name: 'Pool', type: 'uniswap_pool',
        config: { rpcIntegrationId: robinhood.id, chainId: 4_663, version: 'v3', poolAddress },
      }),
    };
    const rules = new RuleRepository(database.db);
    const expectCode = (run: () => unknown, code: string) => {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(code);
        return;
      }
      throw new Error(`Expected ${code}`);
    };
    const allMetricIds = new Set(Object.values(RULE_METRICS).flatMap((items) => items.map((item) => item.id)));
    for (const [monitorType, monitor] of Object.entries(monitorByType)) {
      const available = new Set(RULE_METRICS[monitorType as keyof typeof RULE_METRICS].map((item) => item.id));
      for (const metric of allMetricIds) {
        if (available.has(metric)) continue;
        const definition = Object.values(RULE_METRICS).flatMap((items) => [...items]).find((item) => item.id === metric);
        if (definition === undefined) throw new Error(`Missing definition for ${metric}`);
        expectCode(() => rules.create({
          monitorId: monitor.id, name: `Unsupported ${metric}`, combinator: 'and',
          conditions: [{
            metric, labels: {}, operator: 'eq', threshold: definition.valueType === 'boolean' ? 'true' : '1',
            ...(definition.requiresWindow ? { windowSeconds: definition.windowSecondsMin } : {}), hysteresis: '0',
          }],
          durationSeconds: 0, cooldownSeconds: 60, severity: 'warning', notificationIntegrationIds: [], enabled: true,
        }), 'RULE_METRIC_UNSUPPORTED');
      }
    }
    expectCode(() => rules.create({
      monitorId: monitorByType.market.id, name: 'Spot funding', metric: 'funding_rate_percent', labels: {},
      operator: 'gte', threshold: '1', durationSeconds: 0, cooldownSeconds: 60, hysteresis: '0',
      severity: 'warning', notificationIntegrationIds: [], enabled: true,
    }), 'RULE_METRIC_UNSUPPORTED');
    expectCode(() => rules.create({
      monitorId: monitorByType.uniswap_position.id, name: 'V4 fees', metric: 'fees_owed_token0', labels: {},
      operator: 'gte', threshold: '1', durationSeconds: 0, cooldownSeconds: 60, hysteresis: '0',
      severity: 'warning', notificationIntegrationIds: [], enabled: true,
    }), 'RULE_METRIC_UNSUPPORTED');
  });
});
