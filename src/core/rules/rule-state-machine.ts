import { Decimal } from 'decimal.js';

import { isActionableMetric } from '../metrics/metric.js';
import type { Metric } from '../metrics/metric.js';

export type RuleOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
export type RuleStateName = 'ARMED' | 'TRIGGERED';
export type RuleAction = 'none' | 'trigger' | 'repeat' | 'recover';

export interface EvaluatedRule {
  operator: RuleOperator;
  threshold: string;
  durationSeconds: number;
  cooldownSeconds: number;
  hysteresis: string;
}

export interface RuleRuntimeState {
  state: RuleStateName;
  conditionSince: string | null;
  lastValue: string | null;
  lastAlertAt: string | null;
}

export interface RuleEvaluation {
  action: RuleAction;
  state: RuleRuntimeState;
}

function parseBoolean(value: string | boolean): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function numericCondition(value: Decimal, threshold: Decimal, operator: RuleOperator): boolean {
  switch (operator) {
    case 'gt': return value.gt(threshold);
    case 'gte': return value.gte(threshold);
    case 'lt': return value.lt(threshold);
    case 'lte': return value.lte(threshold);
    case 'eq': return value.eq(threshold);
    case 'neq': return !value.eq(threshold);
  }
}

export function conditionMatches(value: string | boolean, threshold: string, operator: RuleOperator): boolean {
  const valueBoolean = parseBoolean(value);
  const thresholdBoolean = parseBoolean(threshold);
  if (valueBoolean !== undefined || thresholdBoolean !== undefined) {
    if (valueBoolean === undefined || thresholdBoolean === undefined || !['eq', 'neq'].includes(operator)) {
      throw new Error('Boolean metrics only support eq/neq with boolean thresholds');
    }
    return operator === 'eq' ? valueBoolean === thresholdBoolean : valueBoolean !== thresholdBoolean;
  }
  return numericCondition(new Decimal(String(value)), new Decimal(threshold), operator);
}

export function hasRecovered(value: string | boolean, rule: EvaluatedRule): boolean {
  const valueBoolean = parseBoolean(value);
  const thresholdBoolean = parseBoolean(rule.threshold);
  if (valueBoolean !== undefined || thresholdBoolean !== undefined) {
    return !conditionMatches(value, rule.threshold, rule.operator);
  }

  const numericValue = new Decimal(String(value));
  const threshold = new Decimal(rule.threshold);
  const hysteresis = new Decimal(rule.hysteresis).abs();
  switch (rule.operator) {
    case 'gt':
    case 'gte':
      return numericValue.lt(threshold.minus(hysteresis));
    case 'lt':
    case 'lte':
      return numericValue.gt(threshold.plus(hysteresis));
    case 'eq':
      return numericValue.minus(threshold).abs().gt(hysteresis);
    case 'neq':
      return numericValue.minus(threshold).abs().lte(hysteresis);
  }
}

export type TriState = true | false | 'unknown';

export function combineConditionResults(combinator: 'and' | 'or', results: TriState[]): TriState {
  if (combinator === 'and') {
    if (results.includes(false)) return false;
    return results.includes('unknown') ? 'unknown' : true;
  }
  if (results.includes(true)) return true;
  return results.includes('unknown') ? 'unknown' : false;
}

export function evaluateRuleTruth(
  rule: Pick<EvaluatedRule, 'durationSeconds' | 'cooldownSeconds'>,
  currentState: RuleRuntimeState,
  truth: TriState,
  value: string,
  now: Date = new Date(),
): RuleEvaluation {
  if (truth === 'unknown') return { action: 'none', state: currentState };
  const baseState = { ...currentState, lastValue: value };
  if (currentState.state === 'TRIGGERED') {
    if (!truth) {
      return { action: 'recover', state: { state: 'ARMED', conditionSince: null, lastValue: value, lastAlertAt: currentState.lastAlertAt } };
    }
    const lastAlertMs = currentState.lastAlertAt === null ? 0 : Date.parse(currentState.lastAlertAt);
    if (now.getTime() - lastAlertMs >= rule.cooldownSeconds * 1000) {
      const timestamp = now.toISOString();
      return { action: 'repeat', state: { ...baseState, lastAlertAt: timestamp } };
    }
    return { action: 'none', state: baseState };
  }
  if (!truth) return { action: 'none', state: { ...baseState, conditionSince: null } };
  const conditionSince = currentState.conditionSince ?? now.toISOString();
  if (now.getTime() - Date.parse(conditionSince) < rule.durationSeconds * 1000) {
    return { action: 'none', state: { ...baseState, conditionSince } };
  }
  const timestamp = now.toISOString();
  return { action: 'trigger', state: { state: 'TRIGGERED', conditionSince, lastValue: value, lastAlertAt: timestamp } };
}

export function evaluateRule(
  rule: EvaluatedRule,
  currentState: RuleRuntimeState,
  metric: Metric,
  now: Date = new Date(),
): RuleEvaluation {
  const value = String(metric.value);
  const baseState = { ...currentState, lastValue: value };
  if (!isActionableMetric(metric)) return { action: 'none', state: baseState };

  if (currentState.state === 'TRIGGERED') {
    if (hasRecovered(metric.value, rule)) {
      return {
        action: 'recover',
        state: { state: 'ARMED', conditionSince: null, lastValue: value, lastAlertAt: currentState.lastAlertAt },
      };
    }

    const lastAlertMs = currentState.lastAlertAt === null ? 0 : Date.parse(currentState.lastAlertAt);
    if (now.getTime() - lastAlertMs >= rule.cooldownSeconds * 1000) {
      const timestamp = now.toISOString();
      return { action: 'repeat', state: { ...baseState, lastAlertAt: timestamp } };
    }
    return { action: 'none', state: baseState };
  }

  if (!conditionMatches(metric.value, rule.threshold, rule.operator)) {
    return { action: 'none', state: { ...baseState, conditionSince: null } };
  }

  const conditionSince = currentState.conditionSince ?? now.toISOString();
  const durationMet = now.getTime() - Date.parse(conditionSince) >= rule.durationSeconds * 1000;
  if (!durationMet) {
    return { action: 'none', state: { ...baseState, conditionSince } };
  }

  const timestamp = now.toISOString();
  return {
    action: 'trigger',
    state: { state: 'TRIGGERED', conditionSince, lastValue: value, lastAlertAt: timestamp },
  };
}
