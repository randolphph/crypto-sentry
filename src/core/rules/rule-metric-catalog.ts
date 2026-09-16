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

export const RULE_METRICS = {
  market: MARKET_RULE_METRICS,
  aave_account: AAVE_ACCOUNT_RULE_METRICS,
  aave_pool: AAVE_POOL_RULE_METRICS,
} as const;

export function ruleMetricDefinition(monitorType: string, metricId: string): RuleMetricDefinition | undefined {
  const normalized = monitorType === 'aave_position' ? 'aave_account' : monitorType;
  const definitions = RULE_METRICS[normalized as keyof typeof RULE_METRICS] as readonly RuleMetricDefinition[] | undefined;
  return definitions?.find((metric) => metric.id === metricId);
}
