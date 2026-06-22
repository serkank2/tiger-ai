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
    failOpen: false,
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
    { now: NOW, staleAfterMs: 60_000, failOpen: false },
  );

  const decision = await gate.check('claude');

  assert.equal(decision.allowed, false);
  assert.equal(decision.conservative, true);
  assert.equal(decision.resumeAfter, null);
  assert.match(decision.reason, /probe failed/i);
});

test('StateLimitGate fails OPEN by default when the latest probe failed (does not block)', async () => {
  // The operator manages their own quota; a probe that merely failed to read must not block.
  const gate = new StateLimitGate(
    () =>
      limits([
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
    { now: NOW, staleAfterMs: 60_000, failOpen: true },
  );

  const decision = await gate.check('claude');

  assert.equal(decision.allowed, true);
  assert.equal(decision.action, 'allow');
});

test('StateLimitGate blocks conservatively on stale snapshots', async () => {
  const gate = new StateLimitGate(() => limits([snapshot({ percentUsed: 10, checkedAt: '2026-06-18T05:00:00.000Z' })]), {
    now: NOW,
    staleAfterMs: 10 * 60 * 1000,
    failOpen: false,
  });

  const decision = await gate.check('claude');

  assert.equal(decision.allowed, false);
  assert.equal(decision.conservative, true);
  assert.equal(decision.selectedWindow?.stale, true);
  assert.match(decision.reason, /stale/i);
});

test('StateLimitGate ignores a stale leftover window when a fresh window exists', async () => {
  // Regression: a past misparse left a stale "custom" window at 10% that no longer appears in
  // the live probe. The fresh weekly window reads 4%. The gate must select the fresh window and
  // allow — not lock onto the higher-percent stale phantom and block conservatively forever.
  const gate = new StateLimitGate(
    () =>
      limits([
        snapshot({
          id: 'phantom',
          windowKey: 'custom:2-59pm-europe-istanbul',
          label: '2:59pm (Europe/Istanbul)',
          percentUsed: 10,
          parseConfidence: 'unknown',
          resetAt: null,
          checkedAt: '2026-06-17T06:00:00.000Z', // >24h stale
        }),
        snapshot({
          id: 'fresh-weekly',
          windowKey: 'weekly',
          label: 'Current week (all models)',
          percentUsed: 4,
          checkedAt: NOW.toISOString(),
        }),
      ]),
    { now: NOW, staleAfterMs: 15 * 60 * 1000 },
  );

  const decision = await gate.check('claude');

  assert.equal(decision.allowed, true);
  assert.equal(decision.action, 'allow');
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
