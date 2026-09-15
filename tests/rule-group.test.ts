import { describe, expect, it } from 'vitest';

import { combineConditionResults, evaluateRuleTruth } from '../src/core/rules/rule-state-machine.js';

describe('Rule Group three-state semantics', () => {
  it('combines AND and OR with true, false, and unknown', () => {
    expect(combineConditionResults('and', [true, true])).toBe(true);
    expect(combineConditionResults('and', [true, 'unknown'])).toBe('unknown');
    expect(combineConditionResults('and', [false, 'unknown'])).toBe(false);
    expect(combineConditionResults('or', [false, false])).toBe(false);
    expect(combineConditionResults('or', [false, 'unknown'])).toBe('unknown');
    expect(combineConditionResults('or', [true, 'unknown'])).toBe(true);
  });

  it('does not trigger or recover a group while its value is unknown', () => {
    const armed = { state: 'ARMED' as const, conditionSince: '2026-09-15T00:00:00.000Z', lastValue: '1', lastAlertAt: null };
    expect(evaluateRuleTruth({ durationSeconds: 60, cooldownSeconds: 300 }, armed, 'unknown', '2')).toEqual({
      action: 'none', state: armed,
    });
    const triggered = { state: 'TRIGGERED' as const, conditionSince: '2026-09-15T00:00:00.000Z', lastValue: '1', lastAlertAt: '2026-09-15T00:01:00.000Z' };
    expect(evaluateRuleTruth({ durationSeconds: 60, cooldownSeconds: 300 }, triggered, 'unknown', '2')).toEqual({
      action: 'none', state: triggered,
    });
  });
});
