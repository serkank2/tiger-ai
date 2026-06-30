import test from 'node:test';
import assert from 'node:assert/strict';
import type { TeamRunState as EngineTeamRunState, TeamRoleInstance as EngineRole } from './TeamOrchestrator.js';
import { toRoleSnapshot, computeDoneGate, toTeamRunStateDto } from './snapshot.js';

function role(over: Partial<EngineRole> = {}): EngineRole {
  return {
    id: 'r1',
    name: 'Developer',
    tool: 'claude',
    responsibilities: ['Ship code'],
    canWriteCode: true,
    requiredForSignoff: true,
    status: 'idle',
    ...over,
  };
}

function state(over: Partial<EngineTeamRunState> = {}): EngineTeamRunState {
  const now = '2026-06-19T10:00:00.000Z';
  return {
    runId: 'run-1',
    workspace: '/ws',
    tigerRoot: '/ws/.tiger',
    status: 'running',
    goal: 'Make the app faster\nand more reliable',
    roles: [role()],
    round: 2,
    turnCount: 3,
    currentTurn: null,
    turns: [],
    directives: [],
    signoffs: [],
    verifications: [],
    tasks: null,
    findings: null,
    messageCount: 7,
    pendingSteeringCount: 0,
    materialChangeAt: now,
    createdAt: now,
    ...over,
  };
}

// --- toRoleSnapshot status mapping & signoff freshness ---

test('toRoleSnapshot maps engine role statuses onto the UI vocabulary', () => {
  const pairs: Array<[EngineRole['status'], string]> = [
    ['running', 'working'],
    ['paused', 'waiting'],
    ['interrupted', 'idle'],
    ['idle', 'idle'],
    ['blocked', 'blocked'],
    ['done', 'done'],
  ];
  for (const [engine, ui] of pairs) {
    const s = state({ roles: [role({ status: engine })] });
    assert.equal(toRoleSnapshot(s, s.roles[0]!).status, ui, `${engine} -> ${ui}`);
  }
});

test('toRoleSnapshot marks signedOff only for a fresh (non-stale) sign-off of that role', () => {
  const fresh = state({
    signoffs: [{ id: 's1', roleId: 'r1', roleName: 'Developer', createdAt: 'x', stale: false }],
  });
  assert.equal(toRoleSnapshot(fresh, fresh.roles[0]!).signedOff, true);

  const stale = state({
    signoffs: [{ id: 's1', roleId: 'r1', roleName: 'Developer', createdAt: 'x', stale: true }],
  });
  assert.equal(toRoleSnapshot(stale, stale.roles[0]!).signedOff, false);

  const other = state({
    signoffs: [{ id: 's1', roleId: 'other', roleName: 'Other', createdAt: 'x', stale: false }],
  });
  assert.equal(toRoleSnapshot(other, other.roles[0]!).signedOff, false);
});

test('toRoleSnapshot defaults a blocked role status note to the role name and counts only its own turns', () => {
  const s = state({
    roles: [role({ status: 'blocked' })],
    turns: [
      {
        id: 't1',
        runId: 'run-1',
        roleId: 'r1',
        roleName: 'Developer',
        status: 'completed',
        round: 1,
        startedAt: 'x',
        messageSeqs: [],
        appliedDirectiveIds: [],
      },
      {
        id: 't2',
        runId: 'run-1',
        roleId: 'other',
        roleName: 'Other',
        status: 'completed',
        round: 1,
        startedAt: 'x',
        messageSeqs: [],
        appliedDirectiveIds: [],
      },
    ],
  });
  const snap = toRoleSnapshot(s, s.roles[0]!);
  assert.equal(snap.statusNote, 'Developer');
  assert.equal(snap.turnCount, 1);
});

test('toRoleSnapshot includes live role CLI configuration', () => {
  const s = state({
    roles: [role({ tool: 'codex', model: 'gpt-5', effort: 'high', permission: 'workspace-write' })],
  });
  const snap = toRoleSnapshot(s, s.roles[0]!);
  assert.equal(snap.tool, 'codex');
  assert.equal(snap.model, 'gpt-5');
  assert.equal(snap.effort, 'high');
  assert.equal(snap.permission, 'workspace-write');
});

// --- computeDoneGate ---

test('computeDoneGate returns the authoritative gate shape and surfaces a board-pending blocker', () => {
  const s = state({ roles: [role({ taskCounts: { todo: 1, inProgress: 1, done: 0 } })] });
  const gate = computeDoneGate(s);
  assert.equal(typeof gate.satisfied, 'boolean');
  assert.ok(Array.isArray(gate.openBlockers));
  assert.equal(gate.satisfied, false, 'pending board work must block completion');
  const board = gate.openBlockers.find((b) => b.code === 'board_pending');
  assert.ok(board, 'expected a board_pending blocker');
  assert.match(board!.message, /2 Lead-assigned task/);
});

// --- toTeamRunStateDto projection ---

test('toTeamRunStateDto derives a one-line run name from the goal and passes recentMessages through', () => {
  const dto = toTeamRunStateDto(state(), [
    { runId: 'run-1', seq: 1, from: 'r1', to: 'all', kind: 'chat', body: 'hi', createdAt: 'x' } as never,
  ]);
  assert.equal(dto.name, 'Make the app faster', 'name is the first non-empty trimmed line of the goal');
  assert.equal(dto.recentMessages.length, 1);
  assert.equal(dto.id, 'run-1');
  assert.equal(dto.messageCount, 7);
  assert.equal(dto.round, 2);
  assert.equal(dto.turnCount, 3);
  assert.equal(dto.updatedAt, '2026-06-19T10:00:00.000Z');
});

test('toTeamRunStateDto defaults recentMessages to empty and only includes pending steering', () => {
  const s = state({
    directives: [
      { id: 'd1', messageId: 'm1', body: 'do this', createdAt: 'x', status: 'pending' },
      { id: 'd2', messageId: 'm2', body: 'already applied', createdAt: 'x', status: 'applied' },
    ],
  });
  const dto = toTeamRunStateDto(s);
  assert.deepEqual(dto.recentMessages, []);
  assert.equal(dto.pendingSteering.length, 1);
  assert.equal(dto.pendingSteering[0]!.body, 'do this');
  assert.equal(dto.pendingSteering[0]!.acknowledged, false);
});

test('toTeamRunStateDto computes per-turn duration from start/end timestamps', () => {
  const s = state({
    turns: [
      {
        id: 't1',
        runId: 'run-1',
        roleId: 'r1',
        roleName: 'Developer',
        status: 'completed',
        round: 1,
        startedAt: '2026-06-19T10:00:00.000Z',
        endedAt: '2026-06-19T10:00:05.000Z',
        messageSeqs: [],
        appliedDirectiveIds: [],
      },
    ],
  });
  const dto = toTeamRunStateDto(s);
  assert.ok(dto.turns && dto.turns.length === 1);
  assert.equal(dto.turns[0]!.durationMs, 5000);
  assert.equal(dto.turns[0]!.provider, 'claude', 'turn provider is resolved from the role');
});

test('toTeamRunStateDto falls back to "Team Run" for an empty goal', () => {
  assert.equal(toTeamRunStateDto(state({ goal: '   \n  ' })).name, 'Team Run');
});
