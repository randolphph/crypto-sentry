import { z } from 'zod';
import { Decimal } from 'decimal.js';

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
const rpcConfigSchema = z.object({ chainId: z.number().int().positive(), rpcUrl: z.url() });
const telegramConfigSchema = z.object({ botToken: z.string().min(10), chatId: z.string().min(1) });
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
const aaveMonitorConfigSchema = z.object({
  chainId: z.number().int().positive(),
  walletAddress: address,
  poolAddress: address,
  rpcIntegrationId: z.string().min(1),
});
const lpMonitorConfigSchema = z.object({
  protocol: z.enum(['uniswap', 'pancakeswap']),
  version: z.enum(['v3', 'v4']),
  chainId: z.number().int().positive(),
  tokenId: z.string().regex(/^\d+$/),
  positionManagerAddress: address,
  stateViewAddress: address.optional(),
  rpcIntegrationId: z.string().min(1),
}).superRefine((config, context) => {
  if (config.version === 'v4' && config.stateViewAddress === undefined) {
    context.addIssue({ code: 'custom', path: ['stateViewAddress'], message: 'Required for Uniswap V4' });
  }
  if (config.protocol === 'pancakeswap' && config.version !== 'v3') {
    context.addIssue({ code: 'custom', path: ['version'], message: 'PancakeSwap only supports V3 in the first release' });
  }
});

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
      (value.type === 'evm_rpc' && value.provider === 'custom') ||
      (value.type === 'notification' && value.provider === 'telegram');
    if (!supported) context.addIssue({ code: 'custom', path: ['provider'], message: 'Unsupported integration type/provider combination' });
    const expectedConfig =
      value.type === 'market_data' && value.provider === 'binance' ? binanceIntegrationConfigSchema :
      value.type === 'evm_rpc' && value.provider === 'custom' ? rpcConfigSchema :
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
  type: z.enum(['market', 'aave_position', 'lp_position']),
  enabled: enabled.default(true),
  intervalSeconds: z.number().int().min(5).max(86_400).default(20),
  maxStaleSeconds: z.number().int().min(5).max(86_400).default(90),
  config: configRecord,
});

export function validateMonitorConfig(type: 'market' | 'aave_position' | 'lp_position', config: Record<string, unknown>): void {
  const expected = type === 'market' ? marketMonitorConfigSchema : type === 'aave_position' ? aaveMonitorConfigSchema : lpMonitorConfigSchema;
  expected.parse(config);
}

export const monitorCreateSchema = monitorBaseSchema.superRefine((value, context) => {
  const expected = value.type === 'market' ? marketMonitorConfigSchema : value.type === 'aave_position' ? aaveMonitorConfigSchema : lpMonitorConfigSchema;
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

const ruleBaseSchema = z.object({
  monitorId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  metric: z.string().trim().min(1).max(120),
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']),
  threshold: thresholdString,
  windowSeconds: z.number().int().min(1).max(86_400).optional(),
  durationSeconds: z.number().int().min(0).max(86_400).default(0),
  cooldownSeconds: z.number().int().min(0).max(604_800).default(1800),
  hysteresis: positiveDecimalString.default('0'),
  severity: z.enum(['info', 'warning', 'critical', 'emergency']),
  notificationIntegrationIds: z.array(z.string().min(1)).default([]),
  enabled: enabled.default(true),
});

export const ruleCreateSchema = ruleBaseSchema.superRefine((value, context) => {
  if ((value.threshold === 'true' || value.threshold === 'false') && !['eq', 'neq'].includes(value.operator)) {
    context.addIssue({ code: 'custom', path: ['operator'], message: 'Boolean thresholds only support eq and neq' });
  }
  if (value.metric === 'price_change_percent' && value.windowSeconds === undefined) {
    context.addIssue({ code: 'custom', path: ['windowSeconds'], message: 'Price change rules require a window' });
  }
  if (value.metric === 'price_change_percent' && (value.windowSeconds ?? 0) > 1_800) {
    context.addIssue({ code: 'custom', path: ['windowSeconds'], message: 'Price change windows cannot exceed the 30 minute sample retention' });
  }
});

export const rulePatchSchema = ruleBaseSchema
  .omit({ monitorId: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

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
export type RuleCreate = z.infer<typeof ruleCreateSchema>;
export type RulePatch = z.infer<typeof rulePatchSchema>;
