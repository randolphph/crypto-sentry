import { z } from 'zod';

import { AaveV3PositionReader } from '../adapters/aave/aave-v3-position-reader.js';

const smokeEnvironmentSchema = z.object({
  AAVE_SMOKE_RPC_URL: z.url(),
  AAVE_SMOKE_CHAIN_ID: z.coerce.number().int().positive(),
  AAVE_SMOKE_WALLET_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  AAVE_SMOKE_TIMEOUT_MILLISECONDS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  AAVE_SMOKE_MULTICALL_BATCH_SIZE_BYTES: z.coerce.number().int().min(1_024).max(100_000).default(8_192),
});

async function main(): Promise<void> {
  const environment = smokeEnvironmentSchema.parse(process.env);
  const reader = new AaveV3PositionReader({
    rpcUrl: environment.AAVE_SMOKE_RPC_URL,
    expectedChainId: environment.AAVE_SMOKE_CHAIN_ID,
    timeoutMilliseconds: environment.AAVE_SMOKE_TIMEOUT_MILLISECONDS,
    multicallBatchSizeBytes: environment.AAVE_SMOKE_MULTICALL_BATCH_SIZE_BYTES,
  });
  const position = await reader.read(environment.AAVE_SMOKE_WALLET_ADDRESS);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    chainId: environment.AAVE_SMOKE_CHAIN_ID,
    hasPosition: position !== undefined,
    position: position ?? null,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  process.stderr.write(`Aave V3 live smoke test failed (${errorName})\n`);
  process.exitCode = 1;
});
