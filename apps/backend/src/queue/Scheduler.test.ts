import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryQueueRepository } from './MemoryQueueRepository.js';
import { Scheduler, type QueueOrchestrator } from './Scheduler.js';
import { QueueService } from '../services/QueueService.js';
import { defaultTigerConfig } from '../orchestrator/config.js';
import type { ExecutionOwner } from '../orchestrator/persistence.js';
import { STAGE_ORDER, type OrchestratorState, type StageId, type StageRunConfig, type TigerConfig } from '../orchestrator/types.js';

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

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!(await predicate())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('Scheduler runs queued prompts strictly one at a time in queue order', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-queue-scheduler-'));
  const repo = new MemoryQueueRepository();
  const service = new QueueService(repo);
  const orchestrator = new FakeOrchestrator();
  const scheduler = new Scheduler(service, orchestrator, { owner: 'test-scheduler', leaseMs: 1000, idlePollMs: 1000 });
  try {
    await service.enqueue({ prompt: 'First autonomous prompt', provider: 'codex', workspacePath: path.join(temp, 'first') });
    await service.enqueue({ prompt: 'Second autonomous prompt', provider: 'codex', workspacePath: path.join(temp, 'second') });
    await scheduler.start();
    await waitFor(async () => (await service.getState()).jobs.every((job) => job.status === 'completed'), 'queue completion');

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
