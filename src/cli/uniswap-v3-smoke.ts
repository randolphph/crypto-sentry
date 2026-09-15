import { z } from 'zod';

import {
  ROBINHOOD_UNISWAP_V3,
  UniswapV3PositionReader,
} from '../adapters/uniswap/uniswap-v3-position-reader.js';
import { UniswapV4PositionReader } from '../adapters/uniswap/uniswap-v4-position-reader.js';

const smokeEnvironmentSchema = z.object({
  UNISWAP_SMOKE_RPC_URL: z.url(),
  UNISWAP_SMOKE_VERSION: z.enum(['v3', 'v4']).default('v3'),
  UNISWAP_SMOKE_TOKEN_ID: z.string().regex(/^\d+$/),
  UNISWAP_SMOKE_TIMEOUT_MILLISECONDS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
});

async function main(): Promise<void> {
  const environment = smokeEnvironmentSchema.parse(process.env);
  const options = {
    rpcUrl: environment.UNISWAP_SMOKE_RPC_URL,
    expectedChainId: ROBINHOOD_UNISWAP_V3.chainId,
    timeoutMilliseconds: environment.UNISWAP_SMOKE_TIMEOUT_MILLISECONDS,
  };
  const reader = environment.UNISWAP_SMOKE_VERSION === 'v3'
    ? new UniswapV3PositionReader(options)
    : new UniswapV4PositionReader(options);
  const position = await reader.read(environment.UNISWAP_SMOKE_TOKEN_ID);
  process.stdout.write(`${JSON.stringify({ ok: true, position }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  process.stderr.write(`Uniswap live smoke test failed (${errorName})\n`);
  process.exitCode = 1;
});
