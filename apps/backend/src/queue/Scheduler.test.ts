import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryQueueRepository } from './MemoryQueueRepository.js';
import { Scheduler, type QueueRunTargetRuntime, type QueueTerminalTargetRuntime } from './Scheduler.js';
import { QueueService } from '../services/QueueService.js';
import type { TerminalDefinition, TerminalRuntimeStatus } from '../store/types.js';
import type { QueueJob } from './types.js';

class FakeTerminalTarget implements QueueTerminalTargetRuntime {
  readonly state: QueueTerminalTargetRuntime['state'];
  readonly upserted: TerminalDefinition[] = [];
  readonly started: { id: string; cols?: number; rows?: number }[] = [];
  saveCount = 0;

  readonly manager = {
    upsertDefinition: (def: TerminalDefinition): { deferred: boolean } => {
      this.upserted.push(structuredClone(def));
      return { deferred: false };
    },
    start: async (id: string, cols?: number, rows?: number): Promise<TerminalRuntimeStatus> => {
      this.started.push({ id, cols, rows });
      return { id, state: 'running', cols: cols ?? 80, rows: rows ?? 30, exitCode: null };
    },
  };

  constructor(defaultCwd: string) {
    this.state = {
      terminals: [],
      settings: {
        theme: 'dark',
        defaultCwd,
        defaultShell: { kind: 'system-default' },
        commandRouting: { appendNewlineByDefault: true, startTerminalOnSend: true },
      },
    };
  }

  async save(): Promise<void> {
    this.saveCount++;
  }
}

/** Fake v2 run engine: createRun + start resolve to `finalStatus` on the next tick. */
class FakeRunTarget extends EventEmitter implements QueueRunTargetRuntime {
  readonly goals: string[] = [];
  readonly workspaces: string[] = [];
  readonly steered: string[] = [];
  private active: { runId: string; status: string } | null;
  private counter = 0;

  constructor(
    private readonly finalStatus: 'completed' | 'blocked' | 'failed' = 'completed',
    activeRunId?: string,
  ) {
    super();
    this.active = activeRunId ? { runId: activeRunId, status: 'running' } : null;
  }

  getSnapshot(): { runId: string; status: string } | null {
    return this.active;
  }

  async createRun(input: { workspace: string; goal: string }): Promise<{ runId: string }> {
    this.goals.push(input.goal);
    this.workspaces.push(input.workspace);
    this.counter += 1;
    this.active = { runId: `fake-run-${this.counter}`, status: 'created' };
    return { runId: this.active.runId };
  }

  start(): { runId: string; status: string } {
    const run = this.active;
    if (!run) throw new Error('no run created');
    run.status = 'running';
    setTimeout(() => {
      run.status = this.finalStatus;
      this.emit('engine-event', { kind: 'state', state: { runId: run.runId, status: this.finalStatus } });
    }, 2).unref();
    return { runId: run.runId, status: 'running' };
  }

  async stop(): Promise<unknown> {
    return {};
  }

  async steer(body: string): Promise<unknown> {
    this.steered.push(body);
    return {};
  }
}

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!(await predicate())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runLeasedJobOnce(scheduler: Scheduler, job: QueueJob): Promise<void> {
  await (scheduler as unknown as { runJob(job: QueueJob): Promise<void> }).runJob(job);
}

test('Scheduler runs queued prompts one at a time as v2 runs, in queue order', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-queue-scheduler-'));
  const repo = new MemoryQueueRepository();
  const service = new QueueService(repo, undefined, { queuePipelineV2: 'off' });
  const runTarget = new FakeRunTarget();
  const scheduler = new Scheduler(service, { owner: 'test-scheduler', leaseMs: 1000, idlePollMs: 1000, runTarget });
  try {
    const first = await service.enqueue({
      prompt: 'First autonomous prompt',
      provider: 'codex',
      workspacePath: path.join(temp, 'first'),
    });
    assert.equal(first.targetType, 'project');
    await service.enqueue({
      prompt: 'Second autonomous prompt',
      provider: 'codex',
      workspacePath: path.join(temp, 'second'),
    });
    await scheduler.start();
    await waitFor(
      async () => (await service.getState()).jobs.every((job) => job.status === 'completed'),
      'queue completion',
    );

    assert.deepEqual(runTarget.goals, ['First autonomous prompt', 'Second autonomous prompt']);
    assert.equal(runTarget.workspaces.length, 2);
    const firstJob = await service.getJob(first.id);
    assert.deepEqual(firstJob?.targetRef, { runId: 'fake-run-1' });
  } finally {
    scheduler.stop();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('Scheduler fails a project job whose run ends blocked', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-queue-blocked-'));
  const service = new QueueService(new MemoryQueueRepository(), undefined, { queuePipelineV2: 'off' });
  const runTarget = new FakeRunTarget('blocked');
  const scheduler = new Scheduler(service, { owner: 'blocked-scheduler', leaseMs: 1000, idlePollMs: 1000, runTarget });
  const job = await service.enqueue({
    prompt: 'Doomed prompt',
    provider: 'codex',
    workspacePath: path.join(temp, 'ws'),
    maxAttempts: 1,
  });
  const leased = await service.leaseNext('blocked-scheduler', 1000);
  assert.equal(leased.kind, 'leased');
  if (leased.kind !== 'leased') return;
  await runLeasedJobOnce(scheduler, leased.job);
  const failed = await service.getJob(job.id);
  assert.equal(failed?.status, 'failed');
  assert.match(failed?.blockedReason ?? '', /blocked/);
  await fs.rm(temp, { recursive: true, force: true });
});

test('Scheduler dispatches terminal target jobs and records the terminal id', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-queue-terminal-'));
  const service = new QueueService(new MemoryQueueRepository(), undefined, { queuePipelineV2: 'on' });
  const terminal = new FakeTerminalTarget(temp);
  const scheduler = new Scheduler(service, {
    owner: 'terminal-scheduler',
    leaseMs: 1000,
    idlePollMs: 1000,
    terminalTarget: terminal,
  });
  try {
    const cwd = path.join(temp, 'terminal-workspace');
    const job = await service.enqueue({
      prompt: 'fallback command',
      body: 'npm test',
      target: 'terminal',
      payload: { name: 'Run tests', cwd, cols: 120, rows: 40 },
    });
    assert.equal((await service.listSteps(job.id)).length, 0);

    await scheduler.start();
    await waitFor(async () => (await service.getJob(job.id))?.status === 'completed', 'terminal job completion');

    const [def] = terminal.state.terminals;
    assert.ok(def);
    assert.equal(def.name, 'Run tests');
    assert.equal(def.cwd, cwd);
    assert.equal(def.initialCommand, 'npm test');
    assert.deepEqual(
      terminal.upserted.map((item) => item.id),
      [def.id],
    );
    assert.deepEqual(terminal.started, [{ id: def.id, cols: 120, rows: 40 }]);
    assert.equal(terminal.saveCount, 1);
    assert.deepEqual((await service.getJob(job.id))?.targetRef, { terminalId: def.id });
  } finally {
    scheduler.stop();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('Scheduler dispatches team append jobs as steering on the active run', async () => {
  const service = new QueueService(new MemoryQueueRepository(), undefined, { queuePipelineV2: 'on' });
  const runTarget = new FakeRunTarget('completed', 'team-run-1');
  const scheduler = new Scheduler(service, { owner: 'team-scheduler', leaseMs: 1000, idlePollMs: 1000, runTarget });
  try {
    const job = await service.enqueue({
      prompt: 'fallback team prompt',
      body: 'Refine the implementation plan.',
      target: 'team',
      payload: { mode: 'append', runId: 'team-run-1' },
    });

    await scheduler.start();
    await waitFor(async () => (await service.getJob(job.id))?.status === 'completed', 'team append completion');

    assert.deepEqual(runTarget.steered, ['Refine the implementation plan.']);
    assert.deepEqual((await service.getJob(job.id))?.targetRef, { runId: 'team-run-1' });
  } finally {
    scheduler.stop();
  }
});

test('Scheduler fails only the append item when no active run exists', async () => {
  const service = new QueueService(new MemoryQueueRepository(), undefined, { queuePipelineV2: 'on' });
  const runTarget = new FakeRunTarget();
  const scheduler = new Scheduler(service, {
    owner: 'team-fail-scheduler',
    leaseMs: 1000,
    idlePollMs: 1000,
    runTarget,
  });
  const failedJob = await service.enqueue({
    prompt: 'Append to a missing run.',
    target: 'team',
    payload: { mode: 'append', runId: 'missing-run' },
    maxAttempts: 1,
  });
  const queuedJob = await service.enqueue({ prompt: 'This project should remain queued.', provider: 'codex' });

  const leased = await service.leaseNext('team-fail-scheduler', 1000);
  assert.equal(leased.kind, 'leased');
  if (leased.kind !== 'leased') return;
  assert.equal(leased.job.id, failedJob.id);
  await runLeasedJobOnce(scheduler, leased.job);

  const failed = await service.getJob(failedJob.id);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.failureKind, 'team_dispatch');
  assert.match(failed?.blockedReason ?? '', /No active run is available/);
  assert.deepEqual(runTarget.steered, []);
  assert.equal((await service.getJob(queuedJob.id))?.status, 'queued');
});
