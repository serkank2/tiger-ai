import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryQueueRepository } from './MemoryQueueRepository.js';
import {
  Scheduler,
  type QueueOrchestrator,
  type QueueTeamTargetRuntime,
  type QueueTerminalTargetRuntime,
} from './Scheduler.js';
import { QueueService } from '../services/QueueService.js';
import { defaultTigerConfig } from '../orchestrator/config.js';
import type { ExecutionOwner } from '../orchestrator/persistence.js';
import {
  STAGE_ORDER,
  type OrchestratorState,
  type StageId,
  type StageRunConfig,
  type TigerConfig,
} from '../orchestrator/types.js';
import type { TerminalDefinition, TerminalRuntimeStatus } from '../store/types.js';
import type { QueueJob } from './types.js';

function blankState(): OrchestratorState {
  const stages = {} as OrchestratorState['stages'];
  for (const stage of STAGE_ORDER) stages[stage] = { id: stage, status: 'not_started', runs: [] };
  return {
    workspace: null,
    tigerRoot: null,
    initialized: false,
    projectPromptPreview: '',
    currentStage: null,
    busy: false,
    stages,
    tasks: null,
    findings: null,
    correctionCycles: 0,
    maxCorrectionCycles: 2,
    autoAdvance: false,
  };
}

class FakeOrchestrator extends EventEmitter implements QueueOrchestrator {
  readonly config: TigerConfig = defaultTigerConfig();
  readonly prompts: string[] = [];
  readonly startedStages: StageId[] = [];
  /** Owner active when each stage started — used to assert queue-dispatched runs are queue-owned. */
  readonly stageOwners: (ExecutionOwner | null)[] = [];
  private activeOwner: ExecutionOwner | null = null;
  private state = blankState();

  setExecutionOwner(owner: ExecutionOwner | null): void {
    this.activeOwner = owner;
  }

  async initialize(workspace: string, projectPrompt: string): Promise<void> {
    this.prompts.push(projectPrompt);
    this.state = blankState();
    this.state.workspace = workspace;
    this.state.tigerRoot = path.join(workspace, '.tiger');
    this.state.initialized = true;
    this.state.projectPromptPreview = projectPrompt.slice(0, 400);
    this.emit('state', this.getState());
  }

  getConfig(): TigerConfig {
    return this.config;
  }

  getState(): OrchestratorState {
    return structuredClone(this.state);
  }

  startStage(stageId: StageId, _cfg: StageRunConfig): void {
    if (this.state.busy) throw new Error('already running');
    this.startedStages.push(stageId);
    this.stageOwners.push(this.activeOwner);
    this.state.busy = true;
    this.state.currentStage = stageId;
    this.state.stages[stageId] = { id: stageId, status: 'running', runs: [] };
    this.emit('state', this.getState());
    setTimeout(() => {
      this.state.busy = false;
      this.state.stages[stageId] = { id: stageId, status: 'completed', runs: [] };
      this.emit('state', this.getState());
    }, 2).unref();
  }

  stopStage(): void {
    const stage = this.state.currentStage;
    if (!stage) return;
    this.state.busy = false;
    this.state.stages[stage] = { id: stage, status: 'stopped', runs: [], message: 'Stopped.' };
    this.emit('state', this.getState());
  }
}

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

class FakeTeamTarget implements QueueTeamTargetRuntime {
  readonly steered: string[] = [];
  readonly createdInputs: Parameters<QueueTeamTargetRuntime['createTeamRun']>[0][] = [];
  started = 0;
  private active: { runId: string } | null;

  constructor(activeRunId?: string) {
    this.active = activeRunId ? { runId: activeRunId } : null;
  }

  tryGetState(): { runId: string } | null {
    return this.active;
  }

  async steer(body: string): Promise<unknown> {
    this.steered.push(body);
    return {};
  }

  async createTeamRun(input: Parameters<QueueTeamTargetRuntime['createTeamRun']>[0]): Promise<{ runId: string }> {
    this.createdInputs.push(input);
    this.active = { runId: 'created-team-run' };
    return this.active;
  }

  async start(): Promise<unknown> {
    this.started++;
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

test('Scheduler runs queued prompts strictly one at a time in queue order', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-queue-scheduler-'));
  const repo = new MemoryQueueRepository();
  const service = new QueueService(repo, undefined, { queuePipelineV2: 'off' });
  const orchestrator = new FakeOrchestrator();
  const scheduler = new Scheduler(service, orchestrator, { owner: 'test-scheduler', leaseMs: 1000, idlePollMs: 1000 });
  try {
    const first = await service.enqueue({
      prompt: 'First autonomous prompt',
      provider: 'codex',
      workspacePath: path.join(temp, 'first'),
    });
    assert.equal(first.targetType, 'project');
    assert.equal((await service.listSteps(first.id)).length, STAGE_ORDER.length);
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

    assert.deepEqual(orchestrator.prompts, ['First autonomous prompt', 'Second autonomous prompt']);
    assert.equal(orchestrator.startedStages.length, STAGE_ORDER.length * 2);
    assert.deepEqual(orchestrator.startedStages.slice(0, STAGE_ORDER.length), STAGE_ORDER);
    assert.deepEqual(orchestrator.startedStages.slice(STAGE_ORDER.length), STAGE_ORDER);
    // Every queue-dispatched stage must run under a queue owner so persisted runs are not recorded as manual.
    assert.equal(orchestrator.stageOwners.length, STAGE_ORDER.length * 2);
    assert.ok(
      orchestrator.stageOwners.every((owner) => owner?.type === 'queue'),
      'queue-dispatched stages should run under a queue execution owner',
    );
  } finally {
    scheduler.stop();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('Scheduler dispatches terminal target jobs and records the terminal id', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-queue-terminal-'));
  const service = new QueueService(new MemoryQueueRepository(), undefined, { queuePipelineV2: 'on' });
  const orchestrator = new FakeOrchestrator();
  const terminal = new FakeTerminalTarget(temp);
  const scheduler = new Scheduler(service, orchestrator, {
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
    assert.equal(orchestrator.startedStages.length, 0);
  } finally {
    scheduler.stop();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('Scheduler dispatches team append jobs to the active run', async () => {
  const service = new QueueService(new MemoryQueueRepository(), undefined, { queuePipelineV2: 'on' });
  const orchestrator = new FakeOrchestrator();
  const team = new FakeTeamTarget('team-run-1');
  const scheduler = new Scheduler(service, orchestrator, {
    owner: 'team-scheduler',
    leaseMs: 1000,
    idlePollMs: 1000,
    teamTarget: team,
  });
  try {
    const job = await service.enqueue({
      prompt: 'fallback team prompt',
      body: 'Refine the implementation plan.',
      target: 'team',
      payload: { mode: 'append', runId: 'team-run-1' },
    });

    await scheduler.start();
    await waitFor(async () => (await service.getJob(job.id))?.status === 'completed', 'team append completion');

    assert.deepEqual(team.steered, ['Refine the implementation plan.']);
    assert.deepEqual((await service.getJob(job.id))?.targetRef, { runId: 'team-run-1' });
    assert.equal(orchestrator.startedStages.length, 0);
  } finally {
    scheduler.stop();
  }
});

test('Scheduler fails only the team append item when no active run exists', async () => {
  const service = new QueueService(new MemoryQueueRepository(), undefined, { queuePipelineV2: 'on' });
  const orchestrator = new FakeOrchestrator();
  const team = new FakeTeamTarget();
  const scheduler = new Scheduler(service, orchestrator, {
    owner: 'team-fail-scheduler',
    leaseMs: 1000,
    idlePollMs: 1000,
    teamTarget: team,
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
  assert.match(failed?.blockedReason ?? '', /No active team run is available/);
  assert.deepEqual(team.steered, []);
  assert.equal((await service.getJob(queuedJob.id))?.status, 'queued');
});
