import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryQueueRepository } from './MemoryQueueRepository.js';
import type { QueueJob, QueueStep } from './types.js';

function job(overrides: Partial<QueueJob> & Pick<QueueJob, 'id'>): QueueJob {
  const now = '2026-06-19T00:00:00.000Z';
  return {
    position: 1,
    status: 'queued',
    priority: 0,
    provider: 'claude',
    workspacePath: `/tmp/${overrides.id}`,
    projectName: null,
    prompt: 'p',
    configSnapshot: {},
    attempts: 0,
    maxAttempts: 3,
    blockedReason: null,
    resumeAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    currentStep: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function step(overrides: Partial<QueueStep> & Pick<QueueStep, 'id' | 'jobId'>): QueueStep {
  const now = '2026-06-19T00:00:00.000Z';
  return {
    stepKey: 'brainstorming',
    position: 1,
    status: 'pending',
    attempts: 0,
    error: null,
    checkpoint: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const NOW = '2026-06-19T01:00:00.000Z';

test('lockDispatchableJobs returns dispatchable jobs in dispatch order', async () => {
  const repo = new MemoryQueueRepository(false);
  await repo.insertJob(job({ id: 'a', position: 2, priority: 0 }));
  await repo.insertJob(job({ id: 'b', position: 1, priority: 0 }));
  await repo.insertJob(job({ id: 'c', position: 3, priority: 5 }));
  // Not dispatchable: running, future resumeAfter, live lease.
  await repo.insertJob(job({ id: 'running', status: 'running' }));
  await repo.insertJob(job({ id: 'future', resumeAfter: '2999-01-01T00:00:00.000Z' }));
  await repo.insertJob(job({ id: 'leased', leaseExpiresAt: '2999-01-01T00:00:00.000Z' }));
  await repo.insertJob(job({ id: 'retry', status: 'retrying', position: 4 }));

  const dispatchable = await repo.lockDispatchableJobs(NOW);
  assert.deepEqual(
    dispatchable.map((j) => j.id),
    ['c', 'b', 'a', 'retry'],
  );
});

test('lockReclaimableJobs only returns running jobs with expired leases or matching owner', async () => {
  const repo = new MemoryQueueRepository(false);
  await repo.insertJob(
    job({ id: 'expired', status: 'running', leaseOwner: 'other', leaseExpiresAt: '2000-01-01T00:00:00.000Z' }),
  );
  await repo.insertJob(
    job({ id: 'mine', status: 'running', leaseOwner: 'me', leaseExpiresAt: '2999-01-01T00:00:00.000Z' }),
  );
  await repo.insertJob(
    job({ id: 'live', status: 'running', leaseOwner: 'other', leaseExpiresAt: '2999-01-01T00:00:00.000Z' }),
  );
  await repo.insertJob(job({ id: 'noexpiry', status: 'running', leaseOwner: 'other', leaseExpiresAt: null }));
  await repo.insertJob(job({ id: 'queued', status: 'queued' }));

  const reclaimable = (await repo.lockReclaimableJobs(NOW, 'me')).map((j) => j.id).sort();
  // 'live' (other owner, lease not expired) must NOT be stolen.
  assert.deepEqual(reclaimable, ['expired', 'mine', 'noexpiry']);
});

test('listStepsForJobs batches steps for many jobs in one call', async () => {
  const repo = new MemoryQueueRepository(false);
  await repo.insertStep(step({ id: 's1', jobId: 'a', position: 2 }));
  await repo.insertStep(step({ id: 's2', jobId: 'a', position: 1 }));
  await repo.insertStep(step({ id: 's3', jobId: 'b', position: 1 }));
  await repo.insertStep(step({ id: 's4', jobId: 'c', position: 1 }));

  assert.deepEqual(await repo.listStepsForJobs([]), []);

  const steps = await repo.listStepsForJobs(['a', 'b']);
  assert.deepEqual(
    steps.map((s) => s.id),
    ['s2', 's1', 's3'],
  );
});

test('replacePositions renumbers requested ids first, then the rest, contiguously', async () => {
  const repo = new MemoryQueueRepository(false);
  await repo.insertJob(job({ id: 'a', position: 1 }));
  await repo.insertJob(job({ id: 'b', position: 2 }));
  await repo.insertJob(job({ id: 'c', position: 3 }));

  await repo.replacePositions(['c', 'a'], NOW);
  const jobs = await repo.listJobs();
  assert.deepEqual(
    jobs.map((j) => [j.id, j.position]),
    [
      ['c', 1],
      ['a', 2],
      ['b', 3],
    ],
  );
});

test('getLatestLimitSnapshotsByWindow returns the latest snapshot per window', async () => {
  const repo = new MemoryQueueRepository(false);
  // Two windows for claude, each with an older + newer snapshot; one codex window (filtered out).
  repo.addLimitSnapshot({
    provider: 'claude',
    windowKey: '5h',
    percentUsed: 10,
    resetAt: null,
    checkedAt: '2026-06-19T01:00:00.000Z',
  });
  repo.addLimitSnapshot({
    provider: 'claude',
    windowKey: '5h',
    percentUsed: 55,
    resetAt: null,
    checkedAt: '2026-06-19T03:00:00.000Z',
  });
  repo.addLimitSnapshot({
    provider: 'claude',
    windowKey: '7d',
    percentUsed: 40,
    resetAt: null,
    checkedAt: '2026-06-19T02:00:00.000Z',
  });
  repo.addLimitSnapshot({
    provider: 'codex',
    windowKey: '5h',
    percentUsed: 99,
    resetAt: null,
    checkedAt: '2026-06-19T04:00:00.000Z',
  });

  const claude = await repo.getLatestLimitSnapshotsByWindow('claude');
  const byWindow = new Map(claude.map((s) => [s.windowKey, s.percentUsed]));
  assert.equal(claude.length, 2);
  assert.equal(byWindow.get('5h'), 55); // newest 5h wins
  assert.equal(byWindow.get('7d'), 40);

  assert.deepEqual(await repo.getLatestLimitSnapshotsByWindow('antigravity'), []);
});
