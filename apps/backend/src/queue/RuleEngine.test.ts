import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleEngine } from './RuleEngine.js';
import type { QueueJob, QueueRule } from './types.js';

const now = new Date('2026-06-18T09:00:00.000Z');

function job(provider: QueueJob['provider'] = 'claude'): QueueJob {
  return {
    id: 'job-1',
    position: 1,
    status: 'queued',
    priority: 0,
    provider,
    workspacePath: 'C:/tmp/job-1',
    projectName: 'Job 1',
    prompt: 'Build it',
    configSnapshot: {},
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
