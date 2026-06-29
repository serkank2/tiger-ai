import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { TerminalManager } from '../terminal/TerminalManager.js';
import { Orchestrator } from './Orchestrator.js';
import { TigerPaths } from './paths.js';
import { claimNextFinding, splitFindingsToFiles } from './findings.js';
import { claimNextTaskFile, finishTaskFile, splitTasksToFiles } from './tasks.js';
import type { StageId, StageRunConfig, TigerConfig } from './types.js';
import { MemoryExecutionPersistence, type TaskPersistenceInput } from './persistence.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

const TASKS_MD = `# Final Tasks

## TASK-001: Recover stale task

### Description
Verify stale task claims can be reclaimed.

### Acceptance Criteria
- The task returns to not_started

### Dependencies
- None

### Execution Status
not_started

### Assigned Agent
-

### Started At
-

### Completed At
-

### Review Status
pending

### Review Notes
-
`;

const TWO_TASKS_MD = `# Final Tasks

## TASK-001: First task

### Description
Complete the first task.

### Acceptance Criteria
- The task completes

### Dependencies
- None

### Execution Status
not_started

### Assigned Agent
-

### Started At
-

### Completed At
-

### Review Status
pending

### Review Notes
-

## TASK-002: Second task

### Description
Complete the second task.

### Acceptance Criteria
- The task completes

### Dependencies
- TASK-001

### Execution Status
not_started

### Assigned Agent
-

### Started At
-

### Completed At
-

### Review Status
pending

### Review Notes
-
`;

const REVIEW_LOG = `# Review Summary

## FINDING: Recover stale finding
### Related Task
TASK-001
### Severity
high
### Problem
The finding is stuck in fixing.
### Recommended Fix
Return it to open.
`;

function zeroAgentConfig(orch: Orchestrator): StageRunConfig {
  const d = orch.getConfig().defaults;
  return {
    claudeAgents: 0,
    codexAgents: 0,
    antigravityAgents: 0,
    claudeModel: d.claudeModel,
    codexModel: d.codexModel,
    antigravityModel: d.antigravityModel,
    claudeEffort: d.claudeEffort,
    codexEffort: d.codexEffort,
    antigravityEffort: d.antigravityEffort,
    claudePermission: d.claudePermission,
    codexPermission: d.codexPermission,
    antigravityPermission: d.antigravityPermission,
    parallel: d.parallel,
    mergeAgent: 'codex',
  };
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

async function waitForIdle(orch: Orchestrator, stageId: StageId): Promise<void> {
  const deadline = Date.now() + 12000;
  while (orch.getState().busy) {
    if (Date.now() > deadline) assert.fail(`${stageId} did not finish`);
    await delay(10);
  }
  const stage = orch.getState().stages[stageId];
  assert.notEqual(stage.status, 'failed', stage.message ?? `${stageId} failed`);
}

class LeaseTrackingPersistence extends MemoryExecutionPersistence {
  refreshCount = 0;
  refreshCountAtTaskClaim: number | null = null;
  taskClaimLeaseExpiresAt: string | null = null;
  runLeaseExpiresAtAtTaskClaim: string | null = null;

  override async refreshRunLease(
    ...args: Parameters<MemoryExecutionPersistence['refreshRunLease']>
  ): Promise<void> {
    this.refreshCount += 1;
    await super.refreshRunLease(...args);
  }

  override async recordTaskClaim(input: TaskPersistenceInput): Promise<void> {
    this.refreshCountAtTaskClaim = this.refreshCount;
    this.taskClaimLeaseExpiresAt = input.leaseExpiresAt ?? null;
    this.runLeaseExpiresAtAtTaskClaim = [...this.runs.values()][0]?.leaseExpiresAt ?? null;
    await super.recordTaskClaim(input);
  }
}

test('stage entry reclaims stale task and finding claims when locking is disabled', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-orchestrator-reclaim-'));
  try {
    const manager = new TerminalManager();
    const orch = new Orchestrator(manager);
    await orch.initialize(workspace, 'Project prompt');
    await orch.updateConfig({ execution: { locking: false, lockTtlMs: 1000 } });
    const paths = new TigerPaths(workspace);
    const cfg = zeroAgentConfig(orch);
    const oldDate = new Date('2020-01-01T00:00:00.000Z');

    await splitTasksToFiles(TASKS_MD, paths.tasksDir);
    const taskClaim = await claimNextTaskFile(paths.tasksDir, 'codex-ghost', oldDate.toISOString());
    assert.equal(taskClaim?.record.id, 'TASK-001');
    const inProgressTask = path.join(paths.tasksDir, 'TASK-001__in_progress.md');
    await fs.utimes(inProgressTask, oldDate, oldDate);

    await orch.startStage('executing-plan', cfg);
    await waitForIdle(orch, 'executing-plan');

    const notStartedTask = path.join(paths.tasksDir, 'TASK-001__not_started.md');
    assert.equal(await exists(notStartedTask), true);
    assert.equal(await exists(inProgressTask), false);
    const taskText = await fs.readFile(notStartedTask, 'utf8');
    assert.match(taskText, /### Execution Status\nnot_started/);
    assert.match(taskText, /### Assigned Agent\n-/);

    await splitFindingsToFiles([{ label: 'reviewer', content: REVIEW_LOG }], paths.findingsDir);
    const findingClaim = await claimNextFinding(paths.findingsDir);
    assert.equal(findingClaim?.id, 'FINDING-001');
    const fixingFinding = path.join(paths.findingsDir, 'FINDING-001__fixing.md');
    await fs.utimes(fixingFinding, oldDate, oldDate);

    await orch.startStage('task-review', cfg);
    await waitForIdle(orch, 'task-review');

    assert.equal(await exists(path.join(paths.findingsDir, 'FINDING-001__open.md')), true);
    assert.equal(await exists(fixingFinding), false);

    const terminalId = 'ephemeral-agent-terminal';
    const internals = orch as unknown as {
      stages: Record<string, { runs: Array<{ terminalId: string; label: string }> }>;
    };
    internals.stages.brainstorming!.runs = [{ terminalId, label: 'codex-99' }];
    manager.upsertDefinition({
      id: terminalId,
      name: 'codex-99',
      groupId: null,
      cwd: paths.root,
      initialCommand: 'codex',
      shell: { kind: 'system-default' },
      protected: true,
      createdAt: oldDate.toISOString(),
      updatedAt: oldDate.toISOString(),
    });

    await orch.closeProject();
    assert.equal(manager.getDefinition(terminalId), undefined);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('running a stage persists execution run, stage, agent and artifact checkpoints', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-orchestrator-persist-'));
  try {
    const persistence = new MemoryExecutionPersistence();
    const manager = new TerminalManager();
    const orch = new Orchestrator(manager, { persistence, owner: { type: 'manual', id: `${process.pid}:persist` } });
    await orch.initialize(workspace, 'Project prompt');
    const cfg = fakeAgentConfig(orch);
    installFakeCliConfig(orch);

    await orch.startStage('brainstorming', cfg);
    await waitForIdle(orch, 'brainstorming');

    const run = [...persistence.runs.values()][0];
    assert.ok(run, 'execution run should be written');
    assert.equal(run.status, 'completed');
    const stage = [...persistence.stages.values()].find((s) => s.stageId === 'brainstorming');
    assert.ok(stage, 'stage row should be written');
    assert.equal(stage.status, 'completed');
    const agent = [...persistence.agents.values()].find((a) => a.stage === 'brainstorming');
    assert.ok(agent, 'agent run row should be written');
    assert.equal(agent.state, 'completed');
    assert.ok([...persistence.artifacts.values()].some((a) => a.kind === 'output' && a.sizeBytes && a.sizeBytes > 0));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('boot reconciliation marks interrupted work stale and resumes only unfinished tasks', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-orchestrator-resume-'));
  try {
    const persistence = new MemoryExecutionPersistence();
    const orch1 = new Orchestrator(new TerminalManager(), {
      persistence,
      owner: { type: 'manual', id: `${process.pid}:resume-1` },
    });
    await orch1.initialize(workspace, 'Project prompt');
    const paths = new TigerPaths(workspace);
    await splitTasksToFiles(TWO_TASKS_MD, paths.tasksDir);
    await finishTaskFile(paths.tasksDir, 'TASK-001', 'done', new Date().toISOString());
    await orch1.closeProject();

    const task1 = await fs.readFile(path.join(paths.tasksDir, 'TASK-001__done.md'), 'utf8');
    assert.match(task1, /### Execution Status\ndone/);
    const stale = await claimNextTaskFile(paths.tasksDir, 'codex-dead', '2020-01-01T00:00:00.000Z', {
      locksDir: paths.locksDir,
      agentType: 'codex',
      ttlMs: 1,
      nowMs: Date.now(),
    });
    assert.equal(stale?.record.id, 'TASK-002');
    const oldDate = new Date('2020-01-01T00:00:00.000Z');
    await fs.rm(paths.lockFile('TASK-002'), { force: true });
    await fs.utimes(path.join(paths.tasksDir, 'TASK-002__in_progress.md'), oldDate, oldDate);

    const staleRun = await persistence.acquireRunLease({
      workspace,
      tigerRoot: paths.root,
      owner: { type: 'manual', id: '999999:dead' },
      ttlMs: 60_000,
    });
    assert.equal(staleRun.ok, true);
    if (!staleRun.ok) assert.fail('unreachable');
    const run = {
      id: 'interrupted-agent',
      terminalId: 'interrupted-agent',
      stage: 'executing-plan' as const,
      type: 'codex' as const,
      index: 2,
      label: 'codex-02',
      outputPath: paths.outputFile('executing-plan', 'codex', 2),
      outputRel: paths.rel(paths.outputFile('executing-plan', 'codex', 2)),
      markerPath: paths.markerFile('executing-plan', 'interrupted-agent'),
      promptPath: paths.promptFileFor('executing-plan', 'interrupted-agent'),
      command: 'node fake-cli.mjs',
      state: 'running' as const,
      attempts: 1,
      taskId: 'TASK-002',
    };
    await persistence.startStage({
      workspace,
      runId: staleRun.runId,
      stageId: 'executing-plan',
      status: 'running',
      owner: { type: 'manual', id: '999999:dead' },
      ttlMs: 60_000,
    });
    await persistence.recordAgentRun({
      workspace,
      runId: staleRun.runId,
      run,
      owner: { type: 'manual', id: '999999:dead' },
      ttlMs: 60_000,
    });
    await fs.writeFile(run.outputPath, '# Partial\n\nunfinished\n', 'utf8');

    const manager2 = new TerminalManager();
    const orch2 = new Orchestrator(manager2, { persistence, owner: { type: 'manual', id: `${process.pid}:resume-2` } });
    await orch2.attachWorkspace(workspace);
    const cfg = fakeAgentConfig(orch2);
    const restored = orch2.getState().stages['executing-plan'];
    assert.equal(restored.status, 'interrupted');
    assert.equal(restored.runs.some((r) => r.state === 'interrupted'), true);
    assert.equal(await exists(path.join(paths.tasksDir, 'TASK-001__done.md')), true);
    assert.equal(await exists(path.join(paths.tasksDir, 'TASK-002__not_started.md')), true);

    installFakeCliConfig(orch2);
    await orch2.startStage('executing-plan', cfg);
    await waitForIdle(orch2, 'executing-plan');

    assert.equal(await exists(path.join(paths.tasksDir, 'TASK-001__done.md')), true);
    assert.equal(await exists(path.join(paths.tasksDir, 'TASK-002__done.md')), true);
    const outputs = await fs.readdir(paths.stageDir('executing-plan'));
    assert.equal(outputs.filter((name) => name.endsWith('execution-log.md')).length, 1);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('manual stage start is blocked by another active owner lease', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-orchestrator-lease-'));
  try {
    const persistence = new MemoryExecutionPersistence();
    const paths = new TigerPaths(workspace);
    const queueLease = await persistence.acquireRunLease({
      workspace,
      tigerRoot: paths.root,
      owner: { type: 'queue', id: 'queue-owner' },
      ttlMs: 60_000,
    });
    assert.equal(queueLease.ok, true);

    const orch = new Orchestrator(new TerminalManager(), {
      persistence,
      owner: { type: 'manual', id: `${process.pid}:manual` },
    });
    await orch.initialize(workspace, 'Project prompt');
    const err = await orch.startStage('brainstorming', fakeAgentConfig(orch)).then(
      () => null,
      (e: unknown) => e as { status?: number; message?: string },
    );
    assert.equal(err?.status, 409);
    assert.match(err?.message ?? '', /leased by queue:queue-owner/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('active execution lease is refreshed while a stage is busy and before task claims are persisted', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-orchestrator-heartbeat-'));
  try {
    const persistence = new LeaseTrackingPersistence();
    const manager = new TerminalManager();
    const orch = new Orchestrator(manager, { persistence, owner: { type: 'manual', id: `${process.pid}:heartbeat` } });
    await orch.initialize(workspace, 'Project prompt');
    installFakeCliConfig(orch, 'growing-idle');
    const paths = new TigerPaths(workspace);
    await splitTasksToFiles(TASKS_MD, paths.tasksDir);
    const cfg = fakeAgentConfig(orch);

    await orch.startStage('executing-plan', cfg);
    while (persistence.runs.size === 0) await delay(10);
    const run = [...persistence.runs.values()][0];
    assert.ok(run, 'execution run should be acquired');
    const initialLeaseExpiresAt = run.leaseExpiresAt;

    await delay(1300);
    assert.equal(orch.getState().busy, true, 'stage should still be running after the original TTL');
    assert.ok(persistence.refreshCount > 0, 'heartbeat should refresh the active run lease');
    assert.notEqual(run.leaseExpiresAt, initialLeaseExpiresAt);

    const competitor = await persistence.acquireRunLease({
      workspace,
      tigerRoot: paths.root,
      owner: { type: 'manual', id: `${process.pid}:competitor` },
      ttlMs: 1000,
    });
    assert.equal(competitor.ok, false, 'a refreshed busy-stage lease should block another owner');

    assert.ok(
      (persistence.refreshCountAtTaskClaim ?? 0) > 0,
      'task claim persistence should refresh the run lease before recording the claim',
    );
    assert.equal(persistence.taskClaimLeaseExpiresAt, persistence.runLeaseExpiresAtAtTaskClaim);

    await waitForIdle(orch, 'executing-plan');
    assert.equal(run.status, 'completed');
    assert.equal(run.leaseExpiresAt, null);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

function installFakeCliConfig(orch: Orchestrator, mode = 'marker'): void {
  const internals = orch as unknown as { config: TigerConfig };
  internals.config = {
    ...internals.config,
    cli: {
      ...internals.config.cli,
      codex: {
        ...internals.config.cli.codex,
        executable: 'node',
        models: ['fake'],
        modelFlag: '',
        effortConfigKey: '',
        extraArgs: [FAKE, '--mode', mode],
        permissionModes: { test: [] },
      },
    },
    timing: {
      ...internals.config.timing,
      readyIdleMs: 100,
      readyMaxWaitMs: 3000,
      doneIdleMs: 1000,
      markerPollMs: 100,
      agentTimeoutMs: 10000,
      settleMaxWaitMs: 1000,
      submitDelayMs: 10,
    },
    execution: {
      ...internals.config.execution,
      locking: true,
      lockTtlMs: 1000,
      deleteTigerOnComplete: false,
    },
  };
}

function fakeAgentConfig(orch: Orchestrator): StageRunConfig {
  const d = orch.getConfig().defaults;
  return {
    claudeAgents: 0,
    codexAgents: 1,
    antigravityAgents: 0,
    claudeModel: d.claudeModel,
    codexModel: 'fake',
    antigravityModel: d.antigravityModel,
    claudeEffort: d.claudeEffort,
    codexEffort: '',
    antigravityEffort: '',
    claudePermission: d.claudePermission,
    codexPermission: 'test',
    antigravityPermission: d.antigravityPermission,
    parallel: false,
    mergeAgent: 'codex',
  };
}

test('an all-blocked execute stage is reported failed (not completed), so auto-advance cannot proceed (#2)', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-allblocked-'));
  try {
    const manager = new TerminalManager();
    const orch = new Orchestrator(manager);
    await orch.initialize(workspace, 'Project prompt');
    // `idle` mode writes an output file WITHOUT an EXECUTION_RESULT self-report and then stays alive,
    // so the agent idle-completes but the semantic gate downgrades its task to `blocked`.
    installFakeCliConfig(orch, 'idle');
    const paths = new TigerPaths(workspace);
    await splitTasksToFiles(TASKS_MD, paths.tasksDir);

    await orch.startStage('executing-plan', fakeAgentConfig(orch));
    const deadline = Date.now() + 15000;
    while (orch.getState().busy) {
      if (Date.now() > deadline) assert.fail('execute stage did not finish');
      await delay(10);
    }

    const state = orch.getState();
    const stage = state.stages['executing-plan']!;
    // The CLI run itself "completed" (idle), but the task ended blocked — so the stage must NOT be
    // completed. Before the fix it would have reported completed and satisfied auto-advance/cleanup.
    assert.notEqual(stage.status, 'completed', 'an all-blocked stage must not finalize as completed');
    assert.equal(stage.status, 'failed');
    assert.equal(state.tasks?.byExecution.blocked, 1);
    assert.equal(state.tasks?.byExecution.done, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('a failed agent run is retried once (maxAttempts=2) before the stage is left failed (#3)', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-retry-'));
  try {
    const manager = new TerminalManager();
    const orch = new Orchestrator(manager);
    await orch.initialize(workspace, 'Project prompt');
    // 'missing' mode produces no marker and no output. Under the orchestrator's shell-hosted PTY the
    // CLI exit does not end the terminal, so each attempt fails via the agent timeout — shortened here
    // to keep the (two-attempt) test fast. The default execution.maxAttempts is 2 → exactly one retry.
    installFakeCliConfig(orch, 'missing');
    const internals = orch as unknown as { config: TigerConfig };
    internals.config = { ...internals.config, timing: { ...internals.config.timing, agentTimeoutMs: 1500 } };

    await orch.startStage('brainstorming', fakeAgentConfig(orch));
    // Two attempts, each ending on the (shortened) agent timeout after a fresh shell+PTY spawn, so
    // allow generous headroom for slow CI shell startup.
    const deadline = Date.now() + 30000;
    while (orch.getState().busy) {
      if (Date.now() > deadline) assert.fail('brainstorming stage did not finish');
      await delay(10);
    }

    const stage = orch.getState().stages['brainstorming']!;
    assert.equal(stage.status, 'failed');
    assert.equal(stage.runs.length, 1);
    // The single run was attempted exactly twice: the original plus one automatic retry.
    assert.equal(stage.runs[0]!.attempts, 2);
    assert.equal(stage.runs[0]!.state, 'failed');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
