import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryQueueRepository } from './MemoryQueueRepository.js';
import { QueueService } from '../services/QueueService.js';
import type { QueueProviderConcurrency } from './concurrency.js';

const LIMITS: QueueProviderConcurrency = { claude: 2, codex: 2, antigravity: 1, mixed: 1 };

test('leaseNext enforces per-provider concurrency lanes', async () => {
  const repo = new MemoryQueueRepository(false);
  const service = new QueueService(repo, LIMITS);

  const c1 = await service.enqueue({ prompt: 'claude 1', provider: 'claude' });
  const c2 = await service.enqueue({ prompt: 'claude 2', provider: 'claude' });
  const c3 = await service.enqueue({ prompt: 'claude 3', provider: 'claude' });
  const x1 = await service.enqueue({ prompt: 'codex 1', provider: 'codex' });

  // Two claude lanes available -> first two claude jobs lease.
  const l1 = await service.leaseNext('w', 60_000);
  const l2 = await service.leaseNext('w', 60_000);
  assert.equal(l1.kind, 'leased');
  assert.equal(l2.kind, 'leased');
  assert.deepEqual(
    [l1.kind === 'leased' ? l1.job.id : '', l2.kind === 'leased' ? l2.job.id : ''],
    [c1.id, c2.id],
  );

  // Claude lane is now full (2/2); the next lease must skip c3 and pick the codex job.
  const l3 = await service.leaseNext('w', 60_000);
  assert.equal(l3.kind, 'leased');
  assert.equal(l3.kind === 'leased' ? l3.job.id : '', x1.id);
  assert.equal((await service.getJob(c3.id))?.status, 'queued');

  // No more capacity in any lane with a dispatchable job -> empty.
  const l4 = await service.leaseNext('w', 60_000);
  assert.equal(l4.kind, 'empty');

  // Freeing a claude lane lets the blocked-by-lane claude job dispatch.
  await service.completeJob(c1.id);
  const l5 = await service.leaseNext('w', 60_000);
  assert.equal(l5.kind, 'leased');
  assert.equal(l5.kind === 'leased' ? l5.job.id : '', c3.id);
});

test('default concurrency is 1 per provider (preserves single-at-a-time-per-provider)', async () => {
  const repo = new MemoryQueueRepository(false);
  const service = new QueueService(repo, { claude: 1, codex: 1, antigravity: 1, mixed: 1 });
  await service.enqueue({ prompt: 'a', provider: 'claude' });
  const b = await service.enqueue({ prompt: 'b', provider: 'claude' });

  const first = await service.leaseNext('w', 60_000);
  assert.equal(first.kind, 'leased');
  const second = await service.leaseNext('w', 60_000);
  assert.equal(second.kind, 'empty');
  assert.equal((await service.getJob(b.id))?.status, 'queued');
});

test('getState surfaces runningByProvider and providerConcurrency', async () => {
  const repo = new MemoryQueueRepository(false);
  const service = new QueueService(repo, LIMITS);
  await service.enqueue({ prompt: 'a', provider: 'claude' });
  await service.leaseNext('w', 60_000);

  const state = await service.getState();
  assert.equal(state.runningByProvider.claude, 1);
  assert.equal(state.runningByProvider.codex, 0);
  assert.deepEqual(state.providerConcurrency, LIMITS);
});

test('bulk applies an action per job, skipping incompatible states', async () => {
  const repo = new MemoryQueueRepository(false);
  const service = new QueueService(repo, LIMITS);
  const a = await service.enqueue({ prompt: 'a', provider: 'codex' });
  const b = await service.enqueue({ prompt: 'b', provider: 'codex' });

  // Pause both queued jobs.
  const paused = await service.bulk('pause', [a.id, b.id]);
  assert.deepEqual(paused.map((r) => r.ok), [true, true]);
  assert.equal((await service.getJob(a.id))?.status, 'paused');
  assert.equal((await service.getJob(b.id))?.status, 'paused');

  // Retry is invalid for paused jobs and for a missing id -> reported ok:false, batch continues.
  const retried = await service.bulk('retry', [a.id, 'missing']);
  assert.equal(retried.find((r) => r.id === a.id)?.ok, false);
  assert.equal(retried.find((r) => r.id === 'missing')?.ok, false);
  assert.equal((await service.getJob(a.id))?.status, 'paused');

  // Resume both, then bulk-cancel.
  await service.bulk('resume', [a.id, b.id]);
  const canceled = await service.bulk('cancel', [a.id, b.id]);
  assert.deepEqual(canceled.map((r) => r.ok), [true, true]);
  assert.equal((await service.getJob(a.id))?.status, 'canceled');

  // Bulk delete removes the jobs entirely.
  const deleted = await service.bulk('delete', [a.id, b.id]);
  assert.deepEqual(deleted.map((r) => r.ok), [true, true]);
  assert.equal(await service.getJob(a.id), null);
  assert.equal(await service.getJob(b.id), null);
});

test('deleteJob removes the job, its steps, and unlinks its events', async () => {
  const repo = new MemoryQueueRepository(false);
  const service = new QueueService(repo, LIMITS);
  const job = await service.enqueue({ prompt: 'delete me', provider: 'codex' });
  assert.equal((await service.listSteps(job.id)).length > 0, true);

  await service.deleteJob(job.id);
  assert.equal(await service.getJob(job.id), null);
  assert.equal((await service.listSteps(job.id)).length, 0);
  const state = await service.getState();
  // Events survive but are unlinked from the deleted job (mirrors MySQL ON DELETE SET NULL).
  assert.equal(state.events.some((e) => e.jobId === job.id), false);

  await assert.rejects(() => service.deleteJob(job.id));
});
