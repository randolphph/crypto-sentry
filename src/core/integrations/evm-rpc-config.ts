import { z } from 'zod';

export const RPC_TIMEOUT_DEFAULT = 5_000;
export const RPC_MULTICALL_BATCH_DEFAULT = 8_192;

const chainIdSchema = z.number().int().positive();
const headersSchema = z.record(z.string().min(1), z.string());

export const evmRpcRoutingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fixed') }).strict(),
  z.object({
    mode: z.literal('url_template'),
    chainIdPlaceholder: z.string().min(1).default('{chainId}'),
  }).strict(),
  z.object({
    mode: z.literal('header'),
    headerName: z.string().trim().min(1),
    valueTemplate: z.string().min(1).default('{chainId}'),
  }).strict(),
  z.object({
    mode: z.literal('query'),
    parameterName: z.string().trim().min(1),
  }).strict(),
]);

const currentConfigSchema = z.object({
  rpcUrl: z.string().min(1),
  chainIds: z.array(chainIdSchema).min(1).max(50).transform((values) => [...new Set(values)]),
  routing: evmRpcRoutingSchema,
  headers: headersSchema.optional(),
  timeoutMilliseconds: z.number().int().min(1_000).max(60_000).default(RPC_TIMEOUT_DEFAULT),
  multicallBatchSizeBytes: z.number().int().min(1_024).max(100_000).default(RPC_MULTICALL_BATCH_DEFAULT),
}).strict().superRefine((config, context) => {
  if (config.routing.mode === 'fixed' && config.chainIds.length !== 1) {
    context.addIssue({ code: 'custom', path: ['chainIds'], message: 'fixed routing requires exactly one chainId' });
  }
  if (config.routing.mode === 'url_template') {
    const placeholder = config.routing.chainIdPlaceholder;
    if (!config.rpcUrl.includes(placeholder)) {
      context.addIssue({ code: 'custom', path: ['rpcUrl'], message: `rpcUrl must contain ${placeholder}` });
    } else {
      for (const chainId of config.chainIds) {
        try {
          const url = new URL(config.rpcUrl.split(placeholder).join(String(chainId)));
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
        } catch {
          context.addIssue({ code: 'custom', path: ['rpcUrl'], message: `Template does not produce a valid URL for chain ${chainId}` });
          break;
        }
      }
    }
  } else {
    try {
      const url = new URL(config.rpcUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    } catch {
      context.addIssue({ code: 'custom', path: ['rpcUrl'], message: 'Expected an HTTP(S) URL' });
    }
  }
});

const legacyConfigSchema = z.object({
  chainId: chainIdSchema,
  rpcUrl: z.string().min(1),
  timeoutMilliseconds: z.number().int().min(1_000).max(60_000).default(RPC_TIMEOUT_DEFAULT),
  multicallBatchSizeBytes: z.number().int().min(1_024).max(100_000).default(RPC_MULTICALL_BATCH_DEFAULT),
}).strict();

export type EvmRpcRouting = z.infer<typeof evmRpcRoutingSchema>;
export type EvmRpcIntegrationConfig = z.infer<typeof currentConfigSchema>;

export function normalizeEvmRpcConfig(input: unknown): EvmRpcIntegrationConfig {
  const current = currentConfigSchema.safeParse(input);
  if (current.success) return current.data;

  const legacy = legacyConfigSchema.safeParse(input);
  if (legacy.success) {
    return {
      rpcUrl: legacy.data.rpcUrl,
      chainIds: [legacy.data.chainId],
      routing: { mode: 'fixed' },
      timeoutMilliseconds: legacy.data.timeoutMilliseconds,
      multicallBatchSizeBytes: legacy.data.multicallBatchSizeBytes,
    };
  }
  throw current.error;
}

export const rpcIntegrationConfigSchema = z.any().transform((input, context): EvmRpcIntegrationConfig => {
  try {
    return normalizeEvmRpcConfig(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      for (const issue of error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      return z.NEVER;
    }
    context.addIssue({ code: 'custom', message: 'Invalid EVM RPC configuration' });
    return z.NEVER;
  }
});

function replaceAll(value: string, placeholder: string, chainId: number): string {
  return value.split(placeholder).join(String(chainId));
}

export interface ResolvedEvmRpcRequest {
  rpcUrl: string;
  headers: Record<string, string>;
}

export function resolveEvmRpcRequest(config: EvmRpcIntegrationConfig, chainId: number): ResolvedEvmRpcRequest {
  if (!config.chainIds.includes(chainId)) throw new Error('RPC_CHAIN_UNSUPPORTED');
  const headers = { ...(config.headers ?? {}) };
  let rpcUrl = config.rpcUrl;

  switch (config.routing.mode) {
    case 'fixed':
      break;
    case 'url_template':
      rpcUrl = replaceAll(rpcUrl, config.routing.chainIdPlaceholder, chainId);
      break;
    case 'header':
      headers[config.routing.headerName] = replaceAll(config.routing.valueTemplate, '{chainId}', chainId);
      break;
    case 'query': {
      const url = new URL(rpcUrl);
      url.searchParams.set(config.routing.parameterName, String(chainId));
      rpcUrl = url.toString();
      break;
    }
  }

  try {
    const finalUrl = new URL(rpcUrl);
    if (!['http:', 'https:'].includes(finalUrl.protocol)) throw new Error('unsupported protocol');
  } catch {
    throw new Error('RPC_ROUTING_CONFIG_INVALID');
  }
  return { rpcUrl, headers };
}
