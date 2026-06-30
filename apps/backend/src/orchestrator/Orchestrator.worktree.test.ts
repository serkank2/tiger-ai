import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { TerminalManager } from '../terminal/TerminalManager.js';
import { Orchestrator, decideRunCwd, classifyMergeResult } from './Orchestrator.js';
import { TigerPaths } from './paths.js';
import { splitTasksToFiles } from './tasks.js';
import type { StageId, StageRunConfig, TigerConfig } from './types.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

// Skip git-dependent tests gracefully when git is unavailable (CI sandboxes, etc.).
const GIT_AVAILABLE = (() => {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Pure helpers (no git needed).
// ---------------------------------------------------------------------------

test('decideRunCwd returns the worktree path only when fully enabled, else the tiger root', () => {
  const root = '/repo/.tiger';
  const wt = '/repo/.tiger/worktrees/TASK-001';
  // Fully enabled + worktree present -> worktree.
  assert.equal(decideRunCwd({ tigerRoot: root, enabled: true, isRepo: true, worktreePath: wt }), wt);
  // Disabled -> shared root (byte-for-byte default behavior).
  assert.equal(decideRunCwd({ tigerRoot: root, enabled: false, isRepo: true, worktreePath: wt }), root);
  // Not a repo -> shared root.
  assert.equal(decideRunCwd({ tigerRoot: root, enabled: true, isRepo: false, worktreePath: wt }), root);
  // No worktree (creation failed) -> shared root.
  assert.equal(decideRunCwd({ tigerRoot: root, enabled: true, isRepo: true, worktreePath: null }), root);
});

test('classifyMergeResult distinguishes clean, fast-forward, conflict and failure', () => {
  assert.equal(classifyMergeResult({ ok: true, stdout: 'Fast-forward\n', stderr: '' }), 'fast-forward');
  assert.equal(classifyMergeResult({ ok: true, stdout: 'Already up to date.\n', stderr: '' }), 'fast-forward');
  assert.equal(classifyMergeResult({ ok: true, stdout: 'Merge made by the recursive strategy.\n', stderr: '' }), 'merged');
  assert.equal(
    classifyMergeResult({ ok: false, stdout: 'CONFLICT (content): Merge conflict in a.txt\n', stderr: 'Automatic merge failed' }),
    'conflict',
  );
  assert.equal(classifyMergeResult({ ok: false, stdout: '', stderr: 'fatal: not a git repository' }), 'failed');
});

// ---------------------------------------------------------------------------
// Integration: flag OFF leaves cwd unchanged; flag ON isolates + merges back.
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

/** Initialize `dir` as a git repo with one commit so it is a valid worktree source. */
function initRepo(dir: string): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@kaplan.local');
  git(dir, 'config', 'user.name', 'Kaplan Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

const ONE_TASK_MD = `# Final Tasks

## TASK-001: Do the thing

### Description
Implement the thing.

### Acceptance Criteria
- It works

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

async function waitForIdle(orch: Orchestrator, stageId: StageId): Promise<void> {
  const deadline = Date.now() + 12000;
  while (orch.getState().busy) {
    if (Date.now() > deadline) assert.fail(`${stageId} did not finish`);
    await delay(10);
  }
}

/** Capture the cwd the orchestrator registered for the (single) agent terminal of a stage. */
function capturedCwds(manager: TerminalManager): string[] {
  const cwds: string[] = [];
  const orig = manager.upsertDefinition.bind(manager);
  (manager as unknown as { upsertDefinition: typeof manager.upsertDefinition }).upsertDefinition = (def) => {
    if (def.protected) cwds.push(def.cwd);
    return orig(def);
  };
  return cwds;
}

test(
  'flag OFF: the execute-stage agent runs in the shared tiger root (cwd unchanged)',
  { skip: !GIT_AVAILABLE },
  async () => {
    const prev = config.tiger.worktreePerTask;
    config.tiger.worktreePerTask = false;
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-wt-off-'));
    try {
      initRepo(workspace);
      const manager = new TerminalManager();
      const orch = new Orchestrator(manager);
      await orch.initialize(workspace, 'Project prompt');
      const paths = new TigerPaths(workspace);
      // The .tiger dir must be committed-clean enough that git ignores it for the source repo; the
      // flag is OFF so no worktree is touched regardless.
      await splitTasksToFiles(ONE_TASK_MD, paths.tasksDir);
      installFakeCliConfig(orch);
      const cwds = capturedCwds(manager);

      await orch.startStage('executing-plan', fakeAgentConfig(orch));
      await waitForIdle(orch, 'executing-plan');

      assert.ok(cwds.length >= 1, 'an agent terminal should have been registered');
      for (const c of cwds) assert.equal(path.resolve(c), path.resolve(paths.root), 'cwd must be the shared tiger root');
      // No managed worktrees were ever created.
      assert.equal(
        await fs.stat(path.join(workspace, '.tiger', 'worktrees')).then(() => true, () => false),
        false,
        'no worktrees directory should exist when the flag is off',
      );
    } finally {
      config.tiger.worktreePerTask = prev;
      await fs.rm(workspace, { recursive: true, force: true });
    }
  },
);

test(
  'flag ON: the execute-stage agent runs in its own worktree, then it is merged back and pruned',
  { skip: !GIT_AVAILABLE },
  async () => {
    const prev = config.tiger.worktreePerTask;
    config.tiger.worktreePerTask = true;
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-wt-on-'));
    try {
      initRepo(workspace);
      // A committed baseline so HEAD resolves (createWorktree branches off HEAD).
      await fs.writeFile(path.join(workspace, 'README.md'), '# base\n', 'utf8');
      git(workspace, 'add', '.');
      git(workspace, 'commit', '-q', '-m', 'initial');

      const manager = new TerminalManager();
      const orch = new Orchestrator(manager);
      await orch.initialize(workspace, 'Project prompt');
      const paths = new TigerPaths(workspace);
      await splitTasksToFiles(ONE_TASK_MD, paths.tasksDir);
      installFakeCliConfig(orch);
      const cwds = capturedCwds(manager);

      await orch.startStage('executing-plan', fakeAgentConfig(orch));
      await waitForIdle(orch, 'executing-plan');

      // The agent's cwd was a per-task worktree under .tiger/worktrees/, not the tiger root.
      assert.ok(cwds.length >= 1, 'an agent terminal should have been registered');
      const agentCwd = path.resolve(cwds[0]!);
      assert.notEqual(agentCwd, path.resolve(paths.root), 'cwd must NOT be the shared tiger root when isolating');
      assert.ok(
        agentCwd.includes(path.join('.tiger', 'worktrees')),
        `cwd should be under .tiger/worktrees, got ${agentCwd}`,
      );

      // The task completed and was merged back: the task branch exists and the worktree was pruned.
      const branches = spawnSync('git', ['branch', '--list', 'kaplan/TASK-001'], {
        cwd: workspace,
        encoding: 'utf8',
      }).stdout;
      assert.match(branches, /kaplan\/TASK-001/, 'the per-task branch should exist (merge-back ran)');

      const wtList = spawnSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: workspace,
        encoding: 'utf8',
      }).stdout;
      assert.ok(
        !wtList.includes(path.join('.tiger', 'worktrees', 'TASK-001')),
        'a clean merge should prune the task worktree',
      );

      const state = orch.getState();
      assert.equal(state.stages['executing-plan']!.status, 'completed');
    } finally {
      config.tiger.worktreePerTask = prev;
      await fs.rm(workspace, { recursive: true, force: true });
    }
  },
);
