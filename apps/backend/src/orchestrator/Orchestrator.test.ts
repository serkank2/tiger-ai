import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TerminalManager } from '../terminal/TerminalManager.js';
import { Orchestrator } from './Orchestrator.js';
import { TigerPaths } from './paths.js';
import { claimNextFinding, splitFindingsToFiles } from './findings.js';
import { claimNextTaskFile, splitTasksToFiles } from './tasks.js';
import type { StageId, StageRunConfig } from './types.js';

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
    claudeModel: d.claudeModel,
    codexModel: d.codexModel,
    claudeEffort: d.claudeEffort,
    codexEffort: d.codexEffort,
    claudePermission: d.claudePermission,
    codexPermission: d.codexPermission,
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
  const deadline = Date.now() + 2000;
  while (orch.getState().busy) {
    if (Date.now() > deadline) assert.fail(`${stageId} did not finish`);
    await delay(10);
  }
  const stage = orch.getState().stages[stageId];
  assert.notEqual(stage.status, 'failed', stage.message ?? `${stageId} failed`);
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

    orch.startStage('executing-plan', cfg);
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

    orch.startStage('task-review', cfg);
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
