import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLimitWarnings, DEFAULT_WARN_PERCENT, DEFAULT_CRITICAL_PERCENT } from './rules.js';
import type { LimitProvider, LimitSnapshot } from './types.js';

const NOW = '2026-06-19T00:00:00.000Z';

function snapshot(overrides: Partial<LimitSnapshot> & { provider: LimitProvider }): LimitSnapshot {
  return {
    id: `${overrides.provider}-${overrides.windowKey ?? 'weekly'}`,
    windowKey: 'weekly',
    label: 'Weekly limit',
    percentUsed: 0,
    metricRaw: null,
    resetText: null,
    resetAt: null,
    ok: true,
    rawPanel: '',
    parseConfidence: 'trusted',
    checkedAt: NOW,
    ...overrides,
  };
}

test('evaluateLimitWarnings flags a window at the default warn threshold as warn', () => {
  const warnings = evaluateLimitWarnings([snapshot({ provider: 'claude', percentUsed: DEFAULT_WARN_PERCENT })]);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0], {
    provider: 'claude',
    windowKey: 'weekly',
    label: 'Weekly limit',
    percentUsed: DEFAULT_WARN_PERCENT,
    level: 'warn',
  });
});

test('evaluateLimitWarnings flags a window at/above the critical threshold as critical', () => {
  const warnings = evaluateLimitWarnings([snapshot({ provider: 'codex', percentUsed: DEFAULT_CRITICAL_PERCENT })]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.level, 'critical');
});

test('evaluateLimitWarnings ignores windows below the warn threshold', () => {
  const warnings = evaluateLimitWarnings([snapshot({ provider: 'claude', percentUsed: DEFAULT_WARN_PERCENT - 1 })]);
  assert.equal(warnings.length, 0);
});

test('evaluateLimitWarnings honours a custom warnPercent', () => {
  const snaps = [snapshot({ provider: 'claude', percentUsed: 60 })];
  assert.equal(evaluateLimitWarnings(snaps).length, 0); // below default 75
  const warnings = evaluateLimitWarnings(snaps, { warnPercent: 50 });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.level, 'warn');
});

test('evaluateLimitWarnings ignores failed and unparseable snapshots', () => {
  const warnings = evaluateLimitWarnings([
    snapshot({ provider: 'claude', percentUsed: 95, ok: false, error: 'probe failed' }),
    snapshot({ provider: 'codex', percentUsed: null }),
  ]);
  assert.equal(warnings.length, 0);
});

test('evaluateLimitWarnings uses only the latest snapshot per provider/window', () => {
  const older = snapshot({ provider: 'claude', percentUsed: 95, checkedAt: '2026-06-19T00:00:00.000Z' });
  const newer = snapshot({ provider: 'claude', percentUsed: 10, checkedAt: '2026-06-19T01:00:00.000Z' });
  const warnings = evaluateLimitWarnings([older, newer]);
  // The fresh 10% reading wins; the stale 95% must not raise a warning.
  assert.equal(warnings.length, 0);
});

test('evaluateLimitWarnings reports one warning per distinct window across providers', () => {
  const warnings = evaluateLimitWarnings([
    snapshot({ provider: 'claude', windowKey: '5h', label: '5h limit', percentUsed: 80 }),
    snapshot({ provider: 'claude', windowKey: 'weekly', label: 'Weekly limit', percentUsed: 92 }),
    snapshot({ provider: 'codex', windowKey: 'weekly', label: 'Weekly limit', percentUsed: 50 }),
  ]);
  assert.equal(warnings.length, 2);
  const byKey = Object.fromEntries(warnings.map((w) => [`${w.provider}:${w.windowKey}`, w.level]));
  assert.deepEqual(byKey, { 'claude:5h': 'warn', 'claude:weekly': 'critical' });
});
