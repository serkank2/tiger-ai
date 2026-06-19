import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryQueueRepository } from './MemoryQueueRepository.js';
import { QueueService } from '../services/QueueService.js';

test('QueueService enqueues, reorders, pauses, resumes, cancels, and retries jobs transactionally', async () => {
  const repo = new MemoryQueueRepository();
  const service = new QueueService(repo);
  const first = await service.enqueue({ prompt: 'First prompt', provider: 'codex' });
  const second = await service.enqueue({ prompt: 'Second prompt', provider: 'codex' });

  await service.reorder([second.id, first.id]);
  let state = await service.getState();
  assert.deepEqual(
    state.jobs.map((job) => job.id),
    [second.id, first.id],
  );

  const leased = await service.leaseNext('test-worker', 60_000);
  assert.equal(leased.kind, 'leased');
  assert.equal(leased.kind === 'leased' ? leased.job.id : '', second.id);

  await service.pause(second.id);
  assert.equal((await service.getJob(second.id))?.status, 'paused');
  await service.resume(second.id);
  assert.equal((await service.getJob(second.id))?.status, 'queued');

  await service.cancel(second.id);
  assert.equal((await service.getJob(second.id))?.status, 'canceled');
  await service.retry(second.id);
  assert.equal((await service.getJob(second.id))?.status, 'retrying');

  state = await service.getState();
  assert.equal(state.jobs.find((job) => job.id === first.id)?.steps.length, 7);
  assert.ok(state.events.some((event) => event.jobId === first.id && event.type === 'queue.submitted'));
  assert.ok(state.events.some((event) => event.jobId === second.id && event.type === 'queue.paused'));

  const restored = new QueueService(repo);
  const restoredState = await restored.getState();
  assert.ok(restoredState.events.some((event) => event.jobId === second.id && event.type === 'queue.resumed'));
});

test('QueueService blocks Claude leases at 90 percent and resumes from a fresh lower snapshot', async () => {
  const repo = new MemoryQueueRepository();
  const service = new QueueService(repo);
  repo.addLimitSnapshot({
    provider: 'claude',
    windowKey: '5h',
    percentUsed: 90,
    resetAt: '2099-01-01T00:00:00.000Z',
    checkedAt: '2026-06-18T09:00:00.000Z',
  });
  const job = await service.enqueue({ prompt: 'Claude prompt', provider: 'claude' });

  const blocked = await service.leaseNext('test-worker', 60_000);
  assert.equal(blocked.kind, 'blocked');
  assert.equal((await service.getJob(job.id))?.status, 'blocked_by_limit');
  assert.equal((await service.getJob(job.id))?.resumeAfter, '2099-01-01T00:00:00.000Z');

  repo.addLimitSnapshot({
    provider: 'claude',
    windowKey: '5h',
    percentUsed: 12,
    resetAt: '2099-01-01T00:00:00.000Z',
    checkedAt: '2026-06-18T09:01:00.000Z',
  });
  assert.equal(await service.resumeLimitBlockedJobs(), 1);
  assert.equal((await service.getJob(job.id))?.status, 'queued');
});

test('QueueService reclaims stale leases without resetting completed steps', async () => {
  const repo = new MemoryQueueRepository();
  const service = new QueueService(repo);
  const job = await service.enqueue({ prompt: 'Recover me', provider: 'codex' });
  const leased = await service.leaseNext('queue-test', -1);
  assert.equal(leased.kind, 'leased');
  await service.markStepCompleted(job.id, 'brainstorming');
  await service.markStepRunning(job.id, 'writing-plan');

  assert.equal(await service.reclaimStaleLeases('queue-test'), 1);
  const steps = await service.listSteps(job.id);
  assert.equal(steps.find((step) => step.stepKey === 'brainstorming')?.status, 'completed');
  assert.equal(steps.find((step) => step.stepKey === 'writing-plan')?.status, 'pending');
  assert.equal((await service.getJob(job.id))?.status, 'retrying');
});

test('bulk emits exactly one coalesced state event for the whole batch', async () => {
  const repo = new MemoryQueueRepository(false);
  const service = new QueueService(repo);
  const a = await service.enqueue({ prompt: 'a' });
  const b = await service.enqueue({ prompt: 'b' });
  const c = await service.enqueue({ prompt: 'c' });

  let stateEmits = 0;
  service.on('state', () => stateEmits++);

  const results = await service.bulk('cancel', [a.id, b.id, c.id]);
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal(stateEmits, 1, 'one coalesced state broadcast for the batch, not one per job');
  assert.equal((await service.getJob(a.id))?.status, 'canceled');
  assert.equal((await service.getJob(c.id))?.status, 'canceled');
});
