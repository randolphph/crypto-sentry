import { describe, expect, it } from 'vitest';

import type { Metric } from '../src/core/metrics/metric.js';
import { UniswapV3PositionSnapshotService } from '../src/core/positions/uniswap-v3-position-snapshot-service.js';
import type { MonitorRepository } from '../src/db/repositories/monitor-repository.js';

const observedAt = '2026-09-15T10:00:00.000Z';
const labels = {
  chainId: '4663',
  chainName: 'Robinhood Chain',
  protocol: 'uniswap',
  version: 'v3',
  tokenId: '42',
  token0Address: '0x0000000000000000000000000000000000000010',
  token0Symbol: 'USDG',
  token0Decimals: '6',
  token1Address: '0x0000000000000000000000000000000000000020',
  token1Symbol: 'WETH',
  token1Decimals: '18',
};

function metric(name: string, value: string | boolean, status: Metric['status'] = 'ok'): Metric {
  return {
    monitorId: 'mon_uniswap',
    source: 'uniswap_v3',
    target: '42',
    name,
    value,
    observedAt,
    receivedAt: observedAt,
    status,
    labels,
  };
}

function serviceWith(metrics: Metric[], now = '2026-09-15T10:00:30.000Z') {
  const monitors = {
    get: () => ({
      id: 'mon_uniswap',
      type: 'lp_position',
      maxStaleSeconds: 90,
      config: {
        protocol: 'uniswap',
        version: 'v3',
        chainId: 4_663,
        tokenId: '42',
        rpcIntegrationId: 'int_rpc',
      },
    }),
  } as unknown as MonitorRepository;
  return new UniswapV3PositionSnapshotService(monitors, { list: () => metrics }, () => new Date(now));
}

describe('UniswapV3PositionSnapshotService', () => {
  it('builds a structured Robinhood Chain LP snapshot', () => {
    const snapshot = serviceWith([
      metric('read_status', true),
      metric('position_owner', '0x0000000000000000000000000000000000001234'),
      metric('pool_address', '0x0000000000000000000000000000000000000030'),
      metric('block_number', '54321'),
      metric('fee_tier', '500'),
      metric('tick_lower', '-100'),
      metric('tick_upper', '100'),
      metric('current_tick', '0'),
      metric('liquidity', '1000000'),
      metric('in_range', true),
      metric('tokens_owed0', '1.5'),
      metric('tokens_owed1', '2'),
    ]).get('mon_uniswap');

    expect(snapshot).toMatchObject({
      status: 'ok',
      observedAt,
      dataAgeSeconds: 30,
      positions: [{
        chainId: 4_663,
        tokenId: '42',
        token0: { symbol: 'USDG', decimals: 6 },
        token1: { symbol: 'WETH', decimals: 18 },
        currentTick: 0,
        liquidity: '1000000',
        inRange: true,
      }],
      error: null,
    });
  });

  it('keeps the position observation time and reports a watchdog stale metric', () => {
    const staleMetric = {
      ...metric('data_age_seconds', '120', 'stale'),
      observedAt: '2026-09-15T10:02:00.000Z',
      receivedAt: '2026-09-15T10:02:00.000Z',
      labels: undefined,
    };
    const snapshot = serviceWith([
      metric('read_status', true),
      metric('liquidity', '1000000'),
      staleMetric,
    ], '2026-09-15T10:02:00.000Z').get('mon_uniswap');

    expect(snapshot.status).toBe('stale');
    expect(snapshot.observedAt).toBe(observedAt);
    expect(snapshot.dataAgeSeconds).toBe(120);
  });

  it('does not overwrite identical token IDs from different chains', () => {
    const ethereum = { ...metric('read_status', true), labels: { ...labels, chainId: '1', chainName: 'Ethereum' } };
    const robinhood = { ...metric('read_status', true), labels: { ...labels, chainId: '4663', chainName: 'Robinhood Chain' } };
    const snapshot = serviceWith([ethereum, robinhood]).get('mon_uniswap');

    expect(snapshot.positions).toHaveLength(2);
    expect(snapshot.positions.map((position) => position.chainId).sort((left, right) => left - right)).toEqual([1, 4_663]);
  });
});
