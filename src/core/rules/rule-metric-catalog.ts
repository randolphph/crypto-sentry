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

export const RULE_METRICS = { market: MARKET_RULE_METRICS } as const;

export function ruleMetricDefinition(monitorType: string, metricId: string): RuleMetricDefinition | undefined {
  if (monitorType !== 'market') return undefined;
  return MARKET_RULE_METRICS.find((metric) => metric.id === metricId);
}
