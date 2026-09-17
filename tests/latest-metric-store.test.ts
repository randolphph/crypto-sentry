import { describe, expect, it } from 'vitest';

import { LatestMetricStore } from '../src/core/metrics/latest-metric-store.js';
import type { Metric } from '../src/core/metrics/metric.js';

const base: Metric = {
  monitorId: 'mon_lp', source: 'uniswap', target: '42', name: 'read_error', value: false,
  observedAt: '2026-09-17T00:00:00.000Z', receivedAt: '2026-09-17T00:00:00.000Z', status: 'error',
  labels: { chainId: '4663', version: 'v3', tokenId: '42' },
};

describe('LatestMetricStore status identities', () => {
  it('replaces a failed status even when a successful update has descriptive labels', () => {
    const store = new LatestMetricStore();
    store.put(base);
    store.put({
      ...base,
      value: true,
      status: 'ok',
      observedAt: '2026-09-17T00:00:10.000Z',
      receivedAt: '2026-09-17T00:00:10.000Z',
      labels: {
        ...base.labels,
        token0Symbol: 'USDG', token0Decimals: '6', token1Symbol: 'WETH', token1Decimals: '18',
      },
    });

    expect(store.list('mon_lp')).toHaveLength(1);
    expect(store.list('mon_lp')[0]).toMatchObject({ value: true, status: 'ok' });
  });

  it('replaces a stale data-age status with the next successful observation', () => {
    const store = new LatestMetricStore();
    store.put({
      ...base,
      name: 'data_age_seconds', target: 'wallet', value: '104', status: 'stale', labels: undefined,
    });
    store.put({
      ...base,
      name: 'data_age_seconds', target: 'wallet', value: '0', status: 'ok',
      observedAt: '2026-09-17T00:00:10.000Z', receivedAt: '2026-09-17T00:00:10.000Z', labels: {},
    });

    expect(store.list('mon_lp')).toHaveLength(1);
    expect(store.list('mon_lp')[0]).toMatchObject({ name: 'data_age_seconds', value: '0', status: 'ok' });
  });
});

