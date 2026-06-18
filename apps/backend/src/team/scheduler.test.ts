import test from 'node:test';
import assert from 'node:assert/strict';
import { selectNextTurns, type TeamRole, type TeamSchedulerState } from './scheduler.js';

const roles: TeamRole[] = [
  { id: 'lead', kind: 'lead' },
  { id: 'analyst', kind: 'analyst' },
  { id: 'developer-a', kind: 'developer' },
  { id: 'developer-b', kind: 'developer' },
  { id: 'tester-a', kind: 'tester' },
  { id: 'tester-b', kind: 'tester' },
  { id: 'reviewer', kind: 'reviewer' },
  { id: 'signoff', kind: 'signoff' },
];

function state(input: Partial<TeamSchedulerState> = {}): TeamSchedulerState {
  return {
    roles,
    currentRound: 0,
    maxRounds: 5,
    ...input,
  };
}

test('selectNextTurns follows the deterministic team phase order and serializes developers', () => {
  assert.deepEqual(
    selectNextTurns(state({ phase: 'manager' })).turns.map((turn) => turn.roleId),
    ['lead'],
  );
  assert.deepEqual(
    selectNextTurns(state({ tasks: { needsAnalysis: 1 } })).turns.map((turn) => turn.roleId),
    ['analyst'],
  );

  const developerTurn = selectNextTurns(state({ tasks: { needsImplementation: 2 } }));
  assert.deepEqual(
    developerTurn.turns.map((turn) => turn.roleId),
    ['developer-a'],
  );
  assert.equal(developerTurn.turns[0]?.writeCapable, true);

  assert.deepEqual(
    selectNextTurns(state({ tasks: { needsTesting: 2 }, maxConcurrentReadOnly: 2 })).turns.map((turn) => turn.roleId),
    ['tester-a', 'tester-b'],
  );
  assert.deepEqual(
    selectNextTurns(state({ tasks: { needsReview: 1 } })).turns.map((turn) => turn.roleId),
    ['reviewer'],
  );

  const signoff = selectNextTurns(state({ tasks: { readyForSignoff: 1 } }));
  assert.deepEqual(
    signoff.turns.map((turn) => turn.roleId),
    ['signoff'],
  );
  assert.equal(signoff.boundary.checkDoneGate, true);
});

test('selectNextTurns honors coordinator decisions while preserving scheduler safety limits', () => {
  const decision = selectNextTurns(
    state({
      coordinatorDecision: {
        roleIds: ['developer-b', 'tester-a', 'developer-a'],
        reason: 'lead selected fix owner',
      },
      tasks: { needsTesting: 1 },
    }),
  );

  assert.deepEqual(
    decision.turns.map((turn) => turn.roleId),
    ['developer-a'],
  );
  assert.equal(decision.turns[0]?.reason, 'lead selected fix owner');
  assert.equal(decision.turns[0]?.writeCapable, true);
});

test('selectNextTurns terminates at the round cap and never schedules terminal states', () => {
  const capped = selectNextTurns(state({ currentRound: 3, maxRounds: 3, tasks: { needsAnalysis: 1 } }));
  assert.deepEqual(capped.turns, []);
  assert.equal(capped.terminal?.status, 'blocked');
  assert.match(capped.terminal?.reason ?? '', /round cap reached/);

  const blocked = selectNextTurns(state({ status: 'blocked', tasks: { needsImplementation: 1 } }));
  assert.deepEqual(blocked.turns, []);
  assert.equal(blocked.terminal?.status, 'blocked');

  const done = selectNextTurns(state({ status: 'done', tasks: { needsReview: 1 } }));
  assert.deepEqual(done.turns, []);
  assert.equal(done.terminal?.status, 'done');
});

test('selectNextTurns drains steering only at the next safe turn boundary', () => {
  const midTurn = selectNextTurns(
    state({
      activeTurns: [{ id: 'turn-1', roleId: 'developer-a', phase: 'implementation' }],
      pendingDirectives: [{ id: 'focus-tests' }],
      phase: 'implementation',
    }),
  );

  assert.deepEqual(midTurn.turns, []);
  assert.equal(midTurn.boundary.atBoundary, false);
  assert.equal(midTurn.boundary.drainSteeringBeforeNextTurn, false);

  const boundary = selectNextTurns(
    state({
      pendingDirectives: [{ id: 'focus-tests' }],
      tasks: { needsTesting: 1 },
    }),
  );

  assert.deepEqual(boundary.turns, []);
  assert.equal(boundary.boundary.atBoundary, true);
  assert.equal(boundary.boundary.drainSteeringBeforeNextTurn, true);
  assert.equal(boundary.reason, 'pending steering must drain before the next turn');
});
