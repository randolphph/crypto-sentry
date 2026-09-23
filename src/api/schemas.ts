import { z } from 'zod';
import { Decimal } from 'decimal.js';

import { EVM_RPC_PROVIDERS } from '../core/integrations/integration-catalog.js';
import { rpcIntegrationConfigSchema } from '../core/integrations/evm-rpc-config.js';
export { rpcIntegrationConfigSchema } from '../core/integrations/evm-rpc-config.js';

const configRecord = z.record(z.string(), z.unknown());
const enabled = z.boolean();
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Expected an EVM address');
const positiveDecimalString = z.string().refine((value) => {
  try {
    return new Decimal(value).gte(0);
  } catch {
    return false;
  }
}, 'Expected a non-negative decimal string');
const thresholdString = z.string().refine((value) => {
  if (value === 'true' || value === 'false') return true;
  try {
    return new Decimal(value).isFinite();
  } catch {
    return false;
  }
}, 'Expected a decimal or boolean string');
const metricLabelsSchema = z.record(z.string().min(1), z.string().min(1)).refine(
  (labels) => Object.keys(labels).length <= 10,
  'At most 10 metric labels may be selected',
);

export function normalizeBinanceFuturesWebsocketUrl(value: string): string {
  const url = new URL(value);
  if (url.hostname === 'fstream.binance.com' && ['', '/', '/ws', '/stream'].includes(url.pathname)) {
    url.pathname = '/market';
  }
  return url.toString().replace(/\/$/, '');
}

export const binanceIntegrationConfigSchema = z.object({
  restUrl: z.url(),
  futuresRestUrl: z.url().default('https://fapi.binance.com'),
  spotWebsocketUrl: z.url(),
  futuresWebsocketUrl: z.url().default('wss://fstream.binance.com/market'),
}).transform((config) => ({
  ...config,
  futuresWebsocketUrl: normalizeBinanceFuturesWebsocketUrl(config.futuresWebsocketUrl),
}));
export const evmRpcProviderSchema = z.enum(EVM_RPC_PROVIDERS);
const telegramConfigSchema = z.object({ botToken: z.string().min(10), chatId: z.string().min(1) });
export const telegramDiscoverSchema = z.object({ botToken: z.string().min(10) }).strict();
export const marketMonitorConfigSchema = z.object({
  integrationId: z.string().min(1),
  marketType: z.enum(['spot', 'perpetual']),
  providerSymbol: z.string().min(1),
  canonicalSymbol: z.string().min(1).optional(),
  priceType: z.enum(['last', 'mark']).optional(),
}).superRefine((config, context) => {
  if (config.marketType === 'spot' && config.priceType === 'mark') {
    context.addIssue({ code: 'custom', path: ['priceType'], message: 'Spot monitors use the last price' });
  }
  if (config.marketType === 'perpetual' && config.priceType === 'last') {
    context.addIssue({ code: 'custom', path: ['priceType'], message: 'Perpetual monitors use the mark price' });
  }
});
export const aaveMonitorConfigSchema = z.object({
  walletAddress: address,
}).strict();
export const aaveAccountMonitorConfigSchema = z.object({
  rpcIntegrationId: z.string().min(1),
  chainId: z.literal(1),
  walletAddress: address,
}).strict();
export const aavePoolMonitorConfigSchema = z.object({
  rpcIntegrationId: z.string().min(1),
  chainId: z.literal(1),
  reserveAssetAddresses: z.array(address).default([]).transform((values) => [...new Set(values.map((value) => value.toLowerCase()))]),
}).strict();
const lpBase = {
  protocol: z.literal('uniswap'),
  chainId: z.literal(4_663),
  rpcIntegrationId: z.string().min(1),
};
const lpWalletTarget = { walletAddress: address };
const lpTokenTarget = { tokenId: z.string().regex(/^\d+$/) };
export const lpMonitorConfigSchema = z.union([
  z.object({ ...lpBase, version: z.literal('v3'), ...lpWalletTarget }).strict(),
  z.object({ ...lpBase, version: z.literal('v3'), ...lpTokenTarget }).strict(),
  z.object({ ...lpBase, version: z.literal('v4'), ...lpWalletTarget }).strict(),
  z.object({ ...lpBase, version: z.literal('v4'), ...lpTokenTarget }).strict(),
]);
export const uniswapPositionMonitorConfigSchema = z.object({
  rpcIntegrationId: z.string().min(1),
  chainId: z.number().int().positive(),
  version: z.enum(['v3', 'v4']),
  tokenId: z.string().regex(/^\d+$/),
}).strict();
export const uniswapWalletMonitorConfigSchema = z.object({
  rpcIntegrationId: z.string().min(1),
  chainIds: z.array(z.number().int().positive()).min(1).transform((values) => [...new Set(values)]),
  versions: z.array(z.enum(['v3', 'v4'])).min(1).transform((values) => [...new Set(values)]),
  walletAddress: address,
}).strict();
export const uniswapPoolMonitorConfigSchema = z.object({
  rpcIntegrationId: z.string().min(1),
  chainId: z.number().int().positive(),
  version: z.enum(['v3', 'v4']),
  poolAddress: address.optional(),
  poolId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
}).strict().superRefine((config, context) => {
  if (config.version === 'v3' && config.poolAddress === undefined) {
    context.addIssue({ code: 'custom', path: ['poolAddress'], message: 'V3 pools require poolAddress' });
  }
  if (config.version === 'v3' && config.poolId !== undefined) {
    context.addIssue({ code: 'custom', path: ['poolId'], message: 'V3 pools do not use poolId' });
  }
  if (config.version === 'v4' && config.poolId === undefined) {
    context.addIssue({ code: 'custom', path: ['poolId'], message: 'V4 pools require poolId' });
  }
  if (config.version === 'v4' && config.poolAddress !== undefined) {
    context.addIssue({ code: 'custom', path: ['poolAddress'], message: 'V4 pools do not use poolAddress' });
  }
});

export const monitorTypeSchema = z.enum([
  'market',
  'aave_account',
  'aave_pool',
  'uniswap_position',
  'uniswap_pool',
  'uniswap_wallet',
  'aave_position',
  'lp_position',
]).describe('Monitor type. aave_position and lp_position are legacy/deprecated but remain readable and runnable.');
export type MonitorType = z.infer<typeof monitorTypeSchema>;

export const idParamsSchema = z.object({ id: z.string().min(1) });

export const integrationCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    type: z.enum(['market_data', 'evm_rpc', 'notification']),
    provider: z.string().trim().min(1).max(60),
    enabled: enabled.default(true),
    config: configRecord,
  })
  .superRefine((value, context) => {
    const supported =
      (value.type === 'market_data' && value.provider === 'binance') ||
      (value.type === 'evm_rpc' && evmRpcProviderSchema.safeParse(value.provider).success) ||
      (value.type === 'notification' && value.provider === 'telegram');
    if (!supported) context.addIssue({ code: 'custom', path: ['provider'], message: 'Unsupported integration type/provider combination' });
    const expectedConfig =
      value.type === 'market_data' && value.provider === 'binance' ? binanceIntegrationConfigSchema :
      value.type === 'evm_rpc' && evmRpcProviderSchema.safeParse(value.provider).success ? rpcIntegrationConfigSchema :
      value.type === 'notification' && value.provider === 'telegram' ? telegramConfigSchema : undefined;
    if (expectedConfig !== undefined) {
      const parsedConfig = expectedConfig.safeParse(value.config);
      if (!parsedConfig.success) {
        for (const issue of parsedConfig.error.issues) {
          context.addIssue({ code: 'custom', path: ['config', ...issue.path], message: issue.message });
        }
      }
    }
  });

export const integrationPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    enabled: enabled.optional(),
    config: configRecord.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

const monitorBaseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: monitorTypeSchema,
  enabled: enabled.default(true),
  intervalSeconds: z.number().int().min(5).max(86_400).default(20),
  maxStaleSeconds: z.number().int().min(5).max(86_400).default(90),
  config: configRecord,
});

export function monitorConfigSchema(type: MonitorType): z.ZodType {
  switch (type) {
    case 'market': return marketMonitorConfigSchema;
    case 'aave_account': return aaveAccountMonitorConfigSchema;
    case 'aave_pool': return aavePoolMonitorConfigSchema;
    case 'uniswap_position': return uniswapPositionMonitorConfigSchema;
    case 'uniswap_wallet': return uniswapWalletMonitorConfigSchema;
    case 'uniswap_pool': return uniswapPoolMonitorConfigSchema;
    case 'aave_position': return aaveMonitorConfigSchema;
    case 'lp_position': return lpMonitorConfigSchema;
  }
}

export function validateMonitorConfig(type: MonitorType, config: Record<string, unknown>): void {
  monitorConfigSchema(type).parse(config);
}

export const monitorCreateSchema = monitorBaseSchema.superRefine((value, context) => {
  const expected = monitorConfigSchema(value.type);
  const parsedConfig = expected.safeParse(value.config);
  if (!parsedConfig.success) {
    for (const issue of parsedConfig.error.issues) {
      context.addIssue({ code: 'custom', path: ['config', ...issue.path], message: issue.message });
    }
  }
});

export const monitorPatchSchema = monitorBaseSchema
  .omit({ type: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const ruleConditionSchema = z.object({
  metric: z.string().trim().min(1).max(120),
  labels: metricLabelsSchema.default({}),
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']),
  threshold: thresholdString,
  windowSeconds: z.number().int().min(1).max(86_400).optional(),
  hysteresis: positiveDecimalString.default('0'),
}).superRefine((value, context) => {
  if ((value.threshold === 'true' || value.threshold === 'false') && !['eq', 'neq'].includes(value.operator)) {
    context.addIssue({ code: 'custom', path: ['operator'], message: 'Boolean thresholds only support eq and neq' });
  }
});

const ruleGroupMetadataSchema = z.object({
  monitorId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  durationSeconds: z.number().int().min(0).max(86_400).default(0),
  cooldownSeconds: z.number().int().min(0).max(604_800).default(1800),
  severity: z.enum(['info', 'warning', 'critical', 'emergency']),
  notificationIntegrationIds: z.array(z.string().min(1)).default([]),
  enabled: enabled.default(true),
});

export const ruleGroupCreateSchema = ruleGroupMetadataSchema.extend({
  combinator: z.enum(['and', 'or']).default('and'),
  conditions: z.array(ruleConditionSchema).min(1).max(20),
});

const legacyRuleCreateSchema = ruleGroupMetadataSchema.extend({
  metric: z.string().trim().min(1).max(120),
  labels: metricLabelsSchema.default({}),
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']),
  threshold: thresholdString,
  windowSeconds: z.number().int().min(1).max(86_400).optional(),
  hysteresis: positiveDecimalString.default('0'),
}).superRefine((value, context) => {
  const parsed = ruleConditionSchema.safeParse(value);
  if (!parsed.success) for (const issue of parsed.error.issues) {
    context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }
});

export const aaveRiskRulePresetSchema = z.object({
  warningThreshold: positiveDecimalString.default('1.2'),
  criticalThreshold: positiveDecimalString.default('1.05'),
  warningDurationSeconds: z.number().int().min(0).max(86_400).default(60),
  criticalDurationSeconds: z.number().int().min(0).max(86_400).default(0),
  cooldownSeconds: z.number().int().min(0).max(604_800).default(1800),
  notificationIntegrationIds: z.array(z.string().min(1)).default([]),
}).superRefine((value, context) => {
  if (new Decimal(value.warningThreshold).lte(value.criticalThreshold)) {
    context.addIssue({
      code: 'custom',
      path: ['warningThreshold'],
      message: 'warningThreshold must be greater than criticalThreshold',
    });
  }
});

export const ruleCreateSchema = z.union([ruleGroupCreateSchema, legacyRuleCreateSchema]).transform((value) => (
  'conditions' in value ? value : {
    monitorId: value.monitorId,
    name: value.name,
    combinator: 'and' as const,
    conditions: [{
      metric: value.metric,
      labels: value.labels,
      operator: value.operator,
      threshold: value.threshold,
      ...(value.windowSeconds === undefined ? {} : { windowSeconds: value.windowSeconds }),
      hysteresis: value.hysteresis,
    }],
    durationSeconds: value.durationSeconds,
    cooldownSeconds: value.cooldownSeconds,
    severity: value.severity,
    notificationIntegrationIds: value.notificationIntegrationIds,
    enabled: value.enabled,
  }
));

const rulePatchMetadataSchema = ruleGroupMetadataSchema.omit({ monitorId: true }).partial();
export const rulePatchSchema = rulePatchMetadataSchema.extend({
  combinator: z.enum(['and', 'or']).optional(),
  conditions: z.array(ruleConditionSchema).min(1).max(20).optional(),
  metric: z.string().trim().min(1).max(120).optional(),
  labels: metricLabelsSchema.optional(),
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']).optional(),
  threshold: thresholdString.optional(),
  windowSeconds: z.number().int().min(1).max(86_400).optional(),
  hysteresis: positiveDecimalString.optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const alertListQuerySchema = listQuerySchema.extend({
  status: z.enum(['open', 'acknowledged', 'resolved']).optional(),
  after: z.iso.datetime({ offset: true }).optional(),
});

export type IntegrationCreate = z.infer<typeof integrationCreateSchema>;
export type IntegrationPatch = z.infer<typeof integrationPatchSchema>;
export type MonitorCreate = z.infer<typeof monitorCreateSchema>;
export type MonitorPatch = z.infer<typeof monitorPatchSchema>;
export type RuleCreate = z.input<typeof ruleCreateSchema>;
export type NormalizedRuleCreate = z.output<typeof ruleCreateSchema>;
export type RulePatch = z.input<typeof rulePatchSchema>;
export type AaveRiskRulePreset = z.infer<typeof aaveRiskRulePresetSchema>;
