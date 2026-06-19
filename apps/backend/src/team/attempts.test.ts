import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryExecutionPersistence } from '../orchestrator/persistence.js';
import { MemoryTeamPersistence } from './persistence.js';
import {
  TeamOrchestrator,
  nextAttemptNumber,
  currentAttempt,
  promoteGuard,
  attemptOutcomeFromRunStatus,
  type TeamAttemptRecord,
  type TeamRunState,
  type TeamScheduler,
  type TeamTurnRunner,
} from './TeamOrchestrator.js';

// ---------------------------------------------------------------------------
// Pure attempt logic — numbering, current-attempt resolution, status mapping,
// and the promote guard. No engine / git / fs needed.
// ---------------------------------------------------------------------------

function attempt(overrides: Partial<TeamAttemptRecord>): TeamAttemptRecord {
  return {
    id: overrides.id ?? 'a',
    runId: 'run-1',
    attemptNumber: overrides.attemptNumber ?? 1,
    status: overrides.status ?? 'running',
    branch: overrides.branch ?? null,
    baseRef: overrides.baseRef ?? null,
    workspacePath: overrides.workspacePath ?? null,
    summary: overrides.summary ?? null,
    startedAt: '2026-06-19T00:00:00.000Z',
    createdAt: '2026-06-19T00:00:00.000Z',
    ...overrides,
  };
}

test('nextAttemptNumber is one past the current max (1-based)', () => {
  assert.equal(nextAttemptNumber([]), 1);
  assert.equal(nextAttemptNumber([{ attemptNumber: 1 }]), 2);
  assert.equal(nextAttemptNumber([{ attemptNumber: 1 }, { attemptNumber: 3 }]), 4);
});

test('currentAttempt is the latest non-terminal attempt', () => {
  assert.equal(currentAttempt([]), null);
  const running = attempt({ id: 'a2', attemptNumber: 2, status: 'running' });
  assert.equal(
    currentAttempt([attempt({ id: 'a1', status: 'superseded' }), running])?.id,
    'a2',
  );
  // All terminal → no current attempt.
  assert.equal(
    currentAttempt([attempt({ id: 'a1', status: 'completed' }), attempt({ id: 'a2', status: 'failed' })]),
    null,
  );
});

test('attemptOutcomeFromRunStatus maps run-terminal status onto attempt status', () => {
  assert.equal(attemptOutcomeFromRunStatus('completed'), 'completed');
  assert.equal(attemptOutcomeFromRunStatus('failed'), 'failed');
  assert.equal(attemptOutcomeFromRunStatus('stopped'), 'completed');
});

test('promoteGuard enforces existence, single-promotion, and branch presence', () => {
  const a = attempt({ id: 'a1', attemptNumber: 1, status: 'completed', branch: 'kaplan/x' });
  const b = attempt({ id: 'a2', attemptNumber: 2, status: 'completed', branch: 'kaplan/y' });

  // Unknown attempt.
  assert.match(promoteGuard([a], 'nope') ?? '', /not part of this run/);
  // No branch to promote.
  assert.match(
    promoteGuard([attempt({ id: 'a1', status: 'completed', branch: null })], 'a1') ?? '',
    /no isolated branch/,
  );
  // Happy path.
  assert.equal(promoteGuard([a, b], 'a1'), null);
  // Already promoted (this one).
  assert.match(promoteGuard([attempt({ id: 'a1', status: 'promoted', branch: 'b' })], 'a1') ?? '', /already promoted/);
  // Another attempt already promoted → only one per run.
  assert.match(
    promoteGuard([attempt({ id: 'a1', status: 'promoted', branch: 'b' }), b], 'a2') ?? '',
    /only one attempt can be promoted/,
  );
});

// ---------------------------------------------------------------------------
// Persistence round-trip (in-memory double).
// ---------------------------------------------------------------------------

test('MemoryTeamPersistence attempt round-trip: create -> update -> list -> promote', async () => {
  const p = new MemoryTeamPersistence();
  const run = await p.createRun({
    workspace: '/tmp/ws',
    tigerRoot: '/tmp/ws/.tiger',
    owner: { type: 'manual', id: 'pid-1' },
    ttlMs: 60_000,
    goal: 'Sample solutions',
  });

  const a1 = await p.createAttempt({ runId: run.id, attemptNumber: 1, branch: 'kaplan/a1', baseRef: 'deadbeef' });
  assert.equal(a1.attemptNumber, 1);
  assert.equal(a1.status, 'running');
  assert.equal(a1.branch, 'kaplan/a1');

  const updated = await p.updateAttempt(a1.id, {
    status: 'completed',
    summary: { files: 3, insertions: 40, deletions: 5 },
    completedAt: new Date().toISOString(),
  });
  assert.equal(updated?.status, 'completed');
  assert.deepEqual(updated?.summary, { files: 3, insertions: 40, deletions: 5 });

  await p.createAttempt({ runId: run.id, attemptNumber: 2, branch: 'kaplan/a2' });
  const list = await p.listAttempts(run.id);
  assert.deepEqual(list.map((a) => a.attemptNumber), [1, 2]);

  const promoted = await p.markAttemptPromoted(a1.id);
  assert.equal(promoted?.status, 'promoted');
  assert.ok(promoted?.promotedAt);
});

// ---------------------------------------------------------------------------
// Orchestrator integration: new attempt isolates on its own branch; promote
// merges it; backward-compatible (a plain run records no attempts).
// ---------------------------------------------------------------------------

const roles = [
  { id: 'lead', name: 'Lead', tool: 'codex' as const, responsibilities: [], canWriteCode: true, requiredForSignoff: true },
];

function singleTurnScheduler(): TeamScheduler {
  return {
    selectNextTurns(state) {
      if (state.status !== 'running') return { turns: [] };
      if (state.turnCount >= 1) return { turns: [], terminal: { status: 'completed', reason: 'done' } };
      return { turns: [{ roleId: 'lead', reason: 'work' }] };
    },
  };
}

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false, windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} exited ${code}`))));
  });
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(dir, 'README.md'), '# base\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'base']);
}

async function waitForTerminal(orch: TeamOrchestrator, timeoutMs = 5000): Promise<TeamRunState> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = orch.getState().status;
    if (status === 'completed' || status === 'blocked' || status === 'failed' || status === 'stopped') return orch.getState();
    if (Date.now() > deadline) assert.fail(`timed out: ${JSON.stringify(orch.getState().status)}`);
    await delay(10);
  }
}

test('a plain run records no attempts (backward compatible)', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-attempt-bc-'));
  try {
    const runner: TeamTurnRunner = {
      async runRoleTurn(input) {
        return { status: 'completed', messages: [{ from: input.role.id, kind: 'chat', body: 'ok' }], signoffs: [{}] };
      },
    };
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      runner,
      scheduler: singleTurnScheduler(),
      completionGate: { evaluate: () => ({ complete: true, reasons: [] }) },
    });
    await orch.createTeamRun({ workspace, goal: 'Plain run.', roles });
    await orch.start();
    const final = await waitForTerminal(orch);
    assert.equal(final.status, 'completed');
    assert.deepEqual(final.attempts ?? [], []);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('createAttempt isolates work on its own branch and promoteAttempt merges it', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-attempt-git-'));
  try {
    await initRepo(workspace);
    // The runner writes a file each turn (the "attempt's work"), then signs off.
    const runner: TeamTurnRunner = {
      async runRoleTurn(input) {
        await fs.writeFile(path.join(input.workspace, `out-${Date.now()}.txt`, ), 'work\n', 'utf8').catch(() => {});
        return { status: 'completed', messages: [{ from: input.role.id, kind: 'chat', body: 'did work' }], signoffs: [{}] };
      },
    };
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      runner,
      scheduler: singleTurnScheduler(),
      completionGate: { evaluate: () => ({ complete: true, reasons: [] }) },
    });
    await orch.createTeamRun({ workspace, goal: 'Sample a solution.', roles });
    await orch.start();
    await waitForTerminal(orch);

    // Start a fresh attempt: it must be recorded, numbered #1, and isolated on a branch.
    await orch.createAttempt();
    await waitForTerminal(orch);
    // finishRun stamps the attempt's terminal status asynchronously after flipping the run
    // status; wait for that to settle before asserting on the attempt outcome.
    await (async () => {
      const deadline = Date.now() + 3000;
      while (orch.getState().attempts?.[0]?.status === 'running' && Date.now() < deadline) await delay(10);
    })();
    const afterAttempt = orch.getState();
    assert.equal((afterAttempt.attempts ?? []).length, 1);
    const a = afterAttempt.attempts![0]!;
    assert.equal(a.attemptNumber, 1);
    assert.ok(a.branch, 'attempt has an isolated branch');
    assert.ok(a.branch!.includes('attempt-1'));
    assert.equal(a.status, 'completed');

    // Promote it: the attempt's branch is merged into the workspace base; status flips.
    await orch.promoteAttempt(undefined, a.id);
    const promoted = orch.getState();
    assert.equal(promoted.promotedAttemptId, a.id);
    assert.equal(promoted.attempts![0]!.status, 'promoted');

    // Guard: a second promotion of any attempt is rejected (one per run).
    await assert.rejects(() => orch.promoteAttempt(undefined, a.id), /already promoted/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});
