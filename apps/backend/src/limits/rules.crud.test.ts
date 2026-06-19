import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRuleInput, LimitRuleValidationError } from './rules.js';
import type { LimitRule } from './types.js';

const NOW = '2026-06-19T00:00:00.000Z';

function existing(): LimitRule {
  return {
    id: 'claude-any-90',
    provider: 'claude',
    windowKey: 'any',
    thresholdPercent: 90,
    comparison: 'gte',
    action: 'block',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('normalizeRuleInput builds a complete rule with fixed comparison/action', () => {
  const rule = normalizeRuleInput({ provider: 'codex', windowKey: '5h', thresholdPercent: 80 }, undefined, NOW);
  assert.equal(rule.provider, 'codex');
  assert.equal(rule.windowKey, '5h');
  assert.equal(rule.thresholdPercent, 80);
  assert.equal(rule.comparison, 'gte');
  assert.equal(rule.action, 'block');
  assert.equal(rule.enabled, true);
  assert.equal(rule.createdAt, NOW);
  assert.equal(rule.updatedAt, NOW);
  assert.ok(rule.id.length > 0);
});

test('normalizeRuleInput coerces string threshold and toggles enabled', () => {
  const rule = normalizeRuleInput({ provider: 'claude', thresholdPercent: '55', enabled: false }, undefined, NOW);
  assert.equal(rule.thresholdPercent, 55);
  assert.equal(rule.enabled, false);
});

test('normalizeRuleInput preserves id + createdAt on update, bumps updatedAt', () => {
  const rule = normalizeRuleInput({ thresholdPercent: 70 }, existing(), NOW);
  assert.equal(rule.id, 'claude-any-90');
  assert.equal(rule.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(rule.updatedAt, NOW);
  assert.equal(rule.thresholdPercent, 70);
  // Unspecified fields carry forward from existing.
  assert.equal(rule.provider, 'claude');
  assert.equal(rule.windowKey, 'any');
});

test('normalizeRuleInput rejects an invalid provider', () => {
  assert.throws(() => normalizeRuleInput({ provider: 'gemini', thresholdPercent: 90 }), LimitRuleValidationError);
});

test('normalizeRuleInput rejects an out-of-range threshold', () => {
  assert.throws(() => normalizeRuleInput({ provider: 'claude', thresholdPercent: 150 }), LimitRuleValidationError);
  assert.throws(() => normalizeRuleInput({ provider: 'claude', thresholdPercent: -1 }), LimitRuleValidationError);
});

test('normalizeRuleInput rejects an unknown window key', () => {
  assert.throws(
    () => normalizeRuleInput({ provider: 'claude', windowKey: 'fortnight', thresholdPercent: 90 }),
    LimitRuleValidationError,
  );
});

test('normalizeRuleInput accepts custom: window keys', () => {
  const rule = normalizeRuleInput({ provider: 'claude', windowKey: 'custom:opus', thresholdPercent: 90 }, undefined, NOW);
  assert.equal(rule.windowKey, 'custom:opus');
});
