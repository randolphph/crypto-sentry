import { describe, expect, it } from 'vitest';

import type { Metric } from '../src/core/metrics/metric.js';
import { evaluateRule } from '../src/core/rules/rule-state-machine.js';

const baseMetric: Metric = {
  monitorId: 'mon_btc',
  source: 'binance',
  target: 'BTCUSDT',
  name: 'price',
  value: '90000',
  unit: 'USDT',
  observedAt: '2026-09-14T12:00:00.000Z',
  receivedAt: '2026-09-14T12:00:00.100Z',
  status: 'ok',
};

const armed = {
  state: 'ARMED' as const,
  conditionSince: null,
  lastValue: null,
  lastAlertAt: null,
};

describe('rule state machine', () => {
  it.each([
    ['gt', '10.0000000000000000001', '10', 'trigger'],
    ['gte', '10', '10', 'trigger'],
    ['lt', '9.9999999999999999999', '10', 'trigger'],
    ['lte', '10', '10', 'trigger'],
    ['eq', '10.000', '10', 'trigger'],
    ['neq', '11', '10', 'trigger'],
  ] as const)('evaluates %s without binary floating point loss', (operator, value, threshold, action) => {
    const result = evaluateRule(
      { operator, threshold, durationSeconds: 0, cooldownSeconds: 1800, hysteresis: '0' },
      armed,
      { ...baseMetric, value },
      new Date('2026-09-14T12:00:00.000Z'),
    );
    expect(result.action).toBe(action);
    expect(result.state.state).toBe('TRIGGERED');
  });

  it('requires the condition to remain true for durationSeconds', () => {
    const rule = { operator: 'lte' as const, threshold: '90000', durationSeconds: 60, cooldownSeconds: 1800, hysteresis: '500' };
    const first = evaluateRule(rule, armed, baseMetric, new Date('2026-09-14T12:00:00.000Z'));
    expect(first.action).toBe('none');
    expect(first.state.conditionSince).toBe('2026-09-14T12:00:00.000Z');

    const beforeDuration = evaluateRule(rule, first.state, baseMetric, new Date('2026-09-14T12:00:59.999Z'));
    expect(beforeDuration.action).toBe('none');

    const atDuration = evaluateRule(rule, beforeDuration.state, baseMetric, new Date('2026-09-14T12:01:00.000Z'));
    expect(atDuration.action).toBe('trigger');
  });

  it('applies cooldown and only recovers after crossing hysteresis', () => {
    const rule = { operator: 'lte' as const, threshold: '90000', durationSeconds: 0, cooldownSeconds: 1800, hysteresis: '500' };
    const triggered = evaluateRule(rule, armed, baseMetric, new Date('2026-09-14T12:00:00.000Z'));

    const nearThreshold = evaluateRule(rule, triggered.state, { ...baseMetric, value: '90499' }, new Date('2026-09-14T12:10:00.000Z'));
    expect(nearThreshold.action).toBe('none');
    expect(nearThreshold.state.state).toBe('TRIGGERED');

    const repeat = evaluateRule(rule, nearThreshold.state, { ...baseMetric, value: '89900' }, new Date('2026-09-14T12:30:00.000Z'));
    expect(repeat.action).toBe('repeat');

    const recovered = evaluateRule(rule, repeat.state, { ...baseMetric, value: '90501' }, new Date('2026-09-14T12:31:00.000Z'));
    expect(recovered.action).toBe('recover');
    expect(recovered.state.state).toBe('ARMED');
  });

  it('supports boolean in-range metrics', () => {
    const result = evaluateRule(
      { operator: 'eq', threshold: 'false', durationSeconds: 0, cooldownSeconds: 300, hysteresis: '0' },
      armed,
      { ...baseMetric, name: 'in_range', value: false },
    );
    expect(result.action).toBe('trigger');
  });

  it('does not evaluate stale, failed, unsupported, or warming metrics', () => {
    for (const status of ['stale', 'error', 'unsupported', 'warming_up'] as const) {
      expect(evaluateRule(
        { operator: 'lte', threshold: '90000', durationSeconds: 0, cooldownSeconds: 1, hysteresis: '0' },
        armed,
        { ...baseMetric, status },
      ).action).toBe('none');
    }
  });
});
