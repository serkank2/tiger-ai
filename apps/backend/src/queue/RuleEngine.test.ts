import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleEngine } from './RuleEngine.js';
import type { QueueJob, QueueJobConfigSnapshot, QueueRule } from './types.js';
import type { StageRunConfig } from '../orchestrator/types.js';

const now = new Date('2026-06-18T09:00:00.000Z');

function stageCfg(over: Partial<StageRunConfig>): StageRunConfig {
  return {
    claudeAgents: 0,
    codexAgents: 0,
    antigravityAgents: 0,
    claudeModel: '',
    codexModel: '',
    antigravityModel: '',
    claudeEffort: '',
    codexEffort: '',
    antigravityEffort: '',
    claudePermission: 'dangerous',
    codexPermission: 'yolo',
    antigravityPermission: 'dangerous',
    parallel: true,
    ...over,
  };
}

function job(provider: QueueJob['provider'] = 'claude', configSnapshot: QueueJobConfigSnapshot = {}): QueueJob {
  return {
    id: 'job-1',
    position: 1,
    status: 'queued',
    priority: 0,
    provider,
    workspacePath: 'C:/tmp/job-1',
    projectName: 'Job 1',
    prompt: 'Build it',
    configSnapshot,
    attempts: 0,
    maxAttempts: 1,
    blockedReason: null,
    resumeAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    currentStep: null,
    startedAt: null,
    completedAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function rule(): QueueRule {
  return {
    id: 'rule-1',
    name: 'Claude 90',
    enabled: true,
    provider: 'claude',
    windowKey: 'any',
    metric: 'percent_used',
    operator: 'gte',
    threshold: 90,
    action: 'block_dispatch',
    config: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

test('RuleEngine blocks Claude dispatch at or above the configured threshold', () => {
  const decision = new RuleEngine().evaluate(
    job('claude'),
    [rule()],
    {
      claude: {
        provider: 'claude',
        windowKey: '5h',
        percentUsed: 91,
        resetAt: '2026-06-18T10:00:00.000Z',
        checkedAt: now.toISOString(),
      },
    },
    now,
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.ruleId, 'rule-1');
  assert.equal(decision.resumeAfter, '2026-06-18T10:00:00.000Z');
});

test('RuleEngine blocks conservatively when a matching provider snapshot is unavailable', () => {
  const decision = new RuleEngine().evaluate(job('claude'), [rule()], {}, now);
  assert.equal(decision.allowed, false);
  assert.equal(decision.ruleId, 'rule-1');
  assert.match(decision.reason, /snapshot is unavailable/);
  assert.equal(decision.resumeAfter, null);
});

test('RuleEngine blocks Antigravity dispatch at or above the configured threshold', () => {
  const antigravityRule = { ...rule(), provider: 'antigravity' as const };
  const decision = new RuleEngine().evaluate(
    job('antigravity'),
    [antigravityRule],
    {
      antigravity: {
        provider: 'antigravity',
        windowKey: '5h',
        percentUsed: 93,
        resetAt: '2026-06-18T10:30:00.000Z',
        checkedAt: now.toISOString(),
      },
    },
    now,
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.ruleId, 'rule-1');
  assert.equal(decision.resumeAfter, '2026-06-18T10:30:00.000Z');
  assert.match(decision.reason, /antigravity 5h usage is 93%/);
});

test('RuleEngine evaluates mixed jobs against Antigravity snapshots', () => {
  const decision = new RuleEngine().evaluate(
    job('mixed'),
    [{ ...rule(), provider: 'any' }],
    {
      claude: {
        provider: 'claude',
        windowKey: '5h',
        percentUsed: 20,
        resetAt: '2026-06-18T10:00:00.000Z',
        checkedAt: now.toISOString(),
      },
      codex: {
        provider: 'codex',
        windowKey: '5h',
        percentUsed: 30,
        resetAt: '2026-06-18T10:00:00.000Z',
        checkedAt: now.toISOString(),
      },
      antigravity: {
        provider: 'antigravity',
        windowKey: '5h',
        percentUsed: 94,
        resetAt: '2026-06-18T11:00:00.000Z',
        checkedAt: now.toISOString(),
      },
    },
    now,
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.ruleId, 'rule-1');
  assert.equal(decision.resumeAfter, '2026-06-18T11:00:00.000Z');
  assert.match(decision.reason, /antigravity 5h usage is 94%/);
});

test('RuleEngine does not block a Claude+Codex mixed job on a missing Antigravity snapshot', () => {
  // Review finding 2: a mixed job whose config snapshot uses only claude+codex (antigravityAgents: 0)
  // must NOT be blocked by an `any` rule just because no Antigravity snapshot exists.
  const mixedJob = job('mixed', {
    configs: { 'writing-plan': stageCfg({ claudeAgents: 1, codexAgents: 1, antigravityAgents: 0 }) },
  });
  const decision = new RuleEngine().evaluate(
    mixedJob,
    [{ ...rule(), provider: 'any' }],
    {
      claude: { provider: 'claude', windowKey: '5h', percentUsed: 20, resetAt: '2026-06-18T10:00:00.000Z', checkedAt: now.toISOString() },
      codex: { provider: 'codex', windowKey: '5h', percentUsed: 30, resetAt: '2026-06-18T10:00:00.000Z', checkedAt: now.toISOString() },
      // No Antigravity snapshot at all — it must be irrelevant because the job does not use it.
    },
    now,
  );
  assert.equal(decision.allowed, true);
});

test('RuleEngine still gates a mixed job that actually uses Antigravity', () => {
  const mixedJob = job('mixed', {
    configs: { 'writing-plan': stageCfg({ claudeAgents: 1, antigravityAgents: 1 }) },
  });
  const decision = new RuleEngine().evaluate(
    mixedJob,
    [{ ...rule(), provider: 'any' }],
    {
      claude: { provider: 'claude', windowKey: '5h', percentUsed: 10, resetAt: '2026-06-18T10:00:00.000Z', checkedAt: now.toISOString() },
      antigravity: { provider: 'antigravity', windowKey: '5h', percentUsed: 95, resetAt: '2026-06-18T11:00:00.000Z', checkedAt: now.toISOString() },
    },
    now,
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /antigravity 5h usage is 95%/);
});

test('RuleEngine evaluates a window-specific rule against its OWN window snapshot (multi-window)', () => {
  // Review finding 2: a window-specific rule must see its window's snapshot even when another
  // window was probed more recently. Passing an array of per-window snapshots fixes the prior
  // single-latest-snapshot bug where a '7d' rule silently never fired because the latest snapshot
  // happened to be a '5h' window.
  const weeklyRule: QueueRule = { ...rule(), id: 'rule-7d', windowKey: '7d', threshold: 80 };
  const decision = new RuleEngine().evaluate(
    job('claude'),
    [weeklyRule],
    {
      claude: [
        // 5h is the most-recently-checked window but is under threshold and irrelevant to the rule.
        { provider: 'claude', windowKey: '5h', percentUsed: 10, resetAt: '2026-06-18T10:00:00.000Z', checkedAt: '2026-06-18T08:59:00.000Z' },
        // 7d window is over the rule's threshold; it must be the one evaluated.
        { provider: 'claude', windowKey: '7d', percentUsed: 85, resetAt: '2026-06-25T00:00:00.000Z', checkedAt: '2026-06-18T08:00:00.000Z' },
      ],
    },
    now,
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.ruleId, 'rule-7d');
  assert.match(decision.reason, /claude 7d usage is 85%/);
  assert.equal(decision.resumeAfter, '2026-06-25T00:00:00.000Z');
});

test('RuleEngine blocks when the rule window has no snapshot even if another window exists', () => {
  const weeklyRule: QueueRule = { ...rule(), id: 'rule-7d', windowKey: '7d', threshold: 80 };
  const decision = new RuleEngine().evaluate(
    job('claude'),
    [weeklyRule],
    {
      // Only a 5h snapshot exists; the 7d rule cannot prove it is under the limit → block.
      claude: [{ provider: 'claude', windowKey: '5h', percentUsed: 10, resetAt: null, checkedAt: now.toISOString() }],
    },
    now,
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /snapshot is unavailable/);
});

test('RuleEngine still accepts a single snapshot (back-compat) and evaluates its window', () => {
  const decision = new RuleEngine().evaluate(
    job('claude'),
    [rule()],
    { claude: { provider: 'claude', windowKey: '5h', percentUsed: 95, resetAt: '2026-06-18T10:00:00.000Z', checkedAt: now.toISOString() } },
    now,
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /claude 5h usage is 95%/);
});

test('RuleEngine allows dispatch below threshold or after the reset time', () => {
  const engine = new RuleEngine();
  assert.equal(
    engine.evaluate(
      job('claude'),
      [rule()],
      {
        claude: {
          provider: 'claude',
          windowKey: '5h',
          percentUsed: 89,
          resetAt: '2026-06-18T10:00:00.000Z',
          checkedAt: now.toISOString(),
        },
      },
      now,
    ).allowed,
    true,
  );
  assert.equal(
    engine.evaluate(
      job('claude'),
      [rule()],
      {
        claude: {
          provider: 'claude',
          windowKey: '5h',
          percentUsed: 99,
          resetAt: '2026-06-18T08:59:00.000Z',
          checkedAt: now.toISOString(),
        },
      },
      now,
    ).allowed,
    true,
  );
});
