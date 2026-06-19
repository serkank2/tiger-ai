import test from 'node:test';
import assert from 'node:assert/strict';
import { StateLimitGate } from './gate.js';
import { defaultLimitRules, type LimitSnapshot, type LimitsPersistedState } from './types.js';

const NOW = new Date('2026-06-18T06:00:00.000Z');

function snapshot(input: Partial<LimitSnapshot>): LimitSnapshot {
  return {
    id: input.id ?? 'snapshot',
    provider: input.provider ?? 'claude',
    windowKey: input.windowKey ?? '5h',
    label: input.label ?? '5h limit',
    percentUsed: input.percentUsed ?? 0,
    metricRaw: input.metricRaw ?? { percent: input.percentUsed ?? 0, metric: 'used' },
    resetText: input.resetText ?? 'resets in 1h',
    resetAt: input.resetAt === undefined ? '2026-06-18T07:00:00.000Z' : input.resetAt,
    ok: input.ok ?? true,
    error: input.error,
    rawPanel: input.rawPanel ?? '',
    parseConfidence: input.parseConfidence ?? 'trusted',
    checkedAt: input.checkedAt ?? NOW.toISOString(),
  };
}

function limits(snapshots: LimitSnapshot[]): LimitsPersistedState {
  return {
    snapshots,
    rules: defaultLimitRules('2026-06-18T00:00:00.000Z'),
  };
}

test('StateLimitGate blocks at the 90% boundary with trusted resumeAfter', async () => {
  const gate = new StateLimitGate(() => limits([snapshot({ percentUsed: 90 })]), {
    now: NOW,
    staleAfterMs: 60_000,
  });

  const decision = await gate.check('claude');

  assert.equal(decision.allowed, false);
  assert.equal(decision.action, 'block');
  assert.equal(decision.conservative, false);
  assert.equal(decision.resumeAfter, '2026-06-18T07:00:00.000Z');
});

test('StateLimitGate blocks conservatively when no provider snapshot exists', async () => {
  const gate = new StateLimitGate(() => limits([]), {
    now: NOW,
    staleAfterMs: 60_000,
  });

  const decision = await gate.check('claude');

  assert.equal(decision.allowed, false);
  assert.equal(decision.conservative, true);
  assert.match(decision.reason, /unavailable/i);
});

test('StateLimitGate blocks conservatively when latest provider probe failed', async () => {
  const gate = new StateLimitGate(
    () =>
      limits([
        snapshot({ id: 'ok', percentUsed: 10, checkedAt: '2026-06-18T05:55:00.000Z' }),
        snapshot({
          id: 'failed',
          windowKey: 'probe',
          label: 'Probe',
          percentUsed: null,
          metricRaw: null,
          ok: false,
          error: 'cli unavailable',
          resetAt: null,
          parseConfidence: 'unknown',
          checkedAt: NOW.toISOString(),
        }),
      ]),
    { now: NOW, staleAfterMs: 60_000 },
  );

  const decision = await gate.check('claude');

  assert.equal(decision.allowed, false);
  assert.equal(decision.conservative, true);
  assert.equal(decision.resumeAfter, null);
  assert.match(decision.reason, /probe failed/i);
});

test('StateLimitGate blocks conservatively on stale snapshots', async () => {
  const gate = new StateLimitGate(() => limits([snapshot({ percentUsed: 10, checkedAt: '2026-06-18T05:00:00.000Z' })]), {
    now: NOW,
    staleAfterMs: 10 * 60 * 1000,
  });

  const decision = await gate.check('claude');

  assert.equal(decision.allowed, false);
  assert.equal(decision.conservative, true);
  assert.equal(decision.selectedWindow?.stale, true);
  assert.match(decision.reason, /stale/i);
});

test('StateLimitGate FAILS OPEN when the snapshot source is unavailable (missing table)', async () => {
  const gate = new StateLimitGate(
    () => ({ ...limits([]), snapshotsUnavailable: true }),
    { now: NOW, staleAfterMs: 60_000 },
  );

  const decision = await gate.check('claude');

  assert.equal(decision.allowed, true);
  assert.equal(decision.action, 'allow');
  assert.equal(decision.conservative, false);
  assert.match(decision.reason, /unavailable|failing open/i);
});

test('StateLimitGate blocks conservatively when reset_at is unknown', async () => {
  const gate = new StateLimitGate(
    () => limits([snapshot({ percentUsed: 91, resetAt: null, parseConfidence: 'unknown' })]),
    { now: NOW, staleAfterMs: 60_000 },
  );

  const decision = await gate.check('claude');

  assert.equal(decision.allowed, false);
  assert.equal(decision.conservative, true);
  assert.equal(decision.resumeAfter, null);
});
