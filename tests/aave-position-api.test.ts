import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Address } from 'viem';

import { createApp } from '../src/app.js';
import type { AaveV3Position } from '../src/adapters/aave/aave-v3-position-reader.js';
import type { AppConfig } from '../src/config.js';
import type { AaveV3PositionReaderFactory } from '../src/core/integrations/aave-v3-position-coordinator.js';

const token = 'aave-test-api-token-that-is-long-enough';
const authorization = { authorization: `Bearer ${token}` };
const walletAddress: Address = '0x0000000000000000000000000000000000001234';
const config: AppConfig = {
  databasePath: ':memory:',
  apiToken: token,
  masterEncryptionKey: Buffer.alloc(32, 7),
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
};
const position: AaveV3Position = {
  chainId: 1,
  chainName: 'Ethereum',
  blockNumber: '12345678',
  walletAddress,
  baseCurrencySymbol: 'USD',
  totalCollateralBase: '5000',
  totalDebtBase: '1000',
  availableBorrowsBase: '2500',
  liquidationThresholdPercent: '82.5',
  ltvPercent: '75',
  healthFactor: '1.5',
  assets: [{
    symbol: 'WETH',
    decimals: 18,
    underlyingAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    supplied: '2',
    stableDebt: '0',
    variableDebt: '0.5',
    totalDebt: '0.5',
    suppliedBase: '4000',
    debtBase: '1000',
    usageAsCollateralEnabled: true,
  }],
};

describe('Aave position monitor API', () => {
  let app: FastifyInstance;
  const read = vi.fn<(walletAddress: string, signal?: AbortSignal) => Promise<AaveV3Position | undefined>>();
  const readerFactory: AaveV3PositionReaderFactory = { create: () => ({ read }) };

  beforeEach(async () => {
    read.mockReset();
    read.mockResolvedValue(position);
    app = await createApp({
      config,
      logger: false,
      webSocketFactory: false,
      aavePositionReaderFactory: readerFactory,
      pollingMinimumIntervalMilliseconds: 1,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function createRpcIntegration() {
    return app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: authorization,
      payload: {
        name: 'Ethereum Mainnet',
        type: 'evm_rpc',
        provider: 'alchemy',
        config: { chainId: 1, rpcUrl: 'https://rpc.example/private-key' },
      },
    });
  }

  it('accepts only a wallet address and publishes aggregate and asset metrics', async () => {
    await createRpcIntegration();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: authorization,
      payload: {
        name: 'My Aave V3 account',
        type: 'aave_position',
        intervalSeconds: 5,
        config: { walletAddress },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ config: unknown }>().config).toEqual({ walletAddress });
    const monitorId = created.json<{ id: string }>().id;

    await vi.waitFor(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/monitors/${monitorId}/metrics`,
        headers: authorization,
      });
      const items = response.json<{ items: Array<{ name: string; value: string | boolean; labels?: Record<string, string> }> }>().items;
      expect(items.find(({ name }) => name === 'health_factor')).toMatchObject({
        value: '1.5', labels: { chainName: 'Ethereum' },
      });
      expect(items.find(({ name }) => name === 'supplied_amount')).toMatchObject({
        value: '2', labels: { symbol: 'WETH' },
      });
      expect(items.find(({ name }) => name === 'total_debt_amount')).toMatchObject({
        value: '0.5', labels: { symbol: 'WETH' },
      });
      expect(items.find(({ name }) => name === 'position_chain_count')).toMatchObject({ value: '1' });
    });
    expect(read).toHaveBeenCalledWith(walletAddress, expect.any(AbortSignal));

    const positionResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/monitors/${monitorId}/positions`,
      headers: authorization,
    });
    expect(positionResponse.statusCode).toBe(200);
    expect(positionResponse.json()).toMatchObject({
      monitorId,
      walletAddress,
      status: 'ok',
      summary: { positionChainCount: 1, positionAssetCount: 1 },
      positions: [{
        chainId: 1,
        chainName: 'Ethereum',
        blockNumber: '12345678',
        account: { healthFactor: '1.5', healthFactorInfinite: false, totalCollateralBase: '5000' },
        assets: [{ symbol: 'WETH', suppliedAmount: '2', totalDebtAmount: '0.5' }],
      }],
    });
  });

  it('rejects manual Aave chain and contract configuration', async () => {
    await createRpcIntegration();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: authorization,
      payload: {
        name: 'Legacy Aave config',
        type: 'aave_position',
        config: {
          walletAddress,
          chainId: 1,
          poolAddress: '0x0000000000000000000000000000000000000001',
          rpcIntegrationId: 'int_old',
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Unrecognized');
  });

  it('reports RPC failures as errors instead of a zero position', async () => {
    read.mockRejectedValue(new Error('request to https://rpc.example/private-key failed'));
    await createRpcIntegration();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: authorization,
      payload: {
        name: 'Unavailable Aave account',
        type: 'aave_position',
        config: { walletAddress },
      },
    });
    const monitorId = created.json<{ id: string }>().id;

    await vi.waitFor(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/monitors/${monitorId}/metrics`,
        headers: authorization,
      });
      const items = response.json<{ items: Array<{ name: string; value: string | boolean; status: string }> }>().items;
      expect(items.find(({ name }) => name === 'rpc_status')).toMatchObject({ value: false, status: 'error' });
      expect(items.some(({ name }) => name === 'total_collateral_base')).toBe(false);
    });
    const monitor = await app.inject({
      method: 'GET',
      url: `/api/v1/monitors/${monitorId}`,
      headers: authorization,
    });
    expect(monitor.json<{ lastStatus: string }>().lastStatus).toBe('error');
    expect(monitor.body).not.toContain('private-key');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('recovers when an RPC retry succeeds', async () => {
    read.mockRejectedValueOnce(new Error('temporary RPC failure'));
    await createRpcIntegration();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: authorization,
      payload: {
        name: 'Retrying Aave account',
        type: 'aave_position',
        config: { walletAddress },
      },
    });
    const monitorId = created.json<{ id: string }>().id;

    await vi.waitFor(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/monitors/${monitorId}/positions`,
        headers: authorization,
      });
      expect(response.json<{ status: string }>().status).toBe('ok');
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('creates idempotent chain-scoped default health-factor rules', async () => {
    await createRpcIntegration();
    const createdMonitor = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: authorization,
      payload: {
        name: 'Aave alert account',
        type: 'aave_position',
        config: { walletAddress },
      },
    });
    const monitorId = createdMonitor.json<{ id: string }>().id;
    await vi.waitFor(async () => {
      const positions = await app.inject({
        method: 'GET',
        url: `/api/v1/monitors/${monitorId}/positions`,
        headers: authorization,
      });
      expect(positions.json<{ status: string }>().status).toBe('ok');
    });

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/monitors/${monitorId}/aave-risk-rules`,
      headers: authorization,
      payload: {},
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      createdCount: 2,
      existingCount: 0,
      items: [
        { chainId: 1, severity: 'warning', threshold: '1.2', created: true },
        { chainId: 1, severity: 'critical', threshold: '1.05', created: true },
      ],
    });

    const rulesResponse = await app.inject({ method: 'GET', url: '/api/v1/rules', headers: authorization });
    const createdRules = rulesResponse.json<{ items: Array<{ monitorId: string; labels: Record<string, string> }> }>().items;
    expect(createdRules).toHaveLength(2);
    expect(createdRules.every((rule) => rule.monitorId === monitorId && rule.labels.chainId === '1')).toBe(true);

    const repeated = await app.inject({
      method: 'POST',
      url: `/api/v1/monitors/${monitorId}/aave-risk-rules`,
      headers: authorization,
      payload: {},
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ createdCount: 0, existingCount: 2 });

    const invalidThresholds = await app.inject({
      method: 'POST',
      url: `/api/v1/monitors/${monitorId}/aave-risk-rules`,
      headers: authorization,
      payload: { warningThreshold: '1.0', criticalThreshold: '1.1' },
    });
    expect(invalidThresholds.statusCode).toBe(400);
    expect(invalidThresholds.body).toContain('warningThreshold');
  });
});
