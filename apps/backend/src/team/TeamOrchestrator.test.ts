import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TerminalManager } from '../terminal/TerminalManager.js';
import { Orchestrator } from '../orchestrator/Orchestrator.js';
import { TigerPaths } from '../orchestrator/paths.js';
import { MemoryExecutionPersistence } from '../orchestrator/persistence.js';
import { defaultTigerConfig } from '../orchestrator/config.js';
import { claimNextFinding, splitFindingsToFiles } from '../orchestrator/findings.js';
import { claimNextTaskFile, splitTasksToFiles } from '../orchestrator/tasks.js';
import type { StageRunConfig } from '../orchestrator/types.js';
import {
  FileTeamMessageBus,
  FileTeamPersistence,
  TeamOrchestrator,
  TeamPaths,
  type TeamCompletionGate,
  type TeamMessage,
  type TeamRoleTurnInput,
  type TeamRoleTurnResult,
  type TeamRunState,
  type TeamScheduler,
  type TeamTurnRunner,
} from './TeamOrchestrator.js';

const TASKS_MD = `# Final Tasks

## TASK-001: Resume safely

### Description
Verify team restart reconciliation.

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

## FINDING: Resume stale finding
### Related Task
TASK-001
### Severity
high
### Problem
The finding is stuck in fixing.
### Recommended Fix
Return it to open.
`;

const roles = [
  { id: 'coordinator', name: 'Coordinator', tool: 'codex' as const, responsibilities: [], canWriteCode: false, requiredForSignoff: false },
  { id: 'analyst', name: 'Analyst', tool: 'codex' as const, responsibilities: [], canWriteCode: false, requiredForSignoff: false },
  { id: 'developer', name: 'Developer', tool: 'codex' as const, responsibilities: [], canWriteCode: true, requiredForSignoff: false },
  { id: 'reviewer', name: 'Reviewer', tool: 'codex' as const, responsibilities: [], canWriteCode: false, requiredForSignoff: true },
];

function completionAfterRoleMessages(count: number): TeamCompletionGate {
  return {
    evaluate(_state, context) {
      const roleMessages = context.messages.filter((message) => message.from !== 'user' && message.from !== 'system');
      return roleMessages.length >= count
        ? { complete: true, reasons: [] }
        : { complete: false, reasons: [`Need ${count - roleMessages.length} more role message(s).`] };
    },
  };
}

function neverComplete(): TeamCompletionGate {
  return {
    evaluate() {
      return { complete: false, reasons: ['The fake gate is still open.'] };
    },
  };
}

// A deterministic round-robin scheduler used to isolate the orchestrator's
// event/lifecycle mechanics from scheduler policy (the production default drives
// selection through the pure phase-aware scheduler). It mirrors the engine's
// previous built-in rotation: one runnable role per turn, with the turn/round caps.
function roundRobinScheduler(): TeamScheduler {
  return {
    selectNextTurns(state, context) {
      if (state.status !== 'running') return { turns: [] };
      if (state.turnCount >= context.maxTurns) {
        return { turns: [], terminal: { status: 'blocked', reason: `Team run reached the max turn limit (${context.maxTurns}).` } };
      }
      if (state.round >= context.maxRounds) {
        return { turns: [], terminal: { status: 'blocked', reason: `Team run reached the max round limit (${context.maxRounds}).` } };
      }
      const runnable = state.roles.filter((role) => role.status !== 'blocked' && role.status !== 'interrupted');
      if (runnable.length === 0) {
        return { turns: [], terminal: { status: 'blocked', reason: 'No runnable team roles are configured.' } };
      }
      const role = runnable[state.turnCount % runnable.length]!;
      return { turns: [{ roleId: role.id, reason: 'round robin' }] };
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await delay(10);
  }
}

async function waitForTerminal(orch: TeamOrchestrator, timeoutMs = 5000): Promise<TeamRunState> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = orch.getState().status;
    if (status === 'completed' || status === 'blocked' || status === 'failed' || status === 'stopped') return orch.getState();
    if (Date.now() > deadline) assert.fail(`timed out waiting for team terminal state: ${JSON.stringify(orch.getState())}`);
    await delay(10);
  }
}

test('fake-cli team run emits ordered state/message events and completes only when the gate completes', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-run-'));
  try {
    const runner: TeamTurnRunner = {
      async runRoleTurn(input) {
        return {
          status: 'completed',
          messages: [
            {
              from: input.role.id,
              kind: input.role.id === 'reviewer' ? 'signoff' : 'chat',
              body: `${input.role.id} turn complete`,
            },
          ],
          signoffs: input.role.id === 'reviewer' ? [{}] : [],
        };
      },
    };
    const states: TeamRunState[] = [];
    const messages: TeamMessage[] = [];
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      runner,
      // Pin a deterministic rotation so this test exercises orchestrator mechanics,
      // not scheduler policy (which is covered by scheduler.test.ts).
      scheduler: roundRobinScheduler(),
      completionGate: completionAfterRoleMessages(4),
      maxTurns: 10,
    });
    orch.on('state', (state) => states.push(state as TeamRunState));
    orch.on('message', (message) => messages.push(message as TeamMessage));

    await orch.createTeamRun({ workspace, goal: 'Build the product team flow.', roles });
    await orch.start();
    const final = await waitForTerminal(orch);

    assert.equal(final.status, 'completed');
    assert.equal(final.turnCount, 4);
    assert.ok(states.some((state) => state.status === 'running'));
    assert.ok(states.some((state) => state.status === 'completed'));
    assert.deepEqual(
      messages.filter((message) => message.from !== 'user' && message.from !== 'system').map((message) => message.from),
      ['coordinator', 'analyst', 'developer', 'reviewer'],
    );
    assert.deepEqual(
      (await orch.listMessages()).map((message) => message.seq),
      [1, 2, 3, 4, 5],
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('a turn that signs off via both a message and a result entry records a single sign-off', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-signoff-'));
  try {
    const runner: TeamTurnRunner = {
      async runRoleTurn(input) {
        const signsOff = input.role.id === 'reviewer';
        return {
          status: 'completed',
          messages: [
            {
              from: input.role.id,
              kind: signsOff ? 'signoff' : 'chat',
              body: `${input.role.id} turn complete`,
            },
          ],
          // The reviewer reports the same sign-off twice: once as a chat-visible
          // signoff message and once as a structured result entry. It must be
          // recorded exactly once, not once per source.
          signoffs: signsOff ? [{}] : [],
        };
      },
    };
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      runner,
      scheduler: roundRobinScheduler(),
      completionGate: completionAfterRoleMessages(4),
      maxTurns: 10,
    });
    await orch.createTeamRun({ workspace, goal: 'Sign off exactly once.', roles });
    await orch.start();
    const final = await waitForTerminal(orch);

    assert.equal(final.status, 'completed');
    assert.equal(final.signoffs.length, 1);
    assert.equal(final.signoffs[0]?.roleId, 'reviewer');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('failed fake turn stops the run in an explicit failed state with a reason', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-failed-'));
  try {
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      completionGate: neverComplete(),
      // Make a single failure terminal so this test pins the hard-failure path; the
      // recovery (tolerate failures below the cap) path is covered separately.
      maxConsecutiveFailures: 1,
      runner: {
        async runRoleTurn() {
          return { status: 'failed', reason: 'fake CLI exited 2' };
        },
      },
    });
    await orch.createTeamRun({ workspace, goal: 'Fail clearly.', roles: roles.slice(0, 1) });
    await orch.start();
    const final = await waitForTerminal(orch);
    assert.equal(final.status, 'failed');
    assert.match(final.message ?? '', /fake CLI exited 2/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('a completion gate satisfied by a failing turn does not overwrite the failed status with completed', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-failed-gate-'));
  try {
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      // A gate that is still open at the top of the loop (turnCount === 0) but reports
      // complete once the turn has run (turnCount === 1). The same turn drives the run
      // to `failed`; the post-turn gate re-evaluation must not overwrite that with
      // `completed` now that runLoop bails as soon as the run is no longer running.
      completionGate: {
        evaluate(state) {
          return state.turnCount >= 1
            ? { complete: true, reasons: [] }
            : { complete: false, reasons: ['Waiting for the first turn.'] };
        },
      },
      // A single failure is terminal here, so the failing turn drives the run to
      // `failed` and the post-turn gate must not overwrite that with `completed`.
      maxConsecutiveFailures: 1,
      runner: {
        async runRoleTurn() {
          return { status: 'failed', reason: 'fake CLI exited 2' };
        },
      },
    });
    await orch.createTeamRun({ workspace, goal: 'Fail clearly even when the gate is satisfied.', roles: roles.slice(0, 1) });
    await orch.start();
    const final = await waitForTerminal(orch);
    assert.equal(final.status, 'failed');
    assert.match(final.message ?? '', /fake CLI exited 2/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('a turn failure below the cap is tolerated; the run recovers and completes', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-recover-'));
  try {
    let calls = 0;
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      maxConsecutiveFailures: 3,
      // Complete once any fresh sign-off exists, so the recovering successful turn ends the run.
      completionGate: {
        evaluate(state) {
          return state.signoffs.some((signoff) => !signoff.stale)
            ? { complete: true, reasons: [] }
            : { complete: false, reasons: ['Awaiting sign-off.'] };
        },
      },
      runner: {
        async runRoleTurn(input) {
          calls += 1;
          // Fail the first two turns (below the cap of 3), then succeed and sign off.
          if (calls <= 2) return { status: 'failed', reason: `transient failure ${calls}` };
          return {
            status: 'completed',
            messages: [{ from: input.role.id, kind: 'signoff', body: 'work complete' }],
            signoffs: [{}],
          };
        },
      },
    });
    await orch.createTeamRun({ workspace, goal: 'Recover from transient failures.', roles: roles.slice(0, 1) });
    await orch.start();
    const final = await waitForTerminal(orch);

    assert.equal(final.status, 'completed');
    assert.ok(calls >= 3, 'kept going past the early failures instead of ending on the first one');
    const announced = (await orch.listMessages()).some(
      (message) => message.from === 'system' && /will continue/.test(message.body),
    );
    assert.ok(announced, 'announced the recovery in the conversation');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('steering is appended immediately, stales signoffs, and is applied at the next turn boundary', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-steer-'));
  let releaseDeveloper!: () => void;
  const developerGate = new Promise<void>((resolve) => {
    releaseDeveloper = resolve;
  });
  const calls: { roleId: string; steering: string[] }[] = [];
  const runner: TeamTurnRunner = {
    async runRoleTurn(input) {
      calls.push({ roleId: input.role.id, steering: input.appliedSteering.map((directive) => directive.body) });
      if (input.role.id === 'developer') await developerGate;
      const result: TeamRoleTurnResult = {
        status: 'completed',
        messages: [
          {
            from: input.role.id,
            kind: input.role.id === 'reviewer' ? 'signoff' : 'chat',
            body: `${input.role.id} handled ${input.appliedSteering.map((directive) => directive.body).join(', ')}`,
          },
        ],
      };
      if (input.role.id === 'reviewer') result.signoffs = [{}];
      return result;
    },
  };

  try {
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      runner,
      scheduler: roundRobinScheduler(),
      completionGate: {
        evaluate(state) {
          return state.turnCount >= 3 && state.pendingSteeringCount === 0
            ? { complete: true, reasons: [] }
            : { complete: false, reasons: ['waiting for steering boundary'] };
        },
      },
      maxTurns: 10,
    });
    await orch.createTeamRun({
      workspace,
      goal: 'Initial product goal.',
      roles: [
        { ...roles[3]!, id: 'reviewer', name: 'Reviewer', requiredForSignoff: true },
        { ...roles[2]!, id: 'developer', name: 'Developer', canWriteCode: true },
      ],
    });
    await orch.start();
    await waitFor(() => calls.length >= 2, 'developer turn to start');

    assert.ok(orch.getState().signoffs.length >= 1);
    assert.equal(orch.getState().signoffs.every((signoff) => !signoff.stale), true);
    const steering = await orch.steer('Focus on the authentication flow.');
    assert.equal(steering.kind, 'steering');
    assert.equal(orch.getState().signoffs.every((signoff) => signoff.stale), true);
    assert.equal(calls[1]!.roleId, 'developer');
    assert.equal(calls[1]!.steering.includes('Focus on the authentication flow.'), false);

    releaseDeveloper();
    await waitFor(() => calls.length >= 3, 'post-steering reviewer turn');
    assert.equal(calls[2]!.roleId, 'reviewer');
    assert.equal(calls[2]!.steering.includes('Focus on the authentication flow.'), true);
    const final = await waitForTerminal(orch);
    assert.equal(final.status, 'completed');
    assert.ok((await orch.listMessages()).some((message) => message.id === steering.id));
  } finally {
    releaseDeveloper();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('team and stage runs reject each other through the shared workspace lease', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-lease-'));
  try {
    const persistence = new MemoryExecutionPersistence();
    const paths = new TigerPaths(workspace);
    const stageLease = await persistence.acquireRunLease({
      workspace,
      tigerRoot: paths.root,
      owner: { type: 'queue', id: 'stage-owner' },
      ttlMs: 60_000,
    });
    assert.equal(stageLease.ok, true);

    const team = new TeamOrchestrator({
      executionPersistence: persistence,
      completionGate: neverComplete(),
      runner: { async runRoleTurn() { return { status: 'completed' }; } },
    });
    await team.createTeamRun({ workspace, goal: 'Should conflict.', roles: roles.slice(0, 1) });
    const teamErr = await team.start().then(
      () => null,
      (err: unknown) => err as { status?: number; message?: string },
    );
    assert.equal(teamErr?.status, 409);
    assert.match(teamErr?.message ?? '', /leased by queue:stage-owner/);

    if (stageLease.ok) await persistence.finishRun(stageLease.runId, 'stopped');

    const blockingTeam = new TeamOrchestrator({
      executionPersistence: persistence,
      completionGate: neverComplete(),
      runner: {
        async runRoleTurn(input) {
          await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }));
          return { status: 'stopped', reason: 'aborted' };
        },
      },
      lockTtlMs: 60_000,
    });
    await blockingTeam.createTeamRun({ workspace, goal: 'Hold the lease.', roles: roles.slice(0, 1) });
    await blockingTeam.start();
    await waitFor(() => [...persistence.runs.values()].some((run) => run.status === 'running'), 'team lease');

    const stage = new Orchestrator(new TerminalManager(), {
      persistence,
      owner: { type: 'manual', id: `${process.pid}:stage-test` },
    });
    await stage.initialize(workspace, 'Project prompt');
    const stageErr = await stage.startStage('brainstorming', zeroAgentConfig()).then(
      () => null,
      (err: unknown) => err as { status?: number; message?: string },
    );
    assert.equal(stageErr?.status, 409);
    assert.match(stageErr?.message ?? '', /leased by manual:/);
    await blockingTeam.stop();
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('restart reconciliation interrupts in-flight turns, reclaims stale claims, and resumes from transcript', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-restart-'));
  try {
    const store = new FileTeamPersistence();
    const bus = new FileTeamMessageBus();
    const first = new TeamOrchestrator({
      teamPersistence: store,
      messageBus: bus,
      executionPersistence: new MemoryExecutionPersistence(),
      completionGate: neverComplete(),
      runner: { async runRoleTurn() { return { status: 'completed' }; } },
    });
    const created = await first.createTeamRun({
      workspace,
      goal: 'Resume from persisted transcript.',
      roles: roles.slice(0, 2),
    });
    const paths = new TeamPaths(workspace, created.runId);
    await bus.append(paths, {
      from: 'coordinator',
      kind: 'chat',
      body: 'persisted coordinator message',
    });
    const interruptedTurn = {
      id: 'turn-developer-running',
      runId: created.runId,
      roleId: 'analyst',
      roleName: 'Analyst',
      status: 'running' as const,
      round: 2,
      startedAt: nowForTest(),
      messageSeqs: [],
      appliedDirectiveIds: [],
    };
    await store.saveRun({
      ...created,
      status: 'running',
      startedAt: nowForTest(),
      round: 2,
      turnCount: 1,
      messageCount: 2,
      currentTurn: interruptedTurn,
      turns: [interruptedTurn],
    });

    const tiger = new TigerPaths(workspace);
    await splitTasksToFiles(TASKS_MD, tiger.tasksDir);
    const oldDate = new Date('2020-01-01T00:00:00.000Z');
    const claimedTask = await claimNextTaskFile(tiger.tasksDir, 'team-dead', oldDate.toISOString(), {
      locksDir: tiger.locksDir,
      agentType: 'codex',
      ttlMs: 1,
      nowMs: Date.now(),
    });
    assert.equal(claimedTask?.record.id, 'TASK-001');
    await fs.rm(tiger.lockFile('TASK-001'), { force: true });
    await fs.utimes(path.join(tiger.tasksDir, 'TASK-001__in_progress.md'), oldDate, oldDate);

    await splitFindingsToFiles([{ label: 'reviewer', content: REVIEW_LOG }], tiger.findingsDir);
    const claimedFinding = await claimNextFinding(tiger.findingsDir, {
      locksDir: tiger.findingLocksDir,
      agentId: 'team-dead',
      agentType: 'codex',
      ttlMs: 1,
      nowMs: Date.now(),
    });
    assert.equal(claimedFinding?.id, 'FINDING-001');
    await fs.rm(path.join(tiger.findingLocksDir, 'FINDING-001.lock'), { force: true });
    await fs.utimes(path.join(tiger.findingsDir, 'FINDING-001__fixing.md'), oldDate, oldDate);

    const seenTranscript: string[][] = [];
    const restarted = new TeamOrchestrator({
      teamPersistence: store,
      messageBus: bus,
      executionPersistence: new MemoryExecutionPersistence(),
      scheduler: roundRobinScheduler(),
      completionGate: completionAfterRoleMessages(2),
      runner: {
        async runRoleTurn(input: TeamRoleTurnInput) {
          seenTranscript.push(input.messages.map((message) => message.body));
          return {
            status: 'completed',
            messages: [
              {
                from: input.role.id,
                kind: 'chat',
                body: `${input.role.id} resumed`,
              },
            ],
          };
        },
      },
    });
    await restarted.resume({ workspace, runId: created.runId });
    const final = await waitForTerminal(restarted);

    assert.equal(final.status, 'completed');
    assert.ok(final.turns.some((turn) => turn.id === 'turn-developer-running' && turn.status === 'interrupted'));
    assert.ok(seenTranscript[0]?.includes('persisted coordinator message'));
    assert.equal(await exists(path.join(tiger.tasksDir, 'TASK-001__not_started.md')), true);
    assert.equal(await exists(path.join(tiger.findingsDir, 'FINDING-001__open.md')), true);
    const allMessages = await restarted.listMessages();
    assert.equal(allMessages.filter((message) => message.body === 'persisted coordinator message').length, 1);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('out of the box the engine composes the real scheduler and completion gate to a clean completion', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-compose-'));
  try {
    let turnNo = 0;
    // Only the runner is faked; the scheduler and completion gate are the engine's
    // real defaults (selectNextTurns + evaluateRunGate). The run must complete only
    // once a verification has passed AND the required role holds a fresh sign-off.
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      maxTurns: 8,
      runner: {
        async runRoleTurn(input) {
          turnNo += 1;
          if (turnNo === 1) {
            return {
              status: 'completed',
              messages: [{ from: input.role.id, kind: 'chat', body: 'verified the build' }],
              verification: {
                status: 'passed',
                summary: 'build and tests passed',
                createdAt: '2020-01-01T00:00:00.000Z',
                completedAt: '2020-01-01T00:00:00.000Z',
              },
            };
          }
          return {
            status: 'completed',
            messages: [{ from: input.role.id, kind: 'signoff', body: 'all work is done' }],
            signoffs: [{}],
          };
        },
      },
    });
    await orch.createTeamRun({
      workspace,
      goal: 'Compose the dedicated team modules.',
      roles: [
        { id: 'coordinator', name: 'Coordinator', tool: 'codex' as const, responsibilities: [], canWriteCode: false, requiredForSignoff: true },
      ],
    });
    await orch.start();
    const final = await waitForTerminal(orch);

    assert.equal(final.status, 'completed');
    assert.equal(final.turnCount, 2);
    assert.equal(final.verifications.length, 1);
    assert.equal(final.verifications[0]?.status, 'passed');
    assert.ok(final.signoffs.some((signoff) => signoff.roleId === 'coordinator' && !signoff.stale));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('the default completion gate keeps a run open while a review finding is unresolved', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-findinggate-'));
  try {
    // Seed an open review finding. The reduced gate this engine used to ship ignored
    // task/finding progress and would have completed once verification + a fresh
    // sign-off were present; the composed gate (evaluateCompletion) must keep it open.
    const tiger = new TigerPaths(workspace);
    await splitFindingsToFiles([{ label: 'reviewer', content: REVIEW_LOG }], tiger.findingsDir);

    let turnNo = 0;
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      // Round-robin keeps scheduling deterministic so the completion gate is the only
      // thing under test here.
      scheduler: roundRobinScheduler(),
      maxTurns: 3,
      runner: {
        async runRoleTurn(input) {
          turnNo += 1;
          if (turnNo === 1) {
            return {
              status: 'completed',
              messages: [{ from: input.role.id, kind: 'chat', body: 'verified the build' }],
              verification: {
                status: 'passed',
                summary: 'checks passed',
                createdAt: '2020-01-01T00:00:00.000Z',
                completedAt: '2020-01-01T00:00:00.000Z',
              },
            };
          }
          return {
            status: 'completed',
            messages: [{ from: input.role.id, kind: 'signoff', body: 'done from my side' }],
            signoffs: [{}],
          };
        },
      },
    });
    await orch.createTeamRun({
      workspace,
      goal: 'Do not stop while a finding is open.',
      roles: [
        { id: 'coordinator', name: 'Coordinator', tool: 'codex' as const, responsibilities: [], canWriteCode: false, requiredForSignoff: true },
      ],
    });
    await orch.start();
    const final = await waitForTerminal(orch);

    // A verification passed and the required role signed off, but the open finding
    // holds the gate shut, so the run never reports completed.
    assert.notEqual(final.status, 'completed');
    assert.equal(final.findings?.open, 1);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

function zeroAgentConfig(): StageRunConfig {
  const d = defaultTigerConfig().defaults;
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
    parallel: false,
    mergeAgent: 'codex',
  };
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

function nowForTest(): string {
  return new Date().toISOString();
}

test('the lead assigns a task that is queued, claimed, run with its content, and filed done on the board', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-board-'));
  try {
    let devTaskContent: string | undefined;
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      maxTurns: 12,
      // Complete once the developer (the only required role) holds a fresh sign-off.
      completionGate: {
        evaluate(state) {
          return state.signoffs.some((s) => s.roleId === 'developer' && !s.stale)
            ? { complete: true, reasons: [] }
            : { complete: false, reasons: ['Awaiting developer sign-off.'] };
        },
      },
      runner: {
        async runRoleTurn(input) {
          if (input.role.id === 'coordinator' && !devTaskContent) {
            // The lead assigns concrete work to the developer.
            return {
              status: 'completed',
              messages: [
                { from: 'coordinator', kind: 'task', to: 'developer', body: 'Implement feature X\nAcceptance: it works.' },
              ],
            };
          }
          if (input.role.id === 'developer') {
            // The developer received the assigned task as its turn context, then signs off.
            devTaskContent = input.assignedTask?.content;
            return {
              status: 'completed',
              messages: [{ from: 'developer', kind: 'signoff', body: 'Feature X implemented.' }],
              signoffs: [{}],
            };
          }
          return { status: 'completed', messages: [{ from: input.role.id, kind: 'chat', body: 'ack' }] };
        },
      },
    });
    await orch.createTeamRun({
      workspace,
      goal: 'Assign and complete one task.',
      roles: [
        { id: 'coordinator', name: 'Coordinator', tool: 'codex' as const, responsibilities: [], canWriteCode: false, requiredForSignoff: false },
        { id: 'developer', name: 'Developer', tool: 'codex' as const, responsibilities: [], canWriteCode: true, requiredForSignoff: true },
      ],
    });
    await orch.start();
    const final = await waitForTerminal(orch);

    assert.equal(final.status, 'completed');
    // The developer's turn actually received the Lead-assigned task content.
    assert.match(devTaskContent ?? '', /Implement feature X/);
    // The task progressed todo → in-progress → done on the file board.
    const agentDir = path.join(workspace, '.tiger', 'team', final.runId, 'agents', 'developer');
    const done = await fs.readdir(path.join(agentDir, 'done')).catch(() => [] as string[]);
    const todo = await fs.readdir(path.join(agentDir, 'todo')).catch(() => [] as string[]);
    assert.ok(done.some((n) => /TASK-\d+\.json/.test(n)), 'a developer task was filed to done');
    assert.equal(todo.filter((n) => n.endsWith('.json')).length, 0, 'no developer task left queued');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
