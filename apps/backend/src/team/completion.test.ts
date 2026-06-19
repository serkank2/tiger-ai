import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ExecutionStatus,
  FindingsSummary,
  ReviewStatus,
  TaskSummary,
} from '../orchestrator/types.js';
import type { RoleInstance, SignOff, SteeringDirective, VerificationRecord } from './types.js';
import {
  evaluateCompletion,
  evaluateGuards,
  evaluateRunGate,
  toDoneGateState,
  type CompletionInput,
  type GuardCounters,
  type GuardLimits,
} from './completion.js';

// Fixed timestamps in chronological order (T0 < T1 < T2 < T3).
const T0 = '2026-06-18T10:00:00.000Z';
const T1 = '2026-06-18T11:00:00.000Z';
const T2 = '2026-06-18T12:00:00.000Z';
const T3 = '2026-06-18T13:00:00.000Z';

// ---------------------------------------------------------------------------
// Fixture builders.
// ---------------------------------------------------------------------------

function taskSummary(items: Array<{ id: string; executionStatus: ExecutionStatus }>): TaskSummary {
  const byExecution: Record<ExecutionStatus, number> = {
    not_started: 0,
    in_progress: 0,
    done: 0,
    blocked: 0,
  };
  const byReview: Record<ReviewStatus, number> = {
    pending: 0,
    reviewing: 0,
    approved: 0,
    needs_fix: 0,
    fixed: 0,
  };
  for (const item of items) byExecution[item.executionStatus] += 1;
  return {
    total: items.length,
    byExecution,
    byReview,
    items: items.map((item) => ({
      id: item.id,
      title: item.id,
      executionStatus: item.executionStatus,
      reviewStatus: 'approved' as ReviewStatus,
      assignedAgent: 'claude-01',
    })),
  };
}

function findingsSummary(overrides: Partial<FindingsSummary> = {}): FindingsSummary {
  return { total: 1, open: 0, fixing: 0, fixed: 1, wontfix: 0, ...overrides };
}

function verification(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    id: 'VER-1',
    runId: 'run-1',
    roleId: 'tester',
    subject: 'typecheck + backend tests',
    outcome: 'passed',
    details: 'all objective checks passed',
    createdAt: T1,
    ...overrides,
  };
}

function directive(overrides: Partial<SteeringDirective> = {}): SteeringDirective {
  return {
    id: 'STEER-1',
    runId: 'run-1',
    body: 'Focus on the API surface.',
    acknowledged: true,
    createdAt: T0,
    ...overrides,
  };
}

function signoff(overrides: Partial<SignOff> = {}): SignOff {
  return {
    runId: 'run-1',
    roleId: 'lead',
    done: true,
    rationale: 'All assigned work is complete.',
    createdAt: T2,
    ...overrides,
  };
}

function roleInstance(overrides: Partial<RoleInstance> = {}): RoleInstance {
  return {
    id: 'lead',
    name: 'Lead',
    description: 'Coordinates the team.',
    persona: 'You are the lead.',
    agent: { tool: 'claude', model: 'opus', effort: 'high', permission: 'dangerous' },
    canWriteCode: false,
    requiredForSignoff: true,
    status: 'done',
    signedOff: true,
    createdAt: T0,
    ...overrides,
  };
}

/** A fully satisfied done-gate snapshot; individual tests perturb one field. */
function greenInput(): CompletionInput {
  return {
    tasks: taskSummary([{ id: 'TASK-001', executionStatus: 'done' }]),
    findings: findingsSummary(),
    verifications: [verification({ id: 'VER-1', outcome: 'passed', createdAt: T1 })],
    steering: [directive({ id: 'STEER-1', acknowledged: true, createdAt: T0 })],
    roles: [
      roleInstance({ id: 'lead', name: 'Lead', requiredForSignoff: true }),
      roleInstance({ id: 'dev', name: 'Developer', requiredForSignoff: false }),
    ],
    signoffs: [signoff({ roleId: 'lead', done: true, createdAt: T2 })],
    tasksUpdatedAt: T0,
    findingsUpdatedAt: T0,
  };
}

function codes(input: CompletionInput): string[] {
  return evaluateCompletion(input).blockers.map((b) => b.code);
}

// ---------------------------------------------------------------------------
// Done-gate: success.
// ---------------------------------------------------------------------------

test('evaluateCompletion: a fully satisfied state is complete with no blockers', () => {
  const result = evaluateCompletion(greenInput());
  assert.equal(result.complete, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.latestMaterialChangeAt, T1);
  assert.deepEqual(result.requiredRoleIds, ['lead']);
  assert.deepEqual(result.freshSignoffRoleIds, ['lead']);
  assert.deepEqual(result.pendingRoleIds, []);
});

// ---------------------------------------------------------------------------
// Done-gate: a new material change reopens the gate (stale sign-off).
// ---------------------------------------------------------------------------

test('evaluateCompletion: a material change after a sign-off reopens the gate (stale sign-off)', () => {
  const input = greenInput();
  // A fresh, still-passing verification at T3 is a material change later than the
  // lead sign-off (T2). No other gate trips, isolating staleness.
  input.verifications = [
    verification({ id: 'VER-1', outcome: 'passed', createdAt: T1 }),
    verification({ id: 'VER-2', outcome: 'passed', createdAt: T3 }),
  ];

  const result = evaluateCompletion(input);
  assert.equal(result.complete, false);
  assert.deepEqual(
    result.blockers.map((b) => b.code),
    ['signoff_stale'],
  );
  assert.equal(result.latestMaterialChangeAt, T3);
  assert.deepEqual(result.pendingRoleIds, ['lead']);
  assert.deepEqual(result.freshSignoffRoleIds, []);
  assert.match(result.blockers[0]!.message, /stale/i);
});

test('evaluateCompletion: a renewed sign-off after the change closes the gate again', () => {
  const input = greenInput();
  input.verifications = [
    verification({ id: 'VER-1', outcome: 'passed', createdAt: T1 }),
    verification({ id: 'VER-2', outcome: 'passed', createdAt: T2 }),
  ];
  // Renew the lead sign-off strictly after the latest change (T2).
  input.signoffs = [signoff({ roleId: 'lead', done: true, createdAt: T3 })];

  const result = evaluateCompletion(input);
  assert.equal(result.complete, true);
  assert.deepEqual(result.blockers, []);
});

// ---------------------------------------------------------------------------
// Done-gate: each individual blocking condition.
// ---------------------------------------------------------------------------

test('evaluateCompletion: pending/unacknowledged steering blocks completion', () => {
  const input = greenInput();
  input.steering = [
    directive({ id: 'STEER-1', acknowledged: true, createdAt: T0 }),
    directive({ id: 'STEER-2', acknowledged: false, createdAt: T0 }),
  ];

  const result = evaluateCompletion(input);
  assert.equal(result.complete, false);
  assert.deepEqual(
    result.blockers.map((b) => b.code),
    ['steering_pending'],
  );
  assert.match(result.blockers[0]!.message, /STEER-2/);
});

test('evaluateCompletion: open review findings block completion', () => {
  const input = greenInput();
  input.findings = findingsSummary({ total: 2, open: 1, fixing: 0, fixed: 1, wontfix: 0 });

  const result = evaluateCompletion(input);
  assert.equal(result.complete, false);
  assert.deepEqual(
    result.blockers.map((b) => b.code),
    ['findings_open'],
  );
});

test('evaluateCompletion: a blocked task blocks completion and is named', () => {
  const input = greenInput();
  input.tasks = taskSummary([
    { id: 'TASK-001', executionStatus: 'done' },
    { id: 'TASK-002', executionStatus: 'blocked' },
  ]);

  const result = evaluateCompletion(input);
  assert.equal(result.complete, false);
  assert.ok(result.blockers.some((b) => b.code === 'tasks_blocked'));
  const blocked = result.blockers.find((b) => b.code === 'tasks_blocked')!;
  assert.match(blocked.message, /TASK-002/);
});

test('evaluateCompletion: not-started / in-progress tasks block completion', () => {
  const input = greenInput();
  input.tasks = taskSummary([
    { id: 'TASK-001', executionStatus: 'done' },
    { id: 'TASK-002', executionStatus: 'in_progress' },
    { id: 'TASK-003', executionStatus: 'not_started' },
  ]);

  const result = evaluateCompletion(input);
  assert.equal(result.complete, false);
  const incomplete = result.blockers.find((b) => b.code === 'tasks_incomplete')!;
  assert.ok(incomplete);
  assert.match(incomplete.message, /TASK-002/);
  assert.match(incomplete.message, /TASK-003/);
});

test('evaluateCompletion: a failed latest verification blocks completion', () => {
  const input = greenInput();
  input.verifications = [verification({ id: 'VER-1', outcome: 'failed', createdAt: T1 })];

  const result = evaluateCompletion(input);
  assert.equal(result.complete, false);
  assert.deepEqual(
    result.blockers.map((b) => b.code),
    ['verification_failed'],
  );
  assert.match(result.blockers[0]!.message, /failed/i);
});

test('evaluateCompletion: an inconclusive latest verification blocks completion', () => {
  const input = greenInput();
  input.verifications = [
    verification({ id: 'VER-1', outcome: 'passed', createdAt: T0 }),
    verification({ id: 'VER-2', outcome: 'inconclusive', createdAt: T1 }),
  ];

  const result = evaluateCompletion(input);
  assert.equal(result.complete, false);
  assert.ok(result.blockers.some((b) => b.code === 'verification_failed'));
  assert.match(result.blockers.find((b) => b.code === 'verification_failed')!.message, /inconclusive/i);
});

test('evaluateCompletion: no recorded verification blocks completion', () => {
  const input = greenInput();
  input.verifications = [];

  const result = evaluateCompletion(input);
  assert.equal(result.complete, false);
  assert.ok(codes(input).includes('verification_missing'));
});

test('evaluateCompletion: a missing required sign-off blocks completion', () => {
  const input = greenInput();
  input.signoffs = [];

  const result = evaluateCompletion(input);
  assert.equal(result.complete, false);
  assert.deepEqual(
    result.blockers.map((b) => b.code),
    ['signoff_missing'],
  );
  assert.deepEqual(result.pendingRoleIds, ['lead']);
});

test('evaluateCompletion: a withdrawn (done=false) latest sign-off counts as missing', () => {
  const input = greenInput();
  input.signoffs = [
    signoff({ roleId: 'lead', done: true, createdAt: T2 }),
    signoff({ roleId: 'lead', done: false, createdAt: T3 }),
  ];

  const result = evaluateCompletion(input);
  assert.equal(result.complete, false);
  assert.ok(result.blockers.some((b) => b.code === 'signoff_missing'));
});

test('evaluateCompletion: a team with no required-sign-off role cannot complete', () => {
  const input = greenInput();
  input.roles = input.roles.map((r) => ({ ...r, requiredForSignoff: false }));

  const result = evaluateCompletion(input);
  assert.equal(result.complete, false);
  assert.deepEqual(
    result.blockers.map((b) => b.code),
    ['no_signoff_roles'],
  );
});

// ---------------------------------------------------------------------------
// Done-gate: a self-reported "done" is never sufficient on its own.
// ---------------------------------------------------------------------------

test('evaluateCompletion: a single role declaring done does not complete while a gate is open', () => {
  const input = greenInput();
  // The lead holds a fresh sign-off (declares "done"), but real work remains.
  input.tasks = taskSummary([{ id: 'TASK-001', executionStatus: 'in_progress' }]);

  const result = evaluateCompletion(input);
  assert.equal(result.complete, false);
  assert.ok(result.blockers.some((b) => b.code === 'tasks_incomplete'));
  // The fresh lead sign-off is real, but it is not enough to complete.
  assert.deepEqual(result.freshSignoffRoleIds, ['lead']);
});

test('evaluateCompletion: multiple open gates are all reported', () => {
  const input = greenInput();
  input.tasks = taskSummary([{ id: 'TASK-001', executionStatus: 'blocked' }]);
  input.findings = findingsSummary({ total: 1, open: 1, fixing: 0, fixed: 0, wontfix: 0 });
  input.verifications = [verification({ outcome: 'failed', createdAt: T1 })];
  input.steering = [directive({ id: 'STEER-9', acknowledged: false, createdAt: T0 })];
  input.signoffs = [];

  const result = evaluateCompletion(input);
  assert.equal(result.complete, false);
  const present = new Set(result.blockers.map((b) => b.code));
  for (const code of [
    'tasks_blocked',
    'findings_open',
    'verification_failed',
    'steering_pending',
    'signoff_missing',
  ]) {
    assert.ok(present.has(code as never), `expected blocker ${code}`);
  }
});

// ---------------------------------------------------------------------------
// toDoneGateState.
// ---------------------------------------------------------------------------

test('toDoneGateState reflects the FULL gate and lists open blockers', () => {
  const satisfied = toDoneGateState(evaluateCompletion(greenInput()), T3);
  assert.deepEqual(satisfied, {
    satisfied: true,
    requiredRoleIds: ['lead'],
    signedOffRoleIds: ['lead'],
    pendingRoleIds: [],
    openBlockers: [],
    evaluatedAt: T3,
  });

  // A later verification stales the sign-off → the gate is NOT satisfied and the stale
  // sign-off is surfaced as an explicit open blocker (the UI shows exactly why).
  const stale = greenInput();
  stale.verifications = [verification({ id: 'VER-2', outcome: 'passed', createdAt: T3 })];
  const gate = toDoneGateState(evaluateCompletion(stale), T3);
  assert.equal(gate.satisfied, false);
  assert.deepEqual(gate.pendingRoleIds, ['lead']);
  assert.ok(gate.openBlockers.some((blocker) => blocker.code === 'signoff_stale'));
});

// ---------------------------------------------------------------------------
// Runaway guards.
// ---------------------------------------------------------------------------

const BASE_LIMITS: GuardLimits = {
  maxTurns: 50,
  maxRounds: 20,
  maxNoProgressRounds: 3,
  maxCorrectionCycles: 2,
  maxDurationMs: 3_600_000,
  maxBudget: 1_000_000,
};

function okCounters(overrides: Partial<GuardCounters> = {}): GuardCounters {
  return {
    turns: 1,
    rounds: 1,
    noProgressRounds: 0,
    correctionCycles: 0,
    elapsedMs: 1_000,
    budgetSpent: 100,
    providerLimitHit: false,
    ...overrides,
  };
}

test('evaluateGuards: within all ceilings returns ok with no breaches', () => {
  const result = evaluateGuards(okCounters(), BASE_LIMITS);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.code, null);
  assert.deepEqual(result.breaches, []);
});

test('evaluateGuards: max turns trips to failed', () => {
  const result = evaluateGuards(okCounters({ turns: 50 }), BASE_LIMITS);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.code, 'max_turns');
  assert.match(result.reason!, /50 turns/);
});

test('evaluateGuards: max rounds trips to failed', () => {
  const result = evaluateGuards(okCounters({ rounds: 20 }), BASE_LIMITS);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.code, 'max_rounds');
});

test('evaluateGuards: max no-progress rounds trips to blocked', () => {
  const result = evaluateGuards(okCounters({ noProgressRounds: 3 }), BASE_LIMITS);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.code, 'max_no_progress_rounds');
  assert.match(result.reason!, /stalled or oscillating/i);
});

test('evaluateGuards: exhausted correction cycles trips to blocked', () => {
  const result = evaluateGuards(okCounters({ correctionCycles: 2 }), BASE_LIMITS);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.code, 'max_correction_cycles');
});

test('evaluateGuards: fresh correction cycles do not trip', () => {
  const result = evaluateGuards(okCounters({ correctionCycles: 1 }), BASE_LIMITS);
  assert.equal(result.outcome, 'ok');
});

test('evaluateGuards: time ceiling trips to failed', () => {
  const result = evaluateGuards(okCounters({ elapsedMs: 3_600_000 }), BASE_LIMITS);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.code, 'time_budget');
});

test('evaluateGuards: token/cost budget trips to limit_blocked', () => {
  const result = evaluateGuards(okCounters({ budgetSpent: 1_000_000 }), BASE_LIMITS);
  assert.equal(result.outcome, 'limit_blocked');
  assert.equal(result.code, 'token_budget');
});

test('evaluateGuards: a provider usage limit trips to limit_blocked', () => {
  const result = evaluateGuards(okCounters({ providerLimitHit: true }), BASE_LIMITS);
  assert.equal(result.outcome, 'limit_blocked');
  assert.equal(result.code, 'provider_limit');
});

test('evaluateGuards: the most severe breach is decisive when several trip', () => {
  const result = evaluateGuards(okCounters({ providerLimitHit: true, turns: 50 }), BASE_LIMITS);
  assert.equal(result.outcome, 'limit_blocked');
  assert.equal(result.code, 'provider_limit');
  assert.equal(result.breaches.length, 2);
});

test('evaluateGuards: disabled ceilings (omitted / <= 0) never trip', () => {
  const result = evaluateGuards(okCounters({ turns: 9_999, rounds: 9_999, budgetSpent: 9_999 }), {
    maxCorrectionCycles: -1,
  });
  assert.equal(result.outcome, 'ok');
  assert.deepEqual(result.breaches, []);
});

// ---------------------------------------------------------------------------
// Combined run-gate.
// ---------------------------------------------------------------------------

test('evaluateRunGate: completed when the done-gate is green even if a guard would trip', () => {
  const result = evaluateRunGate(greenInput(), okCounters({ turns: 50 }), BASE_LIMITS);
  assert.equal(result.status, 'completed');
  assert.equal(result.complete, true);
  assert.deepEqual(result.reasons, []);
});

test('evaluateRunGate: a tripped guard yields a terminal outcome when work remains', () => {
  const input = greenInput();
  input.findings = findingsSummary({ total: 1, open: 1, fixing: 0, fixed: 0, wontfix: 0 });
  const result = evaluateRunGate(input, okCounters({ turns: 50 }), BASE_LIMITS);
  assert.equal(result.status, 'failed');
  assert.equal(result.complete, false);
  assert.match(result.reasons.join(' '), /50 turns/);
});

test('evaluateRunGate: still running when work remains and no guard tripped', () => {
  const input = greenInput();
  input.findings = findingsSummary({ total: 1, open: 1, fixing: 0, fixed: 0, wontfix: 0 });
  const result = evaluateRunGate(input, okCounters(), BASE_LIMITS);
  assert.equal(result.status, 'running');
  assert.equal(result.complete, false);
  assert.match(result.reasons.join(' '), /finding/i);
});
