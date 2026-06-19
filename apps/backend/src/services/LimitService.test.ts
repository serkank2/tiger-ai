import test from 'node:test';
import assert from 'node:assert/strict';
import type { TerminalManager } from '../terminal/TerminalManager.js';
import type { PersistedState } from '../store/types.js';
import type { UsageProbe } from '../orchestrator/usage.js';
import type { AgentType } from '../orchestrator/types.js';
import { defaultLimitRules, type LimitSnapshot } from '../limits/types.js';
import { evaluateLimitRules, LimitService } from './LimitService.js';

const NOW = new Date('2026-06-18T06:00:00.000Z');

function state(): PersistedState {
  return {
    schemaVersion: 1,
    terminals: [],
    groups: [],
    settings: {
      theme: 'test',
      defaultCwd: 'C:\\',
      defaultShell: { kind: 'system-default' },
      commandRouting: { appendNewlineByDefault: true, startTerminalOnSend: false },
    },
    limits: { snapshots: [], rules: defaultLimitRules('2026-06-18T00:00:00.000Z') },
    updatedAt: NOW.toISOString(),
  };
}

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

test('evaluateLimitRules blocks at the 90% boundary with trusted resumeAfter', () => {
  const decision = evaluateLimitRules([snapshot({ percentUsed: 90 })], defaultLimitRules(), {
    now: NOW,
    staleAfterMs: 60_000,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.action, 'block');
  assert.equal(decision.conservative, false);
  assert.equal(decision.resumeAfter, '2026-06-18T07:00:00.000Z');
});

test('evaluateLimitRules allows below 90%', () => {
  const decision = evaluateLimitRules([snapshot({ percentUsed: 89 })], defaultLimitRules(), {
    now: NOW,
    staleAfterMs: 60_000,
  });
  assert.equal(decision.allowed, true);
});

test('evaluateLimitRules blocks conservatively when no provider snapshot exists', () => {
  const decision = evaluateLimitRules([], defaultLimitRules(), {
    now: NOW,
    staleAfterMs: 60_000,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.conservative, true);
  assert.match(decision.reason, /unavailable/i);
});

test('evaluateLimitRules blocks conservatively when reset_at is unknown', () => {
  const decision = evaluateLimitRules(
    [snapshot({ percentUsed: 91, resetAt: null, parseConfidence: 'unknown' })],
    defaultLimitRules(),
    { now: NOW, staleAfterMs: 60_000 },
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.conservative, true);
  assert.equal(decision.resumeAfter, null);
});

test('evaluateLimitRules blocks conservatively on stale snapshots', () => {
  const decision = evaluateLimitRules(
    [snapshot({ percentUsed: 10, checkedAt: '2026-06-18T05:00:00.000Z' })],
    defaultLimitRules(),
    { now: NOW, staleAfterMs: 10 * 60 * 1000 },
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.conservative, true);
  assert.match(decision.reason, /stale/i);
});

test('evaluateLimitRules blocks conservatively when the latest provider probe failed', () => {
  const decision = evaluateLimitRules(
    [
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
    ],
    defaultLimitRules(),
    { now: NOW, staleAfterMs: 60_000 },
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.conservative, true);
  assert.match(decision.reason, /probe failed/i);
});

test('LimitService.refresh persists normalized snapshots into state', async () => {
  const persisted = state();
  let saves = 0;
  const probe = async (): Promise<Record<AgentType, UsageProbe>> => ({
    claude: {
      type: 'claude',
      ok: true,
      entries: [{ label: '5h limit', percent: 92, metric: 'used', reset: 'resets in 1h' }],
      raw: 'claude panel',
      highlights: [],
      checkedAt: NOW.toISOString(),
    },
    codex: {
      type: 'codex',
      ok: true,
      entries: [{ label: '5h limit', percent: 8, metric: 'left', reset: 'resets in 1h' }],
      raw: 'codex panel',
      highlights: [],
      checkedAt: NOW.toISOString(),
    },
    antigravity: {
      type: 'antigravity',
      ok: false,
      entries: [],
      raw: '',
      highlights: [],
      error: 'Antigravity (agy) exposes no usage/limit command; no limit data is available.',
      checkedAt: NOW.toISOString(),
    },
  });
  const service = new LimitService({
    manager: {} as TerminalManager,
    state: persisted,
    save: async () => {
      saves += 1;
    },
    probe,
    intervalMs: 0,
    staleAfterMs: 60_000,
  });

  const status = await service.refresh('manual');
  assert.equal(saves, 1);
  // claude + codex parsed windows, plus an explicit unsupported Antigravity probe snapshot.
  assert.equal(persisted.limits?.snapshots.length, 3);
  assert.equal(status.latest.find((item) => item.provider === 'codex')?.percentUsed, 92);
  assert.equal(status.providers.antigravity.ok, false);
  assert.equal(status.decision.allowed, false);
});
