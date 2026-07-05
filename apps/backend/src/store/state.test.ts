import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAndNormalize } from './state.js';
import type { LimitRule, LimitSnapshot } from '../limits/types.js';

// Regression for review finding 3: the file-backed (state.json) limit normalization previously
// accepted only claude/codex providers, so Antigravity limit snapshots and rules were silently
// dropped on reload. They must now round-trip.

function antigravitySnapshot(): LimitSnapshot {
  return {
    id: 'limit_antigravity_1',
    provider: 'antigravity',
    windowKey: 'probe',
    label: 'Probe',
    percentUsed: null,
    metricRaw: null,
    resetText: null,
    resetAt: null,
    ok: false,
    error: 'Antigravity (agy) exposes no usage/limit command; no limit data is available.',
    rawPanel: '',
    parseConfidence: 'unknown',
    checkedAt: '2026-06-18T06:00:00.000Z',
  };
}

function antigravityRule(): LimitRule {
  return {
    id: 'antigravity-percent-used-90',
    provider: 'antigravity',
    windowKey: 'any',
    thresholdPercent: 90,
    comparison: 'gte',
    action: 'block',
    enabled: true,
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
  };
}

test('state.json normalization preserves Antigravity limit snapshots on reload', () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    terminals: [],
    groups: [],
    limits: { snapshots: [antigravitySnapshot()], rules: [antigravityRule()] },
  });
  const state = parseAndNormalize(raw);
  const snapshots = state.limits?.snapshots ?? [];
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.provider, 'antigravity');
});

test('state.json normalization preserves an Antigravity limit rule on reload', () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    terminals: [],
    groups: [],
    limits: { snapshots: [], rules: [antigravityRule()] },
  });
  const state = parseAndNormalize(raw);
  const rules = state.limits?.rules ?? [];
  // The Antigravity rule survives (not replaced by the Claude-only defaults).
  assert.ok(rules.some((rule) => rule.provider === 'antigravity'));
});

test('state.json normalization still keeps claude/codex limit snapshots', () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    terminals: [],
    groups: [],
    limits: {
      snapshots: [
        { ...antigravitySnapshot(), id: 'c', provider: 'claude' },
        { ...antigravitySnapshot(), id: 'x', provider: 'codex' },
      ],
      rules: [],
    },
  });
  const state = parseAndNormalize(raw);
  const providers = (state.limits?.snapshots ?? []).map((snapshot) => snapshot.provider).sort();
  assert.deepEqual(providers, ['claude', 'codex']);
});
