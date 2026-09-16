export interface RuleMetricDefinition {
  id: string;
  name: string;
  kind: 'gauge' | 'event';
  valueType: 'decimal' | 'boolean';
  operators: Array<'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'>;
  units: string[];
  requiresWindow: boolean;
  windowSecondsMin?: number;
  windowSecondsMax?: number;
  monitorTypes: string[];
  marketTypes?: Array<'spot' | 'perpetual'>;
  chainIds?: number[];
  versions?: Array<'v3' | 'v4'>;
  labels: string[];
}

const numericOperators: RuleMetricDefinition['operators'] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];
const booleanOperators: RuleMetricDefinition['operators'] = ['eq', 'neq'];

export const MARKET_RULE_METRICS: RuleMetricDefinition[] = [
  {
    id: 'price', name: '价格', kind: 'gauge', valueType: 'decimal', operators: numericOperators,
    units: ['quote_asset'], requiresWindow: false, monitorTypes: ['market'], marketTypes: ['spot', 'perpetual'],
    labels: ['marketType', 'providerSymbol', 'canonicalSymbol', 'priceType'],
  },
  {
    id: 'price_change_percent', name: '价格涨跌幅', kind: 'gauge', valueType: 'decimal', operators: numericOperators,
    units: ['percent'], requiresWindow: true, windowSecondsMin: 5, windowSecondsMax: 1_800,
    monitorTypes: ['market'], marketTypes: ['spot', 'perpetual'],
    labels: ['marketType', 'providerSymbol', 'canonicalSymbol', 'priceType', 'windowSeconds'],
  },
  {
    id: 'base_volume_24h', name: '24 小时基础资产成交量', kind: 'gauge', valueType: 'decimal', operators: numericOperators,
    units: ['base_asset'], requiresWindow: false, monitorTypes: ['market'], marketTypes: ['spot', 'perpetual'],
    labels: ['marketType', 'providerSymbol', 'canonicalSymbol', 'baseAsset', 'quoteAsset'],
  },
  {
    id: 'quote_volume_24h', name: '24 小时报价资产成交额', kind: 'gauge', valueType: 'decimal', operators: numericOperators,
    units: ['quote_asset'], requiresWindow: false, monitorTypes: ['market'], marketTypes: ['spot', 'perpetual'],
    labels: ['marketType', 'providerSymbol', 'canonicalSymbol', 'baseAsset', 'quoteAsset'],
  },
  {
    id: 'funding_rate_percent', name: '资金费率', kind: 'gauge', valueType: 'decimal', operators: numericOperators,
    units: ['percent'], requiresWindow: false, monitorTypes: ['market'], marketTypes: ['perpetual'],
    labels: ['marketType', 'providerSymbol', 'canonicalSymbol'],
  },
  {
    id: 'next_funding_time', name: '下次资金费时间', kind: 'gauge', valueType: 'decimal', operators: numericOperators,
    units: ['unix_milliseconds'], requiresWindow: false, monitorTypes: ['market'], marketTypes: ['perpetual'],
    labels: ['marketType', 'providerSymbol', 'canonicalSymbol'],
  },
  {
    id: 'open_interest', name: '未平仓量', kind: 'gauge', valueType: 'decimal', operators: numericOperators,
    units: ['contracts'], requiresWindow: false, monitorTypes: ['market'], marketTypes: ['perpetual'],
    labels: ['marketType', 'providerSymbol', 'canonicalSymbol'],
  },
  {
    id: 'open_interest_change_percent', name: '未平仓量变化率', kind: 'gauge', valueType: 'decimal', operators: numericOperators,
    units: ['percent'], requiresWindow: true, windowSecondsMin: 5, windowSecondsMax: 1_800,
    monitorTypes: ['market'], marketTypes: ['perpetual'],
    labels: ['marketType', 'providerSymbol', 'canonicalSymbol', 'windowSeconds'],
  },
  {
    id: 'data_age_seconds', name: '数据年龄', kind: 'gauge', valueType: 'decimal', operators: numericOperators,
    units: ['seconds'], requiresWindow: false, monitorTypes: ['market'], marketTypes: ['spot', 'perpetual'],
    labels: ['marketType', 'providerSymbol', 'canonicalSymbol', 'priceType'],
  },
];

function aaveGauge(
  id: string,
  name: string,
  units: string[],
  options: { valueType?: 'decimal' | 'boolean'; window?: boolean; labels?: string[] } = {},
): RuleMetricDefinition {
  return {
    id, name, kind: 'gauge', valueType: options.valueType ?? 'decimal',
    operators: options.valueType === 'boolean' ? booleanOperators : numericOperators,
    units, requiresWindow: options.window ?? false,
    ...(options.window === true ? { windowSecondsMin: 5, windowSecondsMax: 86_400 } : {}),
    monitorTypes: ['aave_account'], chainIds: [1],
    labels: ['chainId', 'chainName', ...(options.window === true ? ['windowSeconds'] : []), ...(options.labels ?? [])],
  };
}

function aaveAccountEvent(id: string, name: string): RuleMetricDefinition {
  return {
    id, name, kind: 'event', valueType: 'decimal', operators: numericOperators,
    units: ['token'], requiresWindow: false, monitorTypes: ['aave_account'], chainIds: [1],
    labels: ['eventType', 'chainId', 'reserveAssetAddress', 'symbol', 'user', 'onBehalfOf', 'repayer', 'to', 'liquidator'],
  };
}

function aaveAccountBooleanEvent(id: string, name: string): RuleMetricDefinition {
  return {
    ...aaveAccountEvent(id, name), valueType: 'boolean', operators: booleanOperators, units: ['boolean'],
  };
}

export const AAVE_ACCOUNT_RULE_METRICS: RuleMetricDefinition[] = [
  aaveGauge('health_factor', '健康因子', ['ratio']),
  aaveGauge('health_factor_infinite', '健康因子无限', ['boolean'], { valueType: 'boolean' }),
  aaveGauge('total_collateral_base', '总抵押价值', ['base_currency']),
  aaveGauge('total_debt_base', '总债务价值', ['base_currency']),
  aaveGauge('available_borrows_base', '可借额度', ['base_currency']),
  aaveGauge('supplied_amount', '资产供应量', ['token'], { labels: ['symbol', 'assetAddress'] }),
  aaveGauge('total_debt_amount', '资产债务量', ['token'], { labels: ['symbol', 'assetAddress'] }),
  aaveGauge('usage_as_collateral', '作为抵押品', ['boolean'], { valueType: 'boolean', labels: ['symbol', 'assetAddress'] }),
  aaveGauge('total_collateral_change_base', '抵押变化额', ['base_currency'], { window: true }),
  aaveGauge('total_collateral_change_percent', '抵押变化率', ['percent'], { window: true }),
  aaveGauge('total_debt_change_base', '债务变化额', ['base_currency'], { window: true }),
  aaveGauge('total_debt_change_percent', '债务变化率', ['percent'], { window: true }),
  aaveAccountEvent('account_supply', '账户供应事件'),
  aaveAccountEvent('account_withdraw', '账户提取事件'),
  aaveAccountEvent('account_borrow', '账户借款事件'),
  aaveAccountEvent('account_repay', '账户还款事件'),
  aaveAccountEvent('account_liquidation', '账户清算事件'),
  aaveAccountBooleanEvent('account_position_opened', '账户仓位开启'),
  aaveAccountBooleanEvent('account_position_closed', '账户仓位关闭'),
];

export const AAVE_POOL_RULE_METRICS: RuleMetricDefinition[] = [
  {
    id: 'aave_event_amount_token', name: 'Aave 事件 Token 数量', kind: 'event', valueType: 'decimal',
    operators: numericOperators, units: ['token'], requiresWindow: false, monitorTypes: ['aave_pool'], chainIds: [1],
    labels: ['eventType', 'chainId', 'reserveAssetAddress', 'symbol', 'user', 'onBehalfOf', 'repayer', 'to', 'liquidator'],
  },
  {
    id: 'aave_event_amount_usd', name: 'Aave 事件 USD 金额', kind: 'event', valueType: 'decimal',
    operators: numericOperators, units: ['USD'], requiresWindow: false, monitorTypes: ['aave_pool'], chainIds: [1],
    labels: ['eventType', 'chainId', 'reserveAssetAddress', 'symbol', 'user', 'onBehalfOf', 'repayer', 'to', 'liquidator'],
  },
];

function uniswapGauge(
  id: string, name: string, units: string[], monitorTypes: string[],
  options: { boolean?: boolean; window?: boolean; versions?: Array<'v3' | 'v4'>; aggregate?: boolean } = {},
): RuleMetricDefinition {
  const poolMetric = monitorTypes.includes('uniswap_pool');
  const identityLabels = poolMetric
    ? ['resourceId', 'token0Address', 'token0Symbol', 'token1Address', 'token1Symbol']
    : options.aggregate === true
      ? []
      : ['tokenId', 'token0Address', 'token0Symbol', 'token1Address', 'token1Symbol'];
  return {
    id, name, kind: 'gauge', valueType: options.boolean === true ? 'boolean' : 'decimal',
    operators: options.boolean === true ? booleanOperators : numericOperators,
    units, requiresWindow: options.window ?? false,
    ...(options.window === true ? { windowSecondsMin: 20, windowSecondsMax: 86_400 } : {}),
    monitorTypes, chainIds: [1, 4_663], versions: options.versions ?? ['v3', 'v4'],
    labels: ['chainId', 'version', ...identityLabels, ...(options.window === true ? ['windowSeconds'] : [])],
  };
}

function uniswapEvent(id: string, name: string, versions: Array<'v3' | 'v4'> = ['v3', 'v4']): RuleMetricDefinition {
  return {
    id, name, kind: 'event', valueType: 'decimal', operators: numericOperators, units: ['token'], requiresWindow: false,
    monitorTypes: ['uniswap_pool'], chainIds: [1, 4_663], versions,
    labels: ['chainId', 'version', 'resourceId', 'eventType', 'token0Address', 'token0Symbol', 'token1Address', 'token1Symbol'],
  };
}

export const UNISWAP_POSITION_RULE_METRICS: RuleMetricDefinition[] = [
  uniswapGauge('in_range', '是否在价格区间', ['boolean'], ['uniswap_position', 'uniswap_wallet'], { boolean: true }),
  uniswapGauge('current_tick', '当前 Tick', ['tick'], ['uniswap_position', 'uniswap_wallet']),
  uniswapGauge('tick_lower', '区间下界 Tick', ['tick'], ['uniswap_position', 'uniswap_wallet']),
  uniswapGauge('tick_upper', '区间上界 Tick', ['tick'], ['uniswap_position', 'uniswap_wallet']),
  uniswapGauge('distance_to_lower_tick', '距下界 Tick', ['tick'], ['uniswap_position', 'uniswap_wallet']),
  uniswapGauge('distance_to_upper_tick', '距上界 Tick', ['tick'], ['uniswap_position', 'uniswap_wallet']),
  uniswapGauge('distance_to_nearest_boundary_percent', '距最近边界', ['percent'], ['uniswap_position', 'uniswap_wallet']),
  uniswapGauge('liquidity', '流动性', ['liquidity'], ['uniswap_position', 'uniswap_wallet']),
  uniswapGauge('token0_amount', 'Token0 数量', ['token0'], ['uniswap_position', 'uniswap_wallet']),
  uniswapGauge('token1_amount', 'Token1 数量', ['token1'], ['uniswap_position', 'uniswap_wallet']),
  uniswapGauge('fees_owed_token0', 'Token0 待领取手续费', ['token0'], ['uniswap_position', 'uniswap_wallet'], { versions: ['v3'] }),
  uniswapGauge('fees_owed_token1', 'Token1 待领取手续费', ['token1'], ['uniswap_position', 'uniswap_wallet'], { versions: ['v3'] }),
  uniswapGauge('position_value_usd', '仓位 USD 价值', ['USD'], ['uniswap_position', 'uniswap_wallet']),
  uniswapGauge('fees_value_usd', '手续费 USD 价值', ['USD'], ['uniswap_position', 'uniswap_wallet'], { versions: ['v3'] }),
  uniswapGauge('position_closed', '仓位已关闭', ['boolean'], ['uniswap_position', 'uniswap_wallet'], { boolean: true }),
  uniswapGauge('position_count', '仓位数', ['positions'], ['uniswap_position', 'uniswap_wallet'], { aggregate: true }),
  uniswapGauge('in_range_count', '钱包区间内仓位数', ['positions'], ['uniswap_wallet'], { aggregate: true }),
  uniswapGauge('out_of_range_count', '钱包区间外仓位数', ['positions'], ['uniswap_wallet'], { aggregate: true }),
  uniswapGauge('failed_position_count', '钱包读取失败仓位数', ['positions'], ['uniswap_wallet'], { aggregate: true }),
  uniswapGauge('aggregate_value_usd', '钱包仓位总价值', ['USD'], ['uniswap_wallet'], { aggregate: true }),
  uniswapGauge('aggregate_fees_usd', '钱包手续费总价值', ['USD'], ['uniswap_wallet'], { versions: ['v3'], aggregate: true }),
];

export const UNISWAP_POOL_RULE_METRICS: RuleMetricDefinition[] = [
  uniswapGauge('current_tick', '当前 Tick', ['tick'], ['uniswap_pool']),
  uniswapGauge('token0_price', 'Token0 价格', ['token1'], ['uniswap_pool']),
  uniswapGauge('token1_price', 'Token1 价格', ['token0'], ['uniswap_pool']),
  uniswapGauge('active_liquidity', '活跃流动性', ['liquidity'], ['uniswap_pool']),
  uniswapGauge('tvl_token0', 'Token0 TVL', ['token0'], ['uniswap_pool'], { versions: ['v3'] }),
  uniswapGauge('tvl_token1', 'Token1 TVL', ['token1'], ['uniswap_pool'], { versions: ['v3'] }),
  uniswapGauge('tvl_usd', 'Pool TVL USD', ['USD'], ['uniswap_pool'], { versions: ['v3'] }),
  uniswapGauge('volume_token0', '窗口 Token0 成交量', ['token0'], ['uniswap_pool'], { window: true }),
  uniswapGauge('volume_token1', '窗口 Token1 成交量', ['token1'], ['uniswap_pool'], { window: true }),
  uniswapGauge('volume_usd', '窗口 USD 成交额', ['USD'], ['uniswap_pool'], { window: true }),
  uniswapGauge('volume_change_percent', '窗口成交额变化率', ['percent'], ['uniswap_pool'], { window: true }),
  uniswapEvent('swap', 'Swap 事件'), uniswapEvent('mint', '增加流动性事件'),
  uniswapEvent('burn', '移除流动性事件'), uniswapEvent('fee_collection', '领取手续费事件', ['v3']),
];

export const RULE_METRICS = {
  market: MARKET_RULE_METRICS,
  aave_account: AAVE_ACCOUNT_RULE_METRICS,
  aave_pool: AAVE_POOL_RULE_METRICS,
  uniswap_position: UNISWAP_POSITION_RULE_METRICS.filter((definition) => definition.monitorTypes.includes('uniswap_position')),
  uniswap_wallet: UNISWAP_POSITION_RULE_METRICS.filter((definition) => definition.monitorTypes.includes('uniswap_wallet')),
  uniswap_pool: UNISWAP_POOL_RULE_METRICS,
} as const;

export function ruleMetricDefinition(monitorType: string, metricId: string): RuleMetricDefinition | undefined {
  const normalized = monitorType === 'aave_position' ? 'aave_account' : monitorType;
  const definitions = RULE_METRICS[normalized as keyof typeof RULE_METRICS] as readonly RuleMetricDefinition[] | undefined;
  return definitions?.find((metric) => metric.id === metricId && metric.monitorTypes.includes(normalized));
}
