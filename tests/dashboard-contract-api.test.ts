import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { AaveV3PositionReaderFactory } from '../src/core/integrations/aave-v3-position-coordinator.js';
import type {
  UniswapV3PositionReaderFactory,
  UniswapV4OwnershipIndexerFactory,
  UniswapV4PositionReaderFactory,
} from '../src/core/integrations/uniswap-v3-position-coordinator.js';
import { ROBINHOOD_UNISWAP_V4 } from '../src/adapters/uniswap/uniswap-v4-position-reader.js';

const token = 'dashboard-contract-api-token-long-enough';
const authorization = { authorization: `Bearer ${token}` };
const config: AppConfig = {
  databasePath: ':memory:', apiToken: token, masterEncryptionKey: Buffer.alloc(32, 2),
  host: '127.0.0.1', port: 3000, logLevel: 'silent',
};
const walletAddress = '0x0000000000000000000000000000000000001234';

describe('Dashboard next-version API contract', () => {
  let app: FastifyInstance;
  const aaveUrls: string[] = [];
  const aaveFactory: AaveV3PositionReaderFactory = {
    create: ({ rpcUrl }) => ({
      read: async () => {
        aaveUrls.push(rpcUrl);
        return {
          chainId: 1, chainName: 'Ethereum', blockNumber: '123', walletAddress,
          baseCurrencySymbol: 'USD', totalCollateralBase: '100', totalDebtBase: '0',
          availableBorrowsBase: '75', liquidationThresholdPercent: '80', ltvPercent: '75',
          healthFactor: '1000000000000000000', assets: [],
        };
      },
    }),
  };
  const v3Factory: UniswapV3PositionReaderFactory = {
    create: () => ({
      discover: async () => { throw new Error('V3 temporarily unavailable'); },
      read: async () => { throw new Error('not reached'); },
    }),
  };
  const v4Indexer: UniswapV4OwnershipIndexerFactory = {
    create: () => ({ sync: async () => ({
      tokenIds: ['9'], scannedThroughBlock: 200n, chainTipBlock: 200n, caughtUp: true,
    }) }),
  };
  const v4Factory: UniswapV4PositionReaderFactory = {
    create: () => ({ read: async () => ({
      protocol: 'uniswap', version: 'v4', chainId: 4_663, chainName: 'Robinhood Chain',
      blockNumber: '200', tokenId: '9', owner: walletAddress,
      positionManagerAddress: ROBINHOOD_UNISWAP_V4.positionManagerAddress,
      poolManagerAddress: ROBINHOOD_UNISWAP_V4.poolManagerAddress,
      stateViewAddress: ROBINHOOD_UNISWAP_V4.stateViewAddress,
      poolId: `0x${'1'.repeat(64)}`, token0: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18, native: true },
      token1: { address: '0x0000000000000000000000000000000000000020', symbol: 'WETH', decimals: 18, native: false },
      feeTier: 3_000, lpFee: 3_000, protocolFee: 0, tickSpacing: 60,
      hooks: '0x0000000000000000000000000000000000000000', tickLower: -60,
      tickUpper: 60, currentTick: 0, liquidity: '123456789012345678901234567890', inRange: true,
    }) }),
  };

  beforeEach(async () => {
    aaveUrls.splice(0);
    app = await createApp({
      config, logger: false, webSocketFactory: false, pollingMinimumIntervalMilliseconds: 1,
      aavePositionReaderFactory: aaveFactory, uniswapV3PositionReaderFactory: v3Factory,
      uniswapV4OwnershipIndexerFactory: v4Indexer, uniswapV4PositionReaderFactory: v4Factory,
    });
  });
  afterEach(async () => app.close());

  async function rpc(name: string, chainId: number, url: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/api/v1/integrations', headers: authorization, payload: {
      name, type: 'evm_rpc', provider: 'custom', config: { chainId, rpcUrl: url },
    } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  it('pins a new Aave account to its selected Ethereum RPC and serves a unified snapshot without rules', async () => {
    await rpc('unused', 1, 'https://unused.example');
    const selected = await rpc('selected', 1, 'https://selected.example');
    const created = await app.inject({ method: 'POST', url: '/api/v1/monitors', headers: authorization, payload: {
      name: 'Aave account', type: 'aave_account', intervalSeconds: 5,
      config: { rpcIntegrationId: selected, chainId: 1, walletAddress },
    } });
    expect(created.statusCode).toBe(201);
    const monitorId = created.json<{ id: string }>().id;
    await vi.waitFor(async () => {
      const response = await app.inject({ method: 'GET', url: `/api/v1/monitors/${monitorId}/snapshot`, headers: authorization });
      expect(response.json()).toMatchObject({
        monitorId, monitorType: 'aave_account', status: 'ok', capability: { available: true },
        data: { positions: [{ account: { healthFactor: null, healthFactorInfinite: true } }] },
      });
    });
    expect(aaveUrls).toContain('https://selected.example');
    expect(aaveUrls).not.toContain('https://unused.example');
  });

  it('merges Robinhood V3/V4 wallet work and retains V4 data when V3 fails', async () => {
    const integrationId = await rpc('Robinhood', 4_663, 'https://robinhood.example');
    const created = await app.inject({ method: 'POST', url: '/api/v1/monitors', headers: authorization, payload: {
      name: 'Uniswap wallet', type: 'uniswap_wallet', intervalSeconds: 5,
      config: { rpcIntegrationId: integrationId, chainIds: [4_663, 4_663], versions: ['v3', 'v4', 'v4'], walletAddress },
    } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ config: { chainIds: [4_663], versions: ['v3', 'v4'] } });
    const monitorId = created.json<{ id: string }>().id;
    await vi.waitFor(async () => {
      const response = await app.inject({ method: 'GET', url: `/api/v1/monitors/${monitorId}/snapshot`, headers: authorization });
      expect(response.json()).toMatchObject({
        monitorType: 'uniswap_wallet', status: 'partial',
        summary: { positionCount: 1 },
        data: { positions: [{ version: 'v4', tokenId: '9', liquidity: '123456789012345678901234567890' }] },
      });
    });
  });

  it('enables Aave pool and requires Uniswap pools to come from the indexed resource catalog', async () => {
    const ethereum = await rpc('Ethereum', 1, 'https://ethereum.example');
    const aavePool = await app.inject({ method: 'POST', url: '/api/v1/monitors', headers: authorization, payload: {
      name: 'Aave pool', type: 'aave_pool', enabled: false, config: { rpcIntegrationId: ethereum, chainId: 1 },
    } });
    expect(aavePool.statusCode).toBe(201);
    expect(aavePool.json()).toMatchObject({ config: { chainId: 1, reserveAssetAddresses: [] } });
    const poolMonitorId = aavePool.json<{ id: string }>().id;
    const invalidEventRule = await app.inject({
      method: 'POST', url: '/api/v1/rules', headers: authorization, payload: {
        monitorId: poolMonitorId, name: 'Large supply', combinator: 'and',
        conditions: [{ metric: 'aave_event_amount_usd', labels: { eventType: 'supply' }, operator: 'gte', threshold: '1000', hysteresis: '0' }],
        durationSeconds: 5, cooldownSeconds: 60, severity: 'warning', notificationIntegrationIds: [], enabled: true,
      },
    });
    expect(invalidEventRule.statusCode).toBe(400);
    expect(invalidEventRule.json()).toMatchObject({ error: { code: 'EVENT_RULE_DURATION_UNSUPPORTED' } });
    const poolSnapshot = await app.inject({
      method: 'GET', url: `/api/v1/monitors/${poolMonitorId}/snapshot`, headers: authorization,
    });
    expect(poolSnapshot.json()).toMatchObject({ monitorType: 'aave_pool', status: 'warming_up', capability: { available: true } });
    const planned = await app.inject({ method: 'POST', url: '/api/v1/monitors', headers: authorization, payload: {
      name: 'Uniswap pool', type: 'uniswap_pool',
      config: { rpcIntegrationId: ethereum, chainId: 1, version: 'v3', poolAddress: walletAddress },
    } });
    expect(planned.statusCode).toBe(404);
    expect(planned.json()).toMatchObject({ error: { code: 'POOL_NOT_FOUND' } });
    const ethereumUniswap = await app.inject({ method: 'POST', url: '/api/v1/monitors', headers: authorization, payload: {
      name: 'Ethereum Uniswap', type: 'uniswap_position',
      config: { rpcIntegrationId: ethereum, chainId: 1, version: 'v3', tokenId: '1' },
    } });
    expect(ethereumUniswap.statusCode).toBe(409);
    expect(ethereumUniswap.json()).toMatchObject({ error: { code: 'PROTOCOL_NOT_READY' } });

    const robinhood = await rpc('Robinhood', 4_663, 'https://robinhood.example');
    const wrongRpc = await app.inject({ method: 'POST', url: '/api/v1/monitors', headers: authorization, payload: {
      name: 'Wrong Aave RPC', type: 'aave_account',
      config: { rpcIntegrationId: robinhood, chainId: 1, walletAddress },
    } });
    expect(wrongRpc.statusCode).toBe(400);
    expect(wrongRpc.json()).toMatchObject({ error: { code: 'RPC_CHAIN_UNSUPPORTED' } });
  });

  it('requires a tested Uniswap capability before creating a position monitor', async () => {
    const robinhood = await rpc('Robinhood update', 4_663, 'https://robinhood-update.example');
    const position = await app.inject({ method: 'POST', url: '/api/v1/monitors', headers: authorization, payload: {
      name: 'Robinhood position', type: 'uniswap_position', enabled: false,
      config: { rpcIntegrationId: robinhood, chainId: 4_663, version: 'v3', tokenId: '11' },
    } });
    expect(position.statusCode).toBe(409);
    expect(position.json()).toMatchObject({ error: { code: 'PROTOCOL_NOT_READY' } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/monitors', headers: authorization })).json())
      .toMatchObject({ items: [] });
  });

  it('rejects a wallet update containing Ethereum and preserves the Robinhood-only config', async () => {
    const robinhood = await rpc('Robinhood wallet update', 4_663, 'https://robinhood-wallet-update.example');
    const created = await app.inject({ method: 'POST', url: '/api/v1/monitors', headers: authorization, payload: {
      name: 'Robinhood wallet update', type: 'uniswap_wallet', enabled: false,
      config: { rpcIntegrationId: robinhood, chainIds: [4_663], versions: ['v3', 'v4'], walletAddress },
    } });
    const monitorId = created.json<{ id: string }>().id;

    const rejected = await app.inject({
      method: 'PATCH', url: `/api/v1/monitors/${monitorId}`, headers: authorization,
      payload: { config: { chainIds: [4_663, 1] } },
    });

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ error: { code: 'RPC_CHAIN_UNSUPPORTED' } });
    expect((await app.inject({ method: 'GET', url: `/api/v1/monitors/${monitorId}`, headers: authorization })).json())
      .toMatchObject({ config: { chainIds: [4_663], versions: ['v3', 'v4'] } });
  });
});
