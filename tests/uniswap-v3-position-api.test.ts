import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
import {
  ROBINHOOD_UNISWAP_V3,
  type UniswapV3Position,
} from '../src/adapters/uniswap/uniswap-v3-position-reader.js';
import {
  ROBINHOOD_UNISWAP_V4,
  type UniswapV4Position,
} from '../src/adapters/uniswap/uniswap-v4-position-reader.js';
import type { AppConfig } from '../src/config.js';
import type {
  UniswapV3PositionReaderFactory,
  UniswapV4OwnershipIndexerFactory,
  UniswapV4PositionReaderFactory,
} from '../src/core/integrations/uniswap-v3-position-coordinator.js';

const token = 'uniswap-test-api-token-that-is-long-enough';
const authorization = { authorization: `Bearer ${token}` };
const config: AppConfig = {
  databasePath: ':memory:',
  apiToken: token,
  masterEncryptionKey: Buffer.alloc(32, 4),
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
};
const position: UniswapV3Position = {
  protocol: 'uniswap',
  version: 'v3',
  chainId: 4_663,
  chainName: 'Robinhood Chain',
  blockNumber: '54321',
  tokenId: '42',
  owner: '0x0000000000000000000000000000000000001234',
  positionManagerAddress: ROBINHOOD_UNISWAP_V3.positionManagerAddress,
  poolAddress: '0x0000000000000000000000000000000000000030',
  token0: { address: '0x0000000000000000000000000000000000000010', symbol: 'USDG', decimals: 6 },
  token1: { address: '0x0000000000000000000000000000000000000020', symbol: 'WETH', decimals: 18 },
  feeTier: 500,
  tickLower: -100,
  tickUpper: 100,
  currentTick: 0,
  liquidity: '1000000',
  inRange: true,
  tokensOwed0: '1.5',
  tokensOwed1: '2',
};
const v4Position: UniswapV4Position = {
  protocol: 'uniswap',
  version: 'v4',
  chainId: 4_663,
  chainName: 'Robinhood Chain',
  blockNumber: '54321',
  tokenId: '9',
  owner: '0x0000000000000000000000000000000000001234',
  positionManagerAddress: ROBINHOOD_UNISWAP_V4.positionManagerAddress,
  poolManagerAddress: ROBINHOOD_UNISWAP_V4.poolManagerAddress,
  stateViewAddress: ROBINHOOD_UNISWAP_V4.stateViewAddress,
  poolId: `0x${'1'.repeat(64)}`,
  token0: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18, native: true },
  token1: { address: '0x0000000000000000000000000000000000000020', symbol: 'WETH', decimals: 18, native: false },
  feeTier: 3_000,
  lpFee: 3_000,
  protocolFee: 0,
  tickSpacing: 60,
  hooks: '0x0000000000000000000000000000000000000000',
  tickLower: -120,
  tickUpper: 120,
  currentTick: 0,
  liquidity: '2000000',
  inRange: true,
};

describe('Robinhood Uniswap V3 position monitor API', () => {
  let app: FastifyInstance;
  const read = vi.fn(async () => position);
  const v4Read = vi.fn(async () => v4Position);
  const readerFactory: UniswapV3PositionReaderFactory = {
    create: () => ({
      discover: async () => ({ blockNumber: 54_321n, tokenIds: ['42'] }),
      read,
    }),
  };
  const v4ReaderFactory: UniswapV4PositionReaderFactory = { create: () => ({ read: v4Read }) };
  const v4OwnershipIndexerFactory: UniswapV4OwnershipIndexerFactory = {
    create: () => ({
      sync: async () => ({
        tokenIds: ['9'],
        scannedThroughBlock: 54_321n,
        chainTipBlock: 54_321n,
        caughtUp: true,
      }),
    }),
  };

  beforeEach(async () => {
    read.mockClear();
    v4Read.mockClear();
    app = await createApp({
      config,
      logger: false,
      webSocketFactory: false,
      uniswapV3PositionReaderFactory: readerFactory,
      uniswapV4PositionReaderFactory: v4ReaderFactory,
      uniswapV4OwnershipIndexerFactory: v4OwnershipIndexerFactory,
      pollingMinimumIntervalMilliseconds: 1,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function createRobinhoodRpc(): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: authorization,
      payload: {
        name: 'Robinhood Chain',
        type: 'evm_rpc',
        provider: 'custom',
        config: { chainId: 4_663, rpcUrl: 'https://rpc.mainnet.chain.robinhood.com' },
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  it('uses official contracts and publishes a structured position snapshot', async () => {
    const rpcIntegrationId = await createRobinhoodRpc();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: authorization,
      payload: {
        name: 'Robinhood Uniswap LP #42',
        type: 'lp_position',
        intervalSeconds: 5,
        config: { protocol: 'uniswap', version: 'v3', chainId: 4_663, tokenId: '42', rpcIntegrationId },
      },
    });
    expect(created.statusCode).toBe(201);
    const monitorId = created.json<{ id: string }>().id;

    await vi.waitFor(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/monitors/${monitorId}/uniswap-position`,
        headers: authorization,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        monitorId,
        status: 'ok',
        position: {
          chainId: 4_663,
          chainName: 'Robinhood Chain',
          tokenId: '42',
          token0: { symbol: 'USDG', decimals: 6 },
          token1: { symbol: 'WETH', decimals: 18 },
          feeTier: 500,
          currentTick: 0,
          tickLower: -100,
          tickUpper: 100,
          liquidity: '1000000',
          inRange: true,
          tokensOwed0: '1.5',
          tokensOwed1: '2',
        },
      });
    });
    expect(read).toHaveBeenCalledWith('42', expect.any(AbortSignal), undefined);
  });

  it('rejects unsupported networks, versions, and manual contract addresses', async () => {
    const rpcIntegrationId = await createRobinhoodRpc();
    for (const configOverride of [
      { chainId: 1 },
      { version: 'v5' },
      { positionManagerAddress: '0x0000000000000000000000000000000000000001' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/monitors',
        headers: authorization,
        payload: {
          name: 'Unsupported LP',
          type: 'lp_position',
          config: {
            protocol: 'uniswap',
            version: 'v3',
            chainId: 4_663,
            tokenId: '42',
            rpcIntegrationId,
            ...configOverride,
          },
        },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('discovers V3 positions from a wallet and returns a collection snapshot', async () => {
    const rpcIntegrationId = await createRobinhoodRpc();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: authorization,
      payload: {
        name: 'Robinhood V3 wallet',
        type: 'lp_position',
        intervalSeconds: 5,
        config: {
          protocol: 'uniswap',
          version: 'v3',
          chainId: 4_663,
          walletAddress: position.owner,
          rpcIntegrationId,
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const monitorId = created.json<{ id: string }>().id;

    await vi.waitFor(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/monitors/${monitorId}/uniswap-positions`,
        headers: authorization,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        walletAddress: position.owner,
        version: 'v3',
        status: 'ok',
        summary: { positionCount: 1, failedPositionCount: 0 },
        positions: [{ tokenId: '42', version: 'v3', inRange: true }],
      });
    });
    const legacy = await app.inject({
      method: 'GET',
      url: `/api/v1/monitors/${monitorId}/uniswap-position`,
      headers: authorization,
    });
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json()).toMatchObject({ error: { code: 'USE_COLLECTION_ENDPOINT' } });
  });

  it('discovers and reads V4 wallet positions', async () => {
    const rpcIntegrationId = await createRobinhoodRpc();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: authorization,
      payload: {
        name: 'Robinhood V4 wallet',
        type: 'lp_position',
        intervalSeconds: 5,
        config: {
          protocol: 'uniswap',
          version: 'v4',
          chainId: 4_663,
          walletAddress: v4Position.owner,
          rpcIntegrationId,
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const monitorId = created.json<{ id: string }>().id;

    await vi.waitFor(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/monitors/${monitorId}/uniswap-positions`,
        headers: authorization,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        walletAddress: v4Position.owner,
        version: 'v4',
        status: 'ok',
        discovery: { caughtUp: true, scannedThroughBlock: '54321', chainTipBlock: '54321' },
        positions: [{
          tokenId: '9',
          version: 'v4',
          poolId: v4Position.poolId,
          tickSpacing: 60,
          hooksAddress: v4Position.hooks,
          liquidity: '2000000',
          inRange: true,
        }],
      });
    });
    expect(v4Read).toHaveBeenCalledWith('9', expect.any(AbortSignal), 54_321n);
  });

  it('returns an explicit error snapshot when the RPC position read fails', async () => {
    read.mockRejectedValueOnce(new Error('RPC unavailable'));
    const rpcIntegrationId = await createRobinhoodRpc();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: authorization,
      payload: {
        name: 'Unavailable Robinhood Uniswap LP',
        type: 'lp_position',
        intervalSeconds: 5,
        config: { protocol: 'uniswap', version: 'v3', chainId: 4_663, tokenId: '99', rpcIntegrationId },
      },
    });
    const monitorId = created.json<{ id: string }>().id;

    await vi.waitFor(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/monitors/${monitorId}/uniswap-position`,
        headers: authorization,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        monitorId,
        status: 'error',
        position: null,
        error: {
          code: 'UNISWAP_POSITION_READ_FAILED',
          message: 'The Uniswap positions could not be fully read from the configured RPC',
        },
      });
    });
  });
});
