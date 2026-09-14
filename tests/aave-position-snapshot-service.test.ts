import { describe, expect, it } from 'vitest';

import { AppError } from '../src/api/errors.js';
import type { Metric } from '../src/core/metrics/metric.js';
import { AavePositionSnapshotService } from '../src/core/positions/aave-position-snapshot-service.js';
import type { MonitorRepository } from '../src/db/repositories/monitor-repository.js';

const observedAt = '2026-09-14T12:00:00.000Z';
const walletAddress = '0x0000000000000000000000000000000000001234';

function metric(
  name: string,
  value: string | boolean,
  labels?: Record<string, string>,
  status: Metric['status'] = 'ok',
  unit?: string,
): Metric {
  return {
    monitorId: 'mon_aave',
    source: 'aave_v3',
    target: walletAddress,
    name,
    value,
    observedAt,
    receivedAt: observedAt,
    status,
    ...(unit === undefined ? {} : { unit }),
    ...(labels === undefined ? {} : { labels }),
  };
}

function serviceWith(metrics: Metric[], now = '2026-09-14T12:00:30.000Z', type = 'aave_position') {
  const monitors = {
    get: () => ({
      id: 'mon_aave',
      type,
      maxStaleSeconds: 90,
      config: { walletAddress },
    }),
  } as unknown as MonitorRepository;
  return new AavePositionSnapshotService(monitors, { list: () => metrics }, () => new Date(now));
}

describe('AavePositionSnapshotService', () => {
  it('groups flat metrics into chain and asset position snapshots', () => {
    const ethereum = { chainId: '1', chainName: 'Ethereum' };
    const base = { chainId: '8453', chainName: 'Base' };
    const weth = {
      ...ethereum,
      symbol: 'WETH',
      assetAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    };
    const snapshot = serviceWith([
      metric('rpc_status', true, ethereum),
      metric('rpc_status', false, base, 'error'),
      metric('total_collateral_base', '5000', ethereum, 'ok', 'USD'),
      metric('total_debt_base', '1000', ethereum, 'ok', 'USD'),
      metric('available_borrows_base', '2500', ethereum, 'ok', 'USD'),
      metric('liquidation_threshold_percent', '82.5', ethereum, 'ok', 'percent'),
      metric('ltv_percent', '75', ethereum, 'ok', 'percent'),
      metric('health_factor', '1.5', ethereum, 'ok', 'ratio'),
      metric('supplied_amount', '2', weth, 'ok', 'WETH'),
      metric('stable_debt_amount', '0', weth, 'ok', 'WETH'),
      metric('variable_debt_amount', '0.5', weth, 'ok', 'WETH'),
      metric('total_debt_amount', '0.5', weth, 'ok', 'WETH'),
      metric('supplied_base', '4000', weth, 'ok', 'USD'),
      metric('debt_base', '1000', weth, 'ok', 'USD'),
      metric('usage_as_collateral', true, weth, 'ok', 'boolean'),
      metric('position_asset_count', '1'),
    ]).get('mon_aave');

    expect(snapshot).toMatchObject({
      status: 'partial',
      dataAgeSeconds: 30,
      summary: {
        scannedChainCount: 2,
        successfulChainCount: 1,
        failedChainCount: 1,
        positionChainCount: 1,
        positionAssetCount: 1,
      },
      networkScans: [
        { chainId: 1, status: 'ok', hasPosition: true },
        { chainId: 8453, status: 'error', hasPosition: false },
      ],
      positions: [{
        chainId: 1,
        account: { healthFactor: '1.5', totalCollateralBase: '5000' },
        assets: [{ symbol: 'WETH', suppliedAmount: '2', totalDebtAmount: '0.5' }],
      }],
    });
  });

  it('distinguishes empty and stale snapshots', () => {
    const labels = { chainId: '1', chainName: 'Ethereum' };
    expect(serviceWith([
      metric('rpc_status', true, labels),
      metric('position_chain_count', '0'),
      metric('position_asset_count', '0'),
    ]).get('mon_aave').status).toBe('empty');

    const stale = serviceWith([
      metric('rpc_status', true, labels),
      metric('health_factor', '1.5', labels),
    ], '2026-09-14T12:02:00.000Z').get('mon_aave');
    expect(stale.status).toBe('stale');
    expect(stale.networkScans[0]?.status).toBe('stale');
  });

  it('rejects non-Aave monitors', () => {
    expect(() => serviceWith([], undefined, 'market').get('mon_aave')).toThrow(AppError);
  });
});
