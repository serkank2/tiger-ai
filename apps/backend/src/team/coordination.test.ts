import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TeamOrchestrator,
  classifyTeamMerge,
  decideTeamTurnCwd,
  openHandoffs,
  type TeamRunState,
} from './TeamOrchestrator.js';
import type { HandoffDependency } from './types.js';

// --- Pure handoff accounting -------------------------------------------------

test('openHandoffs returns only unresolved (still-blocking) dependencies', () => {
  const handoffs: HandoffDependency[] = [
    { id: 'h1', fromRoleId: 'lead', toRoleId: 'tester', taskId: 'TASK-0001', title: 'a', createdAt: 't0' },
    {
      id: 'h2',
      fromRoleId: 'lead',
      toRoleId: 'dev',
      taskId: 'TASK-0002',
      title: 'b',
      createdAt: 't0',
      resolvedAt: 't1',
    },
  ];
  assert.deepEqual(
    openHandoffs(handoffs).map((h) => h.id),
    ['h1'],
  );
  assert.deepEqual(openHandoffs(undefined), []);
});

// --- Done-gate accounting for open handoffs ----------------------------------

function baseState(overrides: Partial<TeamRunState>): TeamRunState {
  return {
    runId: 'run-1',
    workspace: '/ws',
    tigerRoot: '/ws/.tiger',
    status: 'running',
    goal: 'do it',
    roles: [
      {
        id: 'lead',
        name: 'Lead',
        tool: 'codex',
        responsibilities: [],
        canWriteCode: false,
        requiredForSignoff: false,
        status: 'idle',
      },
    ],
    round: 1,
    turnCount: 1,
    currentTurn: null,
    turns: [],
    directives: [],
    signoffs: [],
    verifications: [],
    tasks: null,
    findings: null,
    messageCount: 0,
    pendingSteeringCount: 0,
    materialChangeAt: 't0',
    createdAt: 't0',
    ...overrides,
  } as TeamRunState;
}

test('computeDoneGate surfaces an open handoff as a blocking dependency (handoff_pending)', () => {
  const state = baseState({
    handoffs: [
      { id: 'h1', fromRoleId: 'lead', toRoleId: 'tester', taskId: 'TASK-0001', title: 'Verify', createdAt: 't0' },
    ],
  });
  const gate = TeamOrchestrator.computeDoneGate(state);
  assert.equal(gate.satisfied, false);
  assert.ok(gate.openBlockers.some((b) => b.code === 'handoff_pending'));
});

test('computeDoneGate does NOT block on a resolved handoff', () => {
  const state = baseState({
    handoffs: [
      {
        id: 'h1',
        fromRoleId: 'lead',
        toRoleId: 'tester',
        taskId: 'TASK-0001',
        title: 'Verify',
        createdAt: 't0',
        resolvedAt: 't1',
      },
    ],
  });
  const gate = TeamOrchestrator.computeDoneGate(state);
  assert.equal(
    gate.openBlockers.some((b) => b.code === 'handoff_pending'),
    false,
  );
});

// --- Pure per-task worktree cwd / merge decision helpers ---------------------

test('decideTeamTurnCwd uses the worktree path only when enabled + git repo + worktree created', () => {
  assert.equal(
    decideTeamTurnCwd({ workspace: '/ws', enabled: true, isRepo: true, worktreePath: '/ws/.tiger/worktrees/x' }),
    '/ws/.tiger/worktrees/x',
  );
  // Feature off → shared workspace (byte-for-byte default behavior).
  assert.equal(decideTeamTurnCwd({ workspace: '/ws', enabled: false, isRepo: true, worktreePath: '/wt' }), '/ws');
  // Not a git repo → shared workspace.
  assert.equal(decideTeamTurnCwd({ workspace: '/ws', enabled: true, isRepo: false, worktreePath: '/wt' }), '/ws');
  // No worktree created → shared workspace.
  assert.equal(decideTeamTurnCwd({ workspace: '/ws', enabled: true, isRepo: true, worktreePath: null }), '/ws');
});

test('classifyTeamMerge distinguishes fast-forward, merged, conflict, and failed', () => {
  assert.equal(classifyTeamMerge({ ok: true, stdout: 'Fast-forward', stderr: '' }), 'fast-forward');
  assert.equal(classifyTeamMerge({ ok: true, stdout: 'Already up to date.', stderr: '' }), 'fast-forward');
  assert.equal(classifyTeamMerge({ ok: true, stdout: 'Merge made by the recursive strategy.', stderr: '' }), 'merged');
  assert.equal(
    classifyTeamMerge({
      ok: false,
      stdout: 'CONFLICT (content): Merge conflict in a.txt',
      stderr: 'Automatic merge failed',
    }),
    'conflict',
  );
  assert.equal(classifyTeamMerge({ ok: false, stdout: '', stderr: 'fatal: not something we can merge' }), 'failed');
});
