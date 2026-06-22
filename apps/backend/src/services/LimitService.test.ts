import test from 'node:test';
import assert from 'node:assert/strict';
import type { TerminalManager } from '../terminal/TerminalManager.js';
import type { PersistedState } from '../store/types.js';
import type { UsageProbe } from '../orchestrator/usage.js';
import type { AgentType } from '../orchestrator/types.js';
import { defaultLimitRules, type LimitRule, type LimitSnapshot, type LimitsPersistedState } from '../limits/types.js';
import type { LimitRepository } from '../repositories/LimitRepository.js';
import { evaluateLimitRules, LimitService, LimitRuleValidationError } from './LimitService.js';

class InMemoryLimitRepository implements LimitRepository {
  snapshots: LimitSnapshot[] = [];
  rules: LimitRule[] = defaultLimitRules('2026-06-18T00:00:00.000Z');
  async load(maxSnapshots: number): Promise<LimitsPersistedState> {
    return { snapshots: this.snapshots.slice(-maxSnapshots), rules: this.rules.slice() };
  }
  async insertSnapshots(snapshots: LimitSnapshot[]): Promise<void> {
    this.snapshots.push(...snapshots);
  }
  async upsertRules(rules: LimitRule[]): Promise<void> {
    for (const rule of rules) await this.upsertRule(rule);
  }
  async upsertRule(rule: LimitRule): Promise<void> {
    const idx = this.rules.findIndex((r) => r.id === rule.id);
    if (idx === -1) this.rules.push(rule);
    else this.rules[idx] = rule;
  }
  async listRules(): Promise<LimitRule[]> {
    return this.rules.slice();
  }
  async deleteRule(id: string): Promise<void> {
    this.rules = this.rules.filter((r) => r.id !== id);
  }
}

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
  // The persisted snapshots are timestamped in the past relative to the real wall clock the refresh
  // path evaluates against, so they read as stale. Under the default fail-open policy a stale /
  // unverifiable probe no longer conservatively blocks — it allows (the operator owns their quota).
  assert.equal(status.decision.allowed, true);
});

function serviceWithRepo(repo: LimitRepository): LimitService {
  return new LimitService({
    manager: {} as TerminalManager,
    state: state(),
    save: async () => {},
    probe: async () => ({}) as Record<AgentType, UsageProbe>,
    repository: repo,
    intervalMs: 0,
    staleAfterMs: 60_000,
  });
}

test('LimitService.createRule persists a new rule to the repository and in-memory mirror', async () => {
  const repo = new InMemoryLimitRepository();
  const service = serviceWithRepo(repo);

  const status = await service.createRule({ provider: 'codex', windowKey: '5h', thresholdPercent: 75, enabled: true });
  const created = status.rules.find((rule) => rule.provider === 'codex' && rule.windowKey === '5h');
  assert.ok(created);
  assert.equal(created.thresholdPercent, 75);
  assert.ok(repo.rules.some((rule) => rule.id === created.id));
});

test('LimitService.updateRule mutates an existing rule', async () => {
  const repo = new InMemoryLimitRepository();
  const service = serviceWithRepo(repo);
  const id = service.listRules()[0]!.id;

  await service.updateRule(id, { provider: 'claude', windowKey: 'any', thresholdPercent: 50, enabled: false });
  const updated = service.listRules().find((rule) => rule.id === id);
  assert.equal(updated?.thresholdPercent, 50);
  assert.equal(updated?.enabled, false);
});

test('LimitService.updateRule rejects an unknown id', async () => {
  const service = serviceWithRepo(new InMemoryLimitRepository());
  await assert.rejects(
    () => service.updateRule('nope', { provider: 'claude', windowKey: 'any', thresholdPercent: 90, enabled: true }),
    LimitRuleValidationError,
  );
});

test('LimitService.deleteRule removes the rule everywhere', async () => {
  const repo = new InMemoryLimitRepository();
  const service = serviceWithRepo(repo);
  // Create an extra rule so deleting it doesn't trip the "re-seed defaults when empty" guard.
  const created = (await service.createRule({ provider: 'codex', windowKey: '5h', thresholdPercent: 70, enabled: true }))
    .rules.find((rule) => rule.provider === 'codex')!;

  const status = await service.deleteRule(created.id);
  assert.equal(status.rules.some((rule) => rule.id === created.id), false);
  assert.equal(repo.rules.some((rule) => rule.id === created.id), false);
});

test('LimitService fails open in getState when snapshots are unavailable', async () => {
  const repo = new InMemoryLimitRepository();
  // Simulate a missing snapshot table by flagging the load result.
  repo.load = async () => ({ snapshots: [], rules: repo.rules.slice(), snapshotsUnavailable: true });
  const service = serviceWithRepo(repo);
  await service.initialize();

  const status = service.getState();
  assert.equal(status.decision.allowed, true);
  assert.equal(status.decision.action, 'allow');
});
