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
  type TeamTurnRecord,
  type TeamTurnRunner,
} from './TeamOrchestrator.js';
import { TaskBoard, type AgentTask } from './task-board.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Minimal git repo so worktree-per-task isolation (which requires a git workspace) actually engages. */
async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), '# test\n', 'utf8');
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

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
  {
    id: 'coordinator',
    name: 'Coordinator',
    tool: 'codex' as const,
    responsibilities: [],
    canWriteCode: false,
    requiredForSignoff: false,
  },
  {
    id: 'analyst',
    name: 'Analyst',
    tool: 'codex' as const,
    responsibilities: [],
    canWriteCode: false,
    requiredForSignoff: false,
  },
  {
    id: 'developer',
    name: 'Developer',
    tool: 'codex' as const,
    responsibilities: [],
    canWriteCode: true,
    requiredForSignoff: false,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    tool: 'codex' as const,
    responsibilities: [],
    canWriteCode: false,
    requiredForSignoff: true,
  },
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
        return {
          turns: [],
          terminal: { status: 'blocked', reason: `Team run reached the max turn limit (${context.maxTurns}).` },
        };
      }
      if (state.round >= context.maxRounds) {
        return {
          turns: [],
          terminal: { status: 'blocked', reason: `Team run reached the max round limit (${context.maxRounds}).` },
        };
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

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
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
    if (status === 'completed' || status === 'blocked' || status === 'failed' || status === 'stopped')
      return orch.getState();
    if (Date.now() > deadline)
      assert.fail(`timed out waiting for team terminal state: ${JSON.stringify(orch.getState())}`);
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
    // `waitForTerminal` returns as soon as getState().status flips to a terminal value,
    // which finishRun sets before its async cleanup and the terminal `state` event is
    // emitted. Wait for the events themselves so this assertion does not race that emit.
    await waitFor(() => states.some((state) => state.status === 'running'), 'a running state event');
    await waitFor(() => states.some((state) => state.status === 'completed'), 'a completed state event');
    assert.deepEqual(
      messages.filter((message) => message.from !== 'user' && message.from !== 'system').map((message) => message.from),
      ['coordinator', 'analyst', 'developer', 'reviewer'],
    );
    assert.deepEqual(
      (await orch.listMessages()).map((message) => message.seq),
      [1, 2, 3, 4, 5],
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
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
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
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
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
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
    await orch.createTeamRun({
      workspace,
      goal: 'Fail clearly even when the gate is satisfied.',
      roles: roles.slice(0, 1),
    });
    await orch.start();
    const final = await waitForTerminal(orch);
    assert.equal(final.status, 'failed');
    assert.match(final.message ?? '', /fake CLI exited 2/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
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
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('a role that keeps failing between successful turns is parked blocked instead of looping forever', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-role-breaker-'));
  try {
    // The coordinator (resolved Lead) always succeeds; the developer always fails. The GLOBAL
    // consecutive-failure guard resets on every coordinator success, so without the per-role
    // breaker this run would alternate success/failure to the round cap (the exact "hour-long
    // timeout loop" pathology). The per-role breaker must park the developer as blocked after
    // maxConsecutiveFailures of ITS OWN turns, while the run itself stays healthy.
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      maxConsecutiveFailures: 3,
      scheduler: roundRobinScheduler(),
      completionGate: {
        evaluate(state) {
          return state.roles.some((role) => role.status === 'blocked')
            ? { complete: true, reasons: [] }
            : { complete: false, reasons: ['Waiting for the breaker to trip.'] };
        },
      },
      runner: {
        async runRoleTurn(input) {
          if (input.role.id === 'developer') return { status: 'failed', reason: 'agent timed out (simulated)' };
          return { status: 'completed', messages: [{ from: input.role.id, kind: 'chat', body: 'coordinated' }] };
        },
      },
    });
    await orch.createTeamRun({
      workspace,
      goal: 'Park a persistently failing role.',
      roles: [roles[0]!, roles[2]!], // coordinator (Lead) + developer
    });
    await orch.start();
    const final = await waitForTerminal(orch);

    const developer = final.roles.find((role) => role.id === 'developer');
    assert.equal(developer?.status, 'blocked');
    assert.match(developer?.statusNote ?? '', /Parked after 3 consecutive failed turns/);
    // The run itself was NOT driven to failed by the alternating pattern.
    assert.equal(final.status, 'completed');
    const parkedNotice = (await orch.listMessages()).some(
      (message) =>
        message.from === 'system' && /parked \(blocked\) after 3 consecutive failed turns/i.test(message.body),
    );
    assert.ok(parkedNotice, 'announced the parking in the conversation');

    // resumeRole un-parks a failure-parked (blocked) role so it can be scheduled again.
    const resumed = await orch.resumeRole('developer');
    const resumedDeveloper = resumed.roles.find((role) => role.id === 'developer');
    assert.equal(resumedDeveloper?.status, 'idle');
    assert.equal(resumedDeveloper?.statusNote, undefined);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
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
    assert.equal(
      orch.getState().signoffs.every((signoff) => !signoff.stale),
      true,
    );
    const steering = await orch.steer('Focus on the authentication flow.');
    assert.equal(steering.kind, 'steering');
    assert.equal(
      orch.getState().signoffs.every((signoff) => signoff.stale),
      true,
    );
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
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
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
      runner: {
        async runRoleTurn() {
          return { status: 'completed' };
        },
      },
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
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
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
      runner: {
        async runRoleTurn() {
          return { status: 'completed' };
        },
      },
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
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('out of the box the engine composes the real scheduler and completion gate to a clean completion', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-compose-'));
  try {
    let assigned = false;
    // Only the runner is faked; the scheduler and completion gate are the engine's
    // real defaults (selectNextTurns + evaluateRunGate). The run must complete only
    // once a verification has passed AND the required role holds a fresh sign-off.
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      maxTurns: 8,
      runner: {
        async runRoleTurn(input) {
          if (input.role.id === 'lead' && !assigned) {
            assigned = true;
            return {
              status: 'completed',
              messages: [
                {
                  from: 'lead',
                  kind: 'task',
                  to: 'developer',
                  body: 'Verify the build.\nAcceptance: report evidence.',
                },
              ],
            };
          }
          if (input.role.id === 'developer') {
            return {
              status: 'completed',
              messages: [{ from: 'developer', kind: 'signoff', body: 'all work is done' }],
              verification: {
                status: 'passed',
                summary: 'build and tests passed',
                createdAt: '2020-01-01T00:00:00.000Z',
                completedAt: '2020-01-01T00:00:00.000Z',
              },
              signoffs: [{}],
            };
          }
          return { status: 'completed' };
        },
      },
    });
    await orch.createTeamRun({
      workspace,
      goal: 'Compose the dedicated team modules.',
      roles: [
        {
          id: 'lead',
          name: 'Lead',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: false,
          requiredForSignoff: false,
        },
        {
          id: 'developer',
          name: 'Developer',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: true,
          requiredForSignoff: true,
        },
      ],
    });
    await orch.start();
    const final = await waitForTerminal(orch);

    assert.equal(final.status, 'completed');
    assert.equal(final.turnCount, 2);
    assert.equal(final.verifications.length, 1);
    assert.equal(final.verifications[0]?.status, 'passed');
    assert.ok(final.signoffs.some((signoff) => signoff.roleId === 'developer' && !signoff.stale));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
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
        {
          id: 'coordinator',
          name: 'Coordinator',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: false,
          requiredForSignoff: true,
        },
      ],
    });
    await orch.start();
    const final = await waitForTerminal(orch);

    // A verification passed and the required role signed off, but the open finding
    // holds the gate shut, so the run never reports completed.
    assert.notEqual(final.status, 'completed');
    assert.equal(final.findings?.open, 1);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
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
                {
                  from: 'coordinator',
                  kind: 'task',
                  to: 'developer',
                  body: 'Implement feature X\nAcceptance: it works.',
                },
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
        {
          id: 'coordinator',
          name: 'Coordinator',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: false,
          requiredForSignoff: false,
        },
        {
          id: 'developer',
          name: 'Developer',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: true,
          requiredForSignoff: true,
        },
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
    assert.ok(
      done.some((n) => /TASK-\d+\.json/.test(n)),
      'a developer task was filed to done',
    );
    assert.equal(todo.filter((n) => n.endsWith('.json')).length, 0, 'no developer task left queued');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

// ---------------------------------------------------------------------------
// Lead-owned flow (TASK-0001): the Lead is the single coordinator and decision-maker.
// Every user prompt routes to the Lead first; the Lead sequences one unit of work at a
// time; after any worker turn the Lead reviews before the next role task; no
// round/round-robin progression; idle/wait when there is no Lead-assigned work.
// These tests use the engine's DEFAULT scheduler (no injected scheduler).
// ---------------------------------------------------------------------------

/** A team whose first role is the Lead, plus a developer and a tester. */
function leadTeam(): typeof roles {
  return [
    {
      id: 'lead',
      name: 'Lead',
      tool: 'codex' as const,
      responsibilities: [],
      canWriteCode: false,
      requiredForSignoff: true,
    },
    {
      id: 'developer',
      name: 'Developer',
      tool: 'codex' as const,
      responsibilities: [],
      canWriteCode: true,
      requiredForSignoff: true,
    },
    {
      id: 'tester',
      name: 'Tester',
      tool: 'codex' as const,
      responsibilities: [],
      canWriteCode: true,
      requiredForSignoff: false,
    },
  ];
}

/** Complete once every listed role holds a fresh (non-stale) sign-off. */
function completeWhenSignedOff(...roleIds: string[]): TeamCompletionGate {
  return {
    evaluate(state) {
      const ok = roleIds.every((id) => state.signoffs.some((s) => s.roleId === id && !s.stale));
      return ok ? { complete: true, reasons: [] } : { complete: false, reasons: ['Awaiting required sign-offs.'] };
    },
  };
}

test('a new run schedules the Lead first; no worker role runs until the Lead assigns it work', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-leadfirst-'));
  try {
    const order: string[] = [];
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      // Default Lead-owned scheduler (not injected).
      completionGate: completeWhenSignedOff('developer'),
      maxTurns: 12,
      runner: {
        async runRoleTurn(input) {
          order.push(input.role.id);
          if (input.role.id === 'lead') {
            return {
              status: 'completed',
              messages: [
                { from: 'lead', kind: 'task', to: 'developer', body: 'Implement feature\nAcceptance: it works.' },
              ],
            };
          }
          return {
            status: 'completed',
            messages: [{ from: input.role.id, kind: 'signoff', body: `${input.role.id} done` }],
            signoffs: [{}],
          };
        },
      },
    });
    await orch.createTeamRun({ workspace, goal: 'Build the thing.', roles: leadTeam() });
    await orch.start();
    const final = await waitForTerminal(orch);

    assert.equal(final.status, 'completed');
    // The Lead ran first; the only worker that ran is the one the Lead assigned. The
    // tester never ran because the Lead never assigned it work — no blind rotation.
    assert.deepEqual(order, ['lead', 'developer']);
    assert.equal(final.turns.filter((turn) => turn.roleId === 'tester').length, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('a Lead task addressed to a role kind routes to an idle same-kind instance', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-kindpool-'));
  try {
    const order: string[] = [];
    let assignedTitle = '';
    let orch!: TeamOrchestrator;
    orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      completionGate: completeWhenSignedOff('developer-2'),
      maxTurns: 8,
      runner: {
        async runRoleTurn(input) {
          order.push(input.role.id);
          if (input.role.id === 'lead') {
            await orch.pauseRole('developer', 'already working on another task');
            return {
              status: 'completed',
              messages: [
                { from: 'lead', kind: 'task', to: 'developer', body: 'Implement pooled feature\nAcceptance: works.' },
              ],
            };
          }
          if (input.role.id === 'developer-2') {
            assignedTitle = input.assignedTask?.title ?? '';
            return {
              status: 'completed',
              messages: [{ from: 'developer-2', kind: 'signoff', body: 'developer-2 done' }],
              signoffs: [{}],
            };
          }
          return { status: 'completed', messages: [{ from: input.role.id, kind: 'chat', body: 'unexpected' }] };
        },
      },
    });
    await orch.createTeamRun({
      workspace,
      goal: 'Route to an idle developer instance.',
      roles: [
        {
          id: 'lead',
          name: 'Lead',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: false,
          requiredForSignoff: true,
        },
        {
          id: 'developer',
          name: 'Developer #1',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: true,
          requiredForSignoff: true,
        },
        {
          id: 'developer-2',
          name: 'Developer #2',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: true,
          requiredForSignoff: true,
        },
      ],
    });
    await orch.start();
    const final = await waitForTerminal(orch);

    assert.equal(final.status, 'completed');
    assert.deepEqual(order, ['lead', 'developer-2']);
    assert.match(assignedTitle, /Implement pooled feature/);
    const dev1Todo = await fs
      .readdir(path.join(workspace, '.tiger', 'team', final.runId, 'agents', 'developer', 'todo'))
      .catch(() => [] as string[]);
    const dev2Done = await fs
      .readdir(path.join(workspace, '.tiger', 'team', final.runId, 'agents', 'developer-2', 'done'))
      .catch(() => [] as string[]);
    assert.equal(dev1Todo.filter((name) => name.endsWith('.json')).length, 0);
    assert.equal(dev2Done.filter((name) => name.endsWith('.json')).length, 1);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('every user prompt is queued for the Lead in FIFO order and addressed to the Lead', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-leadqueue-'));
  try {
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      completionGate: neverComplete(),
      runner: {
        async runRoleTurn() {
          return { status: 'completed' };
        },
      },
    });
    // Created but not started: steering is allowed while paused, so we can assert routing
    // and FIFO without racing the run loop.
    await orch.createTeamRun({ workspace, goal: 'First goal.', roles: leadTeam() });
    await orch.steer('Second prompt.');
    await orch.steer('Third prompt.');

    const state = orch.getState();
    // The goal and both later prompts are queued for the Lead, in arrival order (FIFO),
    // not routed to whichever role would run next.
    assert.deepEqual(
      state.directives.map((directive) => directive.body),
      ['First goal.', 'Second prompt.', 'Third prompt.'],
    );
    assert.equal(
      state.directives.every((directive) => directive.status === 'pending'),
      true,
    );
    assert.equal(state.pendingSteeringCount, 3);

    const steering = (await orch.listMessages()).filter((message) => message.kind === 'steering');
    assert.deepEqual(
      steering.map((message) => message.body),
      ['First goal.', 'Second prompt.', 'Third prompt.'],
    );
    assert.equal(
      steering.every((message) => message.to === 'lead'),
      true,
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('a worker completion routes back to the Lead before the next worker (no auto-advance dev → tester)', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-leadbetween-'));
  try {
    const order: string[] = [];
    let leadTurns = 0;
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      completionGate: completeWhenSignedOff('lead', 'developer', 'tester'),
      maxTurns: 16,
      runner: {
        async runRoleTurn(input) {
          order.push(input.role.id);
          if (input.role.id === 'lead') {
            leadTurns += 1;
            if (leadTurns === 1) {
              // The Lead queues work for BOTH workers up front. Even so, the engine must
              // not run tester right after developer — the Lead has to review in between.
              return {
                status: 'completed',
                messages: [
                  { from: 'lead', kind: 'task', to: 'developer', body: 'Build feature\nAcceptance: works.' },
                  { from: 'lead', kind: 'task', to: 'tester', body: 'Test feature\nAcceptance: passes.' },
                ],
              };
            }
            return {
              status: 'completed',
              messages: [{ from: 'lead', kind: 'signoff', body: 'lead done' }],
              signoffs: [{}],
            };
          }
          return {
            status: 'completed',
            messages: [{ from: input.role.id, kind: 'signoff', body: `${input.role.id} done` }],
            signoffs: [{}],
          };
        },
      },
    });
    await orch.createTeamRun({ workspace, goal: 'Coordinate dependent work.', roles: leadTeam() });
    await orch.start();
    const final = await waitForTerminal(orch);

    assert.equal(final.status, 'completed');
    // A Lead turn sits between the developer and the tester even though tester already had
    // a queued task: the worker→worker hand-off always goes through the Lead.
    assert.deepEqual(order, ['lead', 'developer', 'lead', 'tester']);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('a task retries once, then parks after consecutive timeout/parse failures and alerts the Lead', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-task-park-'));
  try {
    let leadTurns = 0;
    let developerTurns = 0;
    let sawRetry = false;
    const messages: TeamMessage[] = [];
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      completionGate: neverComplete(),
      maxTurns: 12,
      maxConsecutiveFailures: 99,
      maxConsecutiveTaskFailures: 2,
      runner: {
        async runRoleTurn(input) {
          if (input.role.id === 'lead') {
            leadTurns += 1;
            return leadTurns === 1
              ? {
                  status: 'completed',
                  messages: [
                    { from: 'lead', kind: 'task', to: 'developer', body: 'Implement unstable task\nAcceptance: done.' },
                  ],
                }
              : {
                  status: 'completed',
                  messages: [{ from: 'lead', kind: 'chat', body: 'Reviewed failed task.' }],
                };
          }

          developerTurns += 1;
          if (developerTurns === 2 && input.assignedTask?.id === 'TASK-0001') sawRetry = true;
          return {
            status: 'failed',
            reason:
              developerTurns === 1
                ? 'agent timed out before signaling completion'
                : 'Role turn output was invalid: output did not contain any TeamMessage blocks',
          };
        },
      },
    });
    orch.on('message', (message) => messages.push(message as TeamMessage));
    const created = await orch.createTeamRun({ workspace, goal: 'Park repeated task failures.', roles: leadTeam() });
    await orch.start();

    await waitFor(
      () =>
        messages.some(
          (message) =>
            message.kind === 'blocker' && message.to === 'lead' && /parked after 2 consecutive/i.test(message.body),
        ),
      'parked task blocker',
      8000,
    );
    await orch.stop();

    assert.equal(developerTurns, 2, 'the task should run once, retry once, then park');
    assert.equal(sawRetry, true, 'the first eligible failure should return the same task to the claimable queue');

    const board = new TaskBoard(path.join(workspace, '.tiger', 'team', created.runId));
    const parked = await board.findTask('developer', 'TASK-0001');
    assert.equal(parked?.status, 'blocked');
    assert.equal(parked?.task.failureCount, 2);
    assert.match(parked?.task.blockedReason ?? '', /output was invalid/);
    assert.equal(
      await board.claimNext('developer', '2020-01-01T00:00:00.000Z'),
      null,
      'parked tasks are not claimable',
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

// ---------------------------------------------------------------------------
// Company orchestration mode (TASK-0005): behind the `orchestrationMode:'company'`
// flag, worker board claims can batch one writer plus read-only turns, normal worker
// completions do not force a Lead turn, same-kind all-busy tasks defer fairly, and
// completion requires an explicit Lead project-complete decision.
// ---------------------------------------------------------------------------

test('company mode claims one write task plus read-only work, while legacy still claims one task', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-company-claim-'));
  try {
    const companyOrch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      maxConcurrentReadOnly: 2,
    });
    const company = await companyOrch.createTeamRun({
      workspace,
      goal: 'Batch company work.',
      orchestrationMode: 'company',
      roles: [
        {
          id: 'lead',
          name: 'Lead',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: false,
          requiredForSignoff: true,
        },
        {
          id: 'developer-a',
          name: 'Developer A',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: true,
          requiredForSignoff: false,
        },
        {
          id: 'developer-b',
          name: 'Developer B',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: true,
          requiredForSignoff: false,
        },
        {
          id: 'analyst',
          name: 'Analyst',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: false,
          requiredForSignoff: false,
        },
        {
          id: 'reviewer',
          name: 'Reviewer',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: false,
          requiredForSignoff: false,
        },
      ],
    });
    const companyBoard = new TaskBoard(path.join(workspace, '.tiger', 'team', company.runId));
    await companyBoard.enqueue({
      roleId: 'developer-a',
      title: 'Write A',
      body: 'write A',
      createdAt: '2020-01-01T00:00:01.000Z',
    });
    await companyBoard.enqueue({
      roleId: 'developer-b',
      title: 'Write B',
      body: 'write B',
      createdAt: '2020-01-01T00:00:02.000Z',
    });
    await companyBoard.enqueue({
      roleId: 'analyst',
      title: 'Analyze',
      body: 'analyze',
      createdAt: '2020-01-01T00:00:03.000Z',
    });
    await companyBoard.enqueue({
      roleId: 'reviewer',
      title: 'Review',
      body: 'review',
      createdAt: '2020-01-01T00:00:04.000Z',
    });

    const claimed = await (companyOrch as any).claimNextAgentTasks('lead', { readOnlyLimit: 2 });
    assert.deepEqual(
      claimed.map((entry: { roleId: string }) => entry.roleId),
      ['developer-a', 'analyst', 'reviewer'],
    );
    assert.deepEqual(await companyBoard.counts('developer-a'), { todo: 0, inProgress: 1, done: 0 });
    assert.deepEqual(await companyBoard.counts('developer-b'), { todo: 1, inProgress: 0, done: 0 });
    assert.deepEqual(await companyBoard.counts('analyst'), { todo: 0, inProgress: 1, done: 0 });
    assert.deepEqual(await companyBoard.counts('reviewer'), { todo: 0, inProgress: 1, done: 0 });

    const legacyWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-legacy-claim-'));
    try {
      const legacyOrch = new TeamOrchestrator({ executionPersistence: new MemoryExecutionPersistence() });
      const legacy = await legacyOrch.createTeamRun({
        workspace: legacyWorkspace,
        goal: 'Legacy work.',
        roles: [
          {
            id: 'lead',
            name: 'Lead',
            tool: 'codex' as const,
            responsibilities: [],
            canWriteCode: false,
            requiredForSignoff: true,
          },
          {
            id: 'analyst',
            name: 'Analyst',
            tool: 'codex' as const,
            responsibilities: [],
            canWriteCode: false,
            requiredForSignoff: false,
          },
          {
            id: 'developer',
            name: 'Developer',
            tool: 'codex' as const,
            responsibilities: [],
            canWriteCode: true,
            requiredForSignoff: false,
          },
        ],
      });
      const legacyBoard = new TaskBoard(path.join(legacyWorkspace, '.tiger', 'team', legacy.runId));
      await legacyBoard.enqueue({
        roleId: 'analyst',
        title: 'Analyze legacy',
        body: 'analyze',
        createdAt: '2020-01-01T00:00:01.000Z',
      });
      await legacyBoard.enqueue({
        roleId: 'developer',
        title: 'Write legacy',
        body: 'write',
        createdAt: '2020-01-01T00:00:02.000Z',
      });
      const single = await (legacyOrch as any).claimNextAgentTask('lead');
      assert.equal(single?.roleId, 'analyst');
      assert.deepEqual(await legacyBoard.counts('analyst'), { todo: 0, inProgress: 1, done: 0 });
      assert.deepEqual(await legacyBoard.counts('developer'), { todo: 1, inProgress: 0, done: 0 });
    } finally {
      await fs.rm(legacyWorkspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('company mode may claim two write tasks when worktree-per-task isolation is enabled', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-company-write-cap-'));
  try {
    // Worktree isolation only engages on a real git repo, so multi-writer concurrency requires one.
    await initGitRepo(workspace);
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      maxConcurrentWrite: 2,
      worktreePerTask: true,
    });
    const run = await orch.createTeamRun({
      workspace,
      goal: 'Batch isolated write work.',
      orchestrationMode: 'company',
      roles: [
        {
          id: 'lead',
          name: 'Lead',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: false,
          requiredForSignoff: true,
        },
        {
          id: 'developer-a',
          name: 'Developer A',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: true,
          requiredForSignoff: false,
        },
        {
          id: 'developer-b',
          name: 'Developer B',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: true,
          requiredForSignoff: false,
        },
      ],
    });
    const board = new TaskBoard(path.join(workspace, '.tiger', 'team', run.runId));
    await board.enqueue({
      roleId: 'developer-a',
      title: 'Write A',
      body: 'write A',
      createdAt: '2020-01-01T00:00:01.000Z',
    });
    await board.enqueue({
      roleId: 'developer-b',
      title: 'Write B',
      body: 'write B',
      createdAt: '2020-01-01T00:00:02.000Z',
    });

    const claimed = await (orch as any).claimNextAgentTasks('lead');
    assert.deepEqual(
      claimed.map((entry: { roleId: string }) => entry.roleId),
      ['developer-a', 'developer-b'],
    );
    assert.deepEqual(await board.counts('developer-a'), { todo: 0, inProgress: 1, done: 0 });
    assert.deepEqual(await board.counts('developer-b'), { todo: 0, inProgress: 1, done: 0 });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('per-task worktree isolation records Team worktree paths under .tiger/worktrees', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-task-worktree-root-'));
  try {
    await initGitRepo(workspace);
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      worktreePerTask: true,
    });
    const run = await orch.createTeamRun({
      workspace,
      goal: 'Isolate write work.',
      roles: [
        {
          id: 'lead',
          name: 'Lead',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: false,
          requiredForSignoff: true,
        },
        {
          id: 'developer',
          name: 'Developer',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: true,
          requiredForSignoff: false,
        },
      ],
    });
    const turn: TeamTurnRecord = {
      id: 'turn-task-worktree',
      runId: run.runId,
      roleId: 'developer',
      roleName: 'Developer',
      status: 'running',
      round: 1,
      startedAt: '2020-01-01T00:00:00.000Z',
      messageSeqs: [],
      appliedDirectiveIds: [],
    };
    const task: AgentTask = {
      id: 'TASK-0001',
      roleId: 'developer',
      title: 'Write isolated change',
      body: 'write',
      status: 'in-progress',
      createdAt: '2020-01-01T00:00:00.000Z',
    };
    const privateWorktree = orch as unknown as {
      maybeCreateTaskWorktree(turn: TeamTurnRecord, task: AgentTask): Promise<string>;
    };
    const cwd = await privateWorktree.maybeCreateTaskWorktree(turn, task);
    const expectedRoot = path.join(workspace, '.tiger', 'worktrees');
    assert.equal(path.resolve(path.dirname(cwd)), path.resolve(expectedRoot));
    assert.equal(cwd.includes(`${path.sep}.kaplan${path.sep}`), false);

    const record = orch.getState().taskWorktrees?.[0];
    assert.ok(record, 'task worktree state should be persisted');
    assert.equal(path.resolve(path.dirname(record.path)), path.resolve(expectedRoot));
    assert.equal(record.path.includes(`${path.sep}.kaplan${path.sep}`), false);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('company mode keeps one writer when write cap is raised without worktree isolation', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-company-write-cap-off-'));
  try {
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      maxConcurrentWrite: 2,
      worktreePerTask: false,
    });
    const run = await orch.createTeamRun({
      workspace,
      goal: 'Preserve shared-workspace writer cap.',
      orchestrationMode: 'company',
      roles: [
        {
          id: 'lead',
          name: 'Lead',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: false,
          requiredForSignoff: true,
        },
        {
          id: 'developer-a',
          name: 'Developer A',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: true,
          requiredForSignoff: false,
        },
        {
          id: 'developer-b',
          name: 'Developer B',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: true,
          requiredForSignoff: false,
        },
      ],
    });
    const board = new TaskBoard(path.join(workspace, '.tiger', 'team', run.runId));
    await board.enqueue({
      roleId: 'developer-a',
      title: 'Write A',
      body: 'write A',
      createdAt: '2020-01-01T00:00:01.000Z',
    });
    await board.enqueue({
      roleId: 'developer-b',
      title: 'Write B',
      body: 'write B',
      createdAt: '2020-01-01T00:00:02.000Z',
    });

    const claimed = await (orch as any).claimNextAgentTasks('lead');
    assert.deepEqual(
      claimed.map((entry: { roleId: string }) => entry.roleId),
      ['developer-a'],
    );
    assert.deepEqual(await board.counts('developer-a'), { todo: 0, inProgress: 1, done: 0 });
    assert.deepEqual(await board.counts('developer-b'), { todo: 1, inProgress: 0, done: 0 });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('company mode does not force the Lead between normal read-only worker completions', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-company-no-lead-between-'));
  try {
    const order: string[] = [];
    let leadTurns = 0;
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      completionGate: neverComplete(),
      maxConcurrentReadOnly: 1,
      maxIdleLeadTurns: 1,
      maxTurns: 10,
      runner: {
        async runRoleTurn(input) {
          order.push(input.role.id);
          if (input.role.id === 'lead') {
            leadTurns += 1;
            if (leadTurns === 1) {
              return {
                status: 'completed',
                messages: [
                  { from: 'lead', kind: 'task', to: 'analyst', body: 'Analyze behavior\nAcceptance: documented.' },
                  { from: 'lead', kind: 'task', to: 'reviewer', body: 'Review behavior\nAcceptance: approved.' },
                ],
              };
            }
            return { status: 'completed', messages: [{ from: 'lead', kind: 'chat', body: 'waiting' }] };
          }
          return {
            status: 'completed',
            messages: [{ from: input.role.id, kind: 'chat', body: `${input.role.id} done` }],
          };
        },
      },
    });
    await orch.createTeamRun({
      workspace,
      goal: 'Run read-only company workers.',
      orchestrationMode: 'company',
      roles: [
        {
          id: 'lead',
          name: 'Lead',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: false,
          requiredForSignoff: true,
        },
        {
          id: 'analyst',
          name: 'Analyst',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: false,
          requiredForSignoff: false,
        },
        {
          id: 'reviewer',
          name: 'Reviewer',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: false,
          requiredForSignoff: false,
        },
      ],
    });
    await orch.start();
    await waitForTerminal(orch);

    assert.deepEqual(order.slice(0, 3), ['lead', 'analyst', 'reviewer']);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('company mode defers all-busy same-kind tasks until an instance becomes idle', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-company-kind-'));
  try {
    const orch = new TeamOrchestrator({ executionPersistence: new MemoryExecutionPersistence() });
    const created = await orch.createTeamRun({
      workspace,
      goal: 'Fair kind queue.',
      orchestrationMode: 'company',
      roles: [
        {
          id: 'lead',
          name: 'Lead',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: false,
          requiredForSignoff: true,
        },
        {
          id: 'developer',
          name: 'Developer #1',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: true,
          requiredForSignoff: false,
        },
        {
          id: 'developer-2',
          name: 'Developer #2',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: true,
          requiredForSignoff: false,
        },
      ],
    });
    const internal = (orch as any).state as TeamRunState;
    internal.roles.find((role) => role.id === 'developer')!.status = 'running';
    internal.roles.find((role) => role.id === 'developer-2')!.status = 'running';

    await (orch as any).enqueueTaskAssignments([
      {
        id: 'm1',
        runId: created.runId,
        turnId: 't1',
        seq: 2,
        from: 'lead',
        to: 'developer',
        kind: 'task',
        body: 'Implement pooled task\nAcceptance: done.',
        createdAt: '2020-01-01T00:00:00.000Z',
      } as TeamMessage,
    ]);
    const board = new TaskBoard(path.join(workspace, '.tiger', 'team', created.runId));
    assert.equal(internal.kindQueuedTasks?.length, 1);
    assert.deepEqual(await board.counts('developer'), { todo: 0, inProgress: 0, done: 0 });
    assert.deepEqual(await board.counts('developer-2'), { todo: 0, inProgress: 0, done: 0 });

    internal.roles.find((role) => role.id === 'developer-2')!.status = 'idle';
    await (orch as any).materializeKindQueuedTasks('lead');
    assert.equal(internal.kindQueuedTasks?.length, 0);
    assert.deepEqual(await board.counts('developer'), { todo: 0, inProgress: 0, done: 0 });
    assert.deepEqual(await board.counts('developer-2'), { todo: 1, inProgress: 0, done: 0 });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('company mode completion waits for an explicit Lead project-complete decision', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-company-complete-'));
  try {
    const completeGate = completionAfterRoleMessages(0);
    const companyOrch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      completionGate: completeGate,
    });
    await companyOrch.createTeamRun({
      workspace,
      goal: 'Complete only by Lead decision.',
      orchestrationMode: 'company',
      roles: [
        {
          id: 'lead',
          name: 'Lead',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: false,
          requiredForSignoff: true,
        },
      ],
    });
    ((companyOrch as any).state as TeamRunState).status = 'running';
    const stoppedBeforeDecision = await (companyOrch as any).completeOrStopFromGate();
    assert.equal(stoppedBeforeDecision, false);
    assert.equal(companyOrch.getState().status, 'running');
    assert.match(companyOrch.getState().message ?? '', /project-complete decision/i);

    ((companyOrch as any).state as TeamRunState).projectComplete = true;
    const stoppedAfterDecision = await (companyOrch as any).completeOrStopFromGate();
    assert.equal(stoppedAfterDecision, true);
    assert.equal(companyOrch.getState().status, 'completed');

    const legacyWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-legacy-complete-'));
    try {
      const legacyOrch = new TeamOrchestrator({
        executionPersistence: new MemoryExecutionPersistence(),
        completionGate: completeGate,
      });
      await legacyOrch.createTeamRun({
        workspace: legacyWorkspace,
        goal: 'Legacy completes at gate.',
        roles: [
          {
            id: 'lead',
            name: 'Lead',
            tool: 'codex' as const,
            responsibilities: [],
            canWriteCode: false,
            requiredForSignoff: true,
          },
        ],
      });
      ((legacyOrch as any).state as TeamRunState).status = 'running';
      assert.equal(await (legacyOrch as any).completeOrStopFromGate(), true);
      assert.equal(legacyOrch.getState().status, 'completed');
    } finally {
      await fs.rm(legacyWorkspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('no Lead-assigned work idles/waits instead of round-robin turns or churning to the round cap', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-idle-'));
  try {
    const order: string[] = [];
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      // The gate never completes; only the idle guard can end the loop, so reaching a
      // waiting state (not the round cap) proves the run idles rather than busy-loops.
      completionGate: neverComplete(),
      maxIdleLeadTurns: 1,
      maxRounds: 50,
      runner: {
        async runRoleTurn(input) {
          order.push(input.role.id);
          // The Lead never assigns work and never signs off — an unproductive coordinator.
          return { status: 'completed', messages: [{ from: input.role.id, kind: 'chat', body: 'thinking…' }] };
        },
      },
    });
    await orch.createTeamRun({ workspace, goal: 'Nothing actionable.', roles: leadTeam() });
    await orch.start();
    const final = await waitForTerminal(orch);

    // The run settles into a waiting (blocked) state without ever rotating to the workers
    // and without churning to the round cap.
    assert.equal(final.status, 'blocked');
    assert.match(final.message ?? '', /waiting/i);
    assert.equal(
      order.every((roleId) => roleId === 'lead'),
      true,
    );
    assert.equal(final.turns.filter((turn) => turn.roleId === 'developer').length, 0);
    assert.equal(final.turns.filter((turn) => turn.roleId === 'tester').length, 0);
    // Idle after the goal turn (productive) plus one unproductive turn — far below maxRounds.
    assert.equal(final.turnCount, 2);
    assert.ok(final.round < 50, 'idled well before the round cap');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('a non-Lead role cannot delegate laterally; the attempt is blocked and re-routed to the Lead', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-lateral-'));
  try {
    const order: string[] = [];
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      completionGate: completeWhenSignedOff('developer'),
      maxTurns: 12,
      runner: {
        async runRoleTurn(input) {
          order.push(input.role.id);
          if (input.role.id === 'lead') {
            return {
              status: 'completed',
              messages: [
                { from: 'lead', kind: 'task', to: 'developer', body: 'Implement feature\nAcceptance: works.' },
              ],
            };
          }
          if (input.role.id === 'developer') {
            // The developer tries to delegate directly to the tester — this must NOT execute.
            return {
              status: 'completed',
              messages: [
                { from: 'developer', kind: 'task', to: 'tester', body: 'Please test my work.' },
                { from: 'developer', kind: 'signoff', body: 'developer done' },
              ],
              signoffs: [{}],
            };
          }
          return {
            status: 'completed',
            messages: [{ from: input.role.id, kind: 'signoff', body: 'tester done' }],
            signoffs: [{}],
          };
        },
      },
    });
    await orch.createTeamRun({ workspace, goal: 'Guard lateral delegation.', roles: leadTeam() });
    await orch.start();
    const final = await waitForTerminal(orch);

    assert.equal(final.status, 'completed');
    // The tester never ran from the developer's lateral assignment.
    assert.deepEqual(order, ['lead', 'developer']);
    // The attempt produced a clear system notice routing it back to the Lead.
    const notice = (await orch.listMessages()).some(
      (message) => message.from === 'system' && /only the Lead assigns work/i.test(message.body),
    );
    assert.ok(notice, 'a system notice explained the lateral delegation was not queued');
    // The tester's queue stayed empty — the lateral task was never materialized as work.
    const testerTodo = path.join(workspace, '.tiger', 'team', final.runId, 'agents', 'tester', 'todo');
    const queued = await fs.readdir(testerTodo).catch(() => [] as string[]);
    assert.equal(queued.filter((name) => name.endsWith('.json')).length, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('a Lead coordination enqueue failure is surfaced as a blocker instead of silently dropping work', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-coordination-enqueue-'));
  try {
    let enqueueAttempts = 0;
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      completionGate: neverComplete(),
      maxIdleLeadTurns: 1,
      maxTurns: 4,
      runner: {
        async runRoleTurn() {
          return { status: 'completed' };
        },
      },
    });
    const created = await orch.createTeamRun({ workspace, goal: 'Collect competitor links.', roles: leadTeam() });
    const lead = orch.getState().roles.find((role) => role.id === 'lead');
    assert.ok(lead, 'the test team has a Lead role');
    const internals = orch as unknown as {
      state: TeamRunState;
      taskBoard: { enqueue: TaskBoard['enqueue'] };
      applyCoordinationDirectives(
        turn: TeamTurnRecord,
        role: TeamRunState['roles'][number],
        directives: NonNullable<TeamRoleTurnResult['coordinationDirectives']>,
      ): Promise<number>;
    };
    const beforeChange = '2020-01-01T00:00:00.000Z';
    const verifiedAt = '2020-01-01T00:01:00.000Z';
    const signedAt = '2020-01-01T00:02:00.000Z';
    internals.state.directives = internals.state.directives.map((directive) => ({
      ...directive,
      createdAt: beforeChange,
      status: 'applied',
      acknowledgedAt: verifiedAt,
      appliedAt: verifiedAt,
    }));
    internals.state.pendingSteeringCount = 0;
    internals.state.materialChangeAt = beforeChange;
    internals.state.verifications = [
      {
        id: 'VER-1',
        roleId: 'tester',
        status: 'passed',
        command: 'npm test',
        exitCode: 0,
        summary: 'green before failed delegation',
        createdAt: verifiedAt,
        completedAt: verifiedAt,
      },
    ];
    internals.state.signoffs = [
      { id: 'SIGN-1', roleId: 'lead', roleName: 'Lead', createdAt: signedAt, stale: false },
      { id: 'SIGN-2', roleId: 'developer', roleName: 'Developer', createdAt: signedAt, stale: false },
    ];
    const before = TeamOrchestrator.computeDoneGate(internals.state);
    assert.equal(
      before.satisfied,
      true,
      `fixture must be green before the failed delegation; blockers=${JSON.stringify(before.openBlockers)}`,
    );
    const turn: TeamTurnRecord = {
      id: 'turn-coordination-enqueue-failure',
      runId: created.runId,
      roleId: 'lead',
      roleName: 'Lead',
      status: 'running',
      round: 1,
      startedAt: '2020-01-01T00:00:00.000Z',
      messageSeqs: [],
      appliedDirectiveIds: [],
    };
    internals.taskBoard.enqueue = async () => {
      enqueueAttempts += 1;
      throw new Error('simulated task-board write failure');
    };

    const applied = await internals.applyCoordinationDirectives(turn, lead, [
      {
        verb: 'assign',
        fromRoleId: 'lead',
        toRoleId: 'developer',
        title: 'Collect competitor links',
        body: 'Find open-source competitor repositories and report GitHub links.',
      },
    ]);

    assert.equal(applied, 1);
    assert.equal(enqueueAttempts, 1);
    const after = TeamOrchestrator.computeDoneGate(internals.state);
    assert.equal(after.satisfied, false, 'failed delegation should keep done-gate blocked');
    assert.equal(
      internals.state.signoffs.every((signoff) => signoff.stale),
      true,
      'failed delegation should stale existing sign-offs',
    );
    assert.ok(
      after.openBlockers.some((blocker) => blocker.code === 'signoff_missing'),
      `failed delegation should require fresh sign-offs; actual blockers=${JSON.stringify(after.openBlockers)}`,
    );
    const messages = await orch.listMessages();
    assert.ok(
      messages.some(
        (message) =>
          message.from === 'system' &&
          message.to === 'lead' &&
          message.kind === 'blocker' &&
          /could not queue assign work for developer/i.test(message.body) &&
          /task-board write failed/i.test(message.body),
      ),
      'a system blocker explains that the Lead coordination assignment was not queued',
    );
    const developerTodo = await fs
      .readdir(path.join(workspace, '.tiger', 'team', created.runId, 'agents', 'developer', 'todo'))
      .catch(() => [] as string[]);
    assert.equal(developerTodo.filter((name) => name.endsWith('.json')).length, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

// ---------------------------------------------------------------------------
// Lead prompt priority (TASK-0002): a pending user prompt (or Lead review) must take
// strict priority over claiming the next queued worker task. A queued worker task may
// NOT be claimed ahead of the Lead processing a pending prompt.
// ---------------------------------------------------------------------------

test('a pending user prompt is processed by the Lead before an already-queued worker task is claimed', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-promptpri-'));
  try {
    const order: string[] = [];
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      completionGate: completeWhenSignedOff('developer'),
      maxTurns: 12,
      runner: {
        async runRoleTurn(input) {
          order.push(input.role.id);
          if (input.role.id === 'lead') {
            // The Lead processes the pending prompt; the developer already has queued work.
            return {
              status: 'completed',
              messages: [
                {
                  from: 'lead',
                  kind: 'decision',
                  body: 'Prompt acknowledged; proceed with the queued developer task.',
                },
              ],
            };
          }
          return {
            status: 'completed',
            messages: [{ from: input.role.id, kind: 'signoff', body: `${input.role.id} done` }],
            signoffs: [{}],
          };
        },
      },
    });
    const created = await orch.createTeamRun({ workspace, goal: 'A user prompt is pending.', roles: leadTeam() });
    // A Lead-approved worker task is ALREADY queued on the board while a user prompt (the
    // goal) is still pending. The buggy ordering would claim and run the developer first;
    // the Lead must run first.
    const board = new TaskBoard(path.join(workspace, '.tiger', 'team', created.runId));
    await board.enqueue({
      roleId: 'developer',
      title: 'Pre-queued work',
      body: 'Do the already-queued work.',
      createdAt: nowForTest(),
    });
    await orch.start();
    const final = await waitForTerminal(orch);

    assert.equal(final.status, 'completed');
    // The Lead handled the pending prompt before the queued developer task was claimed.
    assert.equal(order[0], 'lead');
    assert.deepEqual(order, ['lead', 'developer']);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('after a worker completes with a user prompt pending, the Lead runs before the next queued worker task', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-boundarypri-'));
  let releaseDev!: () => void;
  const devGate = new Promise<void>((resolve) => {
    releaseDev = resolve;
  });
  const order: string[] = [];
  let leadTurns = 0;
  let devTurns = 0;
  const orch = new TeamOrchestrator({
    executionPersistence: new MemoryExecutionPersistence(),
    completionGate: completeWhenSignedOff('lead', 'developer'),
    maxTurns: 16,
    runner: {
      async runRoleTurn(input) {
        order.push(input.role.id);
        if (input.role.id === 'lead') {
          leadTurns += 1;
          if (leadTurns === 1) {
            // Queue TWO developer tasks up front, so a second worker task is waiting when
            // the first completes — yet the Lead must still run next once a prompt is pending.
            return {
              status: 'completed',
              messages: [
                { from: 'lead', kind: 'task', to: 'developer', body: 'Dev task one\nAcceptance: ok.' },
                { from: 'lead', kind: 'task', to: 'developer', body: 'Dev task two\nAcceptance: ok.' },
              ],
            };
          }
          return {
            status: 'completed',
            messages: [{ from: 'lead', kind: 'signoff', body: 'lead done' }],
            signoffs: [{}],
          };
        }
        // developer: hold the first task in progress until the test injects a user prompt.
        devTurns += 1;
        if (devTurns === 1) await devGate;
        return {
          status: 'completed',
          messages: [{ from: 'developer', kind: 'signoff', body: 'dev done' }],
          signoffs: [{}],
        };
      },
    },
  });
  try {
    await orch.createTeamRun({ workspace, goal: 'Boundary priority.', roles: leadTeam() });
    await orch.start();
    // Wait until the Lead has assigned both tasks and the first developer task is in progress.
    await waitFor(() => order.length >= 2 && order[1] === 'developer', 'first developer task in progress');
    // A user prompt arrives while the first developer task is still in progress; a second
    // developer task is already queued behind it.
    await orch.steer('A new instruction for the Lead.');
    releaseDev();
    const final = await waitForTerminal(orch);

    assert.equal(final.status, 'completed');
    // After the developer completes, the next turn is the Lead (to process the pending
    // prompt), NOT the second queued developer task.
    assert.deepEqual(order.slice(0, 3), ['lead', 'developer', 'lead']);
  } finally {
    releaseDev();
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

// ---------------------------------------------------------------------------
// Steer-while-waiting (TASK-0003): a new Lead prompt submitted while the run has idled to
// a resumable waiting state must resume the loop so the Lead processes it — no manual resume.
// ---------------------------------------------------------------------------

test('steering a run that has idled to a waiting state resumes the loop so the Lead processes the prompt', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-steerwake-'));
  try {
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      maxIdleLeadTurns: 1,
      // Complete only once the Lead signs off, and the Lead only signs off after it has seen
      // the user prompt — so completion proves the resumed loop actually processed the prompt.
      completionGate: {
        evaluate(state) {
          return state.signoffs.some((s) => s.roleId === 'lead' && !s.stale)
            ? { complete: true, reasons: [] }
            : { complete: false, reasons: ['Awaiting lead sign-off.'] };
        },
      },
      runner: {
        async runRoleTurn(input) {
          if (input.role.id !== 'lead') return { status: 'completed' };
          const sawPrompt = input.appliedSteering.some((directive) => directive.body.includes('Please finish'));
          if (sawPrompt) {
            return { status: 'completed', messages: [{ from: 'lead', kind: 'signoff', body: 'done' }], signoffs: [{}] };
          }
          // Nothing actionable yet → unproductive Lead turn, so the run idles to a waiting state.
          return { status: 'completed', messages: [{ from: 'lead', kind: 'chat', body: 'nothing to do yet' }] };
        },
      },
    });
    await orch.createTeamRun({ workspace, goal: 'Initial goal.', roles: leadTeam() });
    await orch.start();
    const idled = await waitForTerminal(orch);
    assert.equal(idled.status, 'blocked');
    assert.match(idled.message ?? '', /waiting/i);

    // Submitting a new Lead prompt while waiting must resume the run with no manual resume.
    await orch.steer('Please finish the work.');
    const final = await waitForTerminal(orch);

    assert.equal(final.status, 'completed');
    assert.ok(
      final.signoffs.some((s) => s.roleId === 'lead' && !s.stale),
      'the resumed Lead processed the prompt and signed off',
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

// ---------------------------------------------------------------------------
// Stop is a resumable halt (TASK-0002): Stop halts the run but keeps the persistent role
// sessions ALIVE so the user can Resume into the same context; only Close kills them.
// ---------------------------------------------------------------------------

test('Stop halts a run without disposing sessions, Resume re-enters it, and Close kills the retained sessions', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-stop-resume-'));
  try {
    let runCount = 0;
    const disposeCalls: { kill: boolean }[] = [];
    const runner: TeamTurnRunner = {
      async runRoleTurn(input) {
        runCount += 1;
        // Block until Stop/Close aborts the turn, so the run sits in a controllable running
        // state instead of completing on its own.
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }));
        return { status: 'stopped', reason: 'aborted' };
      },
      async disposeRun(_runId, opts) {
        disposeCalls.push({ kill: opts.kill });
      },
    };

    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      completionGate: neverComplete(),
      runner,
    });
    await orch.createTeamRun({ workspace, goal: 'Stop must be a resumable halt.', roles: roles.slice(0, 1) });
    await orch.start();
    await waitFor(() => runCount >= 1, 'the first turn to start');
    assert.equal(orch.getState().status, 'running');

    // Stop: the run halts but its sessions are retained — no dispose call.
    await orch.stop();
    assert.equal(orch.getState().status, 'stopped');
    assert.deepEqual(disposeCalls, [], 'Stop must not dispose the retained role sessions');

    // Resume: a stopped run re-enters running and the loop runs another turn, proving the
    // retained context is re-used rather than rejected as a terminal run.
    await orch.resume();
    assert.equal(orch.getState().status, 'running');
    await waitFor(() => runCount >= 2, 'the resumed run to execute another turn');
    assert.deepEqual(disposeCalls, [], 'Resume must not dispose the retained role sessions');

    // Close after a stopped/resumed run kills the retained sessions.
    await orch.close();
    assert.deepEqual(disposeCalls, [{ kill: true }], 'Close must dispose the role sessions with kill');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

// ---------------------------------------------------------------------------
// Epic-4: task directives are applied (item 1), the done-gate exposes open blockers
// (item 2), structured verifications are recorded (item 9), and single-role + mid-run
// role management work (item 8).
// ---------------------------------------------------------------------------

test('a complete TaskDirective files the in-flight board task done and a needs_work directive requeues it', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-directives-'));
  try {
    let devTurns = 0;
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      maxTurns: 16,
      completionGate: completeWhenSignedOff('developer'),
      runner: {
        async runRoleTurn(input) {
          if (input.role.id === 'lead') {
            return {
              status: 'completed',
              messages: [{ from: 'lead', kind: 'task', to: 'developer', body: 'Implement X\nAcceptance: works.' }],
            };
          }
          // developer: first claim runs the task and explicitly completes it via a directive,
          // then signs off so the run finishes.
          devTurns += 1;
          return {
            status: 'completed',
            messages: [{ from: 'developer', kind: 'signoff', body: 'done' }],
            signoffs: [{}],
            taskDirectives: input.assignedTask
              ? [{ taskId: input.assignedTask.id, action: 'complete', summary: 'implemented' }]
              : undefined,
          };
        },
      },
    });
    const created = await orch.createTeamRun({ workspace, goal: 'Apply task directives.', roles: leadTeam() });
    await orch.start();
    const final = await waitForTerminal(orch);

    assert.equal(final.status, 'completed');
    assert.ok(devTurns >= 1);
    // The developer's task ended in done/ via the explicit complete directive.
    const doneDir = path.join(workspace, '.tiger', 'team', created.runId, 'agents', 'developer', 'done');
    const done = await fs.readdir(doneDir).catch(() => [] as string[]);
    assert.ok(
      done.some((n) => /TASK-\d+\.json/.test(n)),
      'the task was filed done by the directive',
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('the snapshot done-gate exposes the open blockers keeping a run from completing', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-blockers-'));
  try {
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      completionGate: neverComplete(),
      runner: {
        async runRoleTurn() {
          return { status: 'completed' };
        },
      },
    });
    // Created but not started: the goal is a pending steering directive and no required role
    // has signed off → the done-gate must report not-satisfied with explicit blockers.
    await orch.createTeamRun({ workspace, goal: 'Show the blockers.', roles: leadTeam() });
    const gate = TeamOrchestrator.computeDoneGate(orch.getState());
    assert.equal(gate.satisfied, false);
    assert.ok(gate.openBlockers.length > 0, 'open blockers are listed');
    assert.ok(
      gate.openBlockers.some((b) => b.code === 'steering_pending'),
      'the pending goal prompt is a blocker',
    );
    assert.ok(
      gate.openBlockers.some((b) => b.code === 'verification_missing'),
      'no verification yet is a blocker',
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('a structured VerificationDirective is recorded with its command/exitCode and supersedes prose inference', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-structverify-'));
  try {
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      completionGate: completeWhenSignedOff('developer'),
      maxTurns: 6,
      runner: {
        async runRoleTurn(input) {
          if (input.role.id === 'lead') {
            return {
              status: 'completed',
              messages: [
                {
                  from: 'lead',
                  kind: 'task',
                  to: 'developer',
                  body: 'Run verification.\nAcceptance: report command evidence.',
                },
              ],
            };
          }
          if (input.role.id === 'developer') {
            return {
              status: 'completed',
              // A verification chat message that READS like a failure ("error"), but the
              // structured directive is the source of truth: passed, exit 0.
              messages: [
                { from: 'developer', kind: 'verification', body: 'ran the suite; no error remained' },
                { from: 'developer', kind: 'signoff', body: 'done' },
              ],
              verifications: [{ command: 'npm test', exitCode: 0, outcome: 'passed', summary: 'all green' }],
              signoffs: [{}],
            };
          }
          return { status: 'completed' };
        },
      },
    });
    await orch.createTeamRun({ workspace, goal: 'Record structured verification.', roles: leadTeam() });
    await orch.start();
    const final = await waitForTerminal(orch);

    assert.equal(final.status, 'completed');
    // Exactly one verification (structured), not a duplicate from the prose-inferred fallback.
    assert.equal(final.verifications.length, 1);
    assert.equal(final.verifications[0]?.status, 'passed');
    assert.equal(final.verifications[0]?.command, 'npm test');
    assert.equal(final.verifications[0]?.exitCode, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('Lead-originated verification is ignored for completion-gate evidence', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-leadverify-'));
  try {
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      maxIdleLeadTurns: 1,
      maxTurns: 4,
      completionGate: {
        evaluate(state) {
          return state.verifications.length > 0
            ? { complete: true, reasons: [] }
            : { complete: false, reasons: ['No accepted worker verification has been recorded.'] };
        },
      },
      runner: {
        async runRoleTurn() {
          return {
            status: 'completed',
            messages: [{ from: 'lead', kind: 'verification', body: 'Lead says npm test passed.' }],
            verifications: [{ command: 'npm test', exitCode: 0, outcome: 'passed', summary: 'Lead-reported green' }],
          };
        },
      },
    });
    await orch.createTeamRun({
      workspace,
      goal: 'Lead must not verify directly.',
      roles: [
        {
          id: 'lead',
          name: 'Lead',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: false,
          requiredForSignoff: true,
        },
      ],
    });
    await orch.start();
    const final = await waitForTerminal(orch);

    assert.equal(final.status, 'blocked');
    assert.equal(final.verifications.length, 0);
    assert.ok(
      (await orch.listMessages()).some((message) => message.kind === 'verification' && message.from === 'lead'),
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('a timed-out turn preserves transcript messages but cannot apply authority-bearing directives', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-timeout-authority-'));
  try {
    let developerTurns = 0;
    let claimedTaskId = '';
    const messages: TeamMessage[] = [];
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      completionGate: neverComplete(),
      maxTurns: 6,
      maxConsecutiveFailures: 1,
      maxConsecutiveTaskFailures: 2,
      runner: {
        async runRoleTurn(input) {
          if (input.role.id === 'lead') {
            return {
              status: 'completed',
              messages: [
                { from: 'lead', kind: 'task', to: 'developer', body: 'Implement timeout task\nAcceptance: done.' },
              ],
            };
          }

          developerTurns += 1;
          claimedTaskId = input.assignedTask?.id ?? '';
          return {
            status: 'failed',
            reason: 'agent timed out before signaling completion',
            messages: [
              { from: 'developer', kind: 'chat', body: 'Partial transcript before timeout.' },
              { from: 'developer', kind: 'verification', body: 'npm test passed before timeout.' },
            ],
            signoffs: [{}],
            taskDirectives: input.assignedTask
              ? [{ taskId: input.assignedTask.id, action: 'complete', summary: 'claimed done before timeout' }]
              : undefined,
            verifications: [
              { command: 'npm test', exitCode: 0, outcome: 'passed', summary: 'claimed green before timeout' },
            ],
            coordinationDirectives: [
              { verb: 'sendMessage', fromRoleId: 'developer', toRoleId: 'lead', body: 'This should not be delivered.' },
            ],
          };
        },
      },
    });
    orch.on('message', (message) => messages.push(message as TeamMessage));
    const created = await orch.createTeamRun({ workspace, goal: 'Reject timeout authority.', roles: leadTeam() });
    await orch.start();
    const final = await waitForTerminal(orch, 8000);
    await waitFor(() => (orch.getState().activeClaimedTaskIds?.length ?? 0) === 0, 'claimed task cleanup', 8000);

    assert.equal(final.status, 'failed');
    assert.equal(developerTurns, 1, 'the developer timed out once');
    assert.ok(claimedTaskId, 'the developer had an in-flight board task');
    const transcript = await orch.listMessages();
    assert.ok(
      transcript.some((message) => message.body === 'Partial transcript before timeout.'),
      'partial chat message was preserved',
    );
    assert.ok(
      transcript.some((message) => message.body === 'npm test passed before timeout.'),
      'partial verification message was preserved',
    );

    const state = orch.getState();
    assert.equal(state.signoffs.length, 0, 'timed-out SignOffDirective must not record a sign-off');
    assert.equal(
      state.verifications.length,
      0,
      'timed-out verification directives/messages must not record passed verification',
    );
    assert.deepEqual(state.inboxes?.lead ?? [], [], 'timed-out coordination directives must not populate inboxes');

    const board = new TaskBoard(path.join(workspace, '.tiger', 'team', created.runId));
    const task = await board.findTask('developer', claimedTaskId);
    assert.equal(task?.status, 'todo', 'the timed-out complete TaskDirective must not file the task done');
    assert.ok(
      messages.some((message) => /timed out/i.test(message.body)),
      'the failure was still reported to the transcript',
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('addRole/removeRole/reconfigureRole mutate the live run and a paused role is skipped by claiming', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-rolemgmt-'));
  try {
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      completionGate: neverComplete(),
      runner: {
        async runRoleTurn() {
          return { status: 'completed' };
        },
      },
    });
    await orch.createTeamRun({ workspace, goal: 'Manage roles.', roles: leadTeam() });

    // Add a role.
    await orch.addRole({
      id: 'designer',
      name: 'Designer',
      tool: 'codex',
      responsibilities: [],
      canWriteCode: false,
      requiredForSignoff: false,
    });
    assert.ok(orch.getState().roles.some((r) => r.id === 'designer'));

    // Reconfigure it.
    await orch.reconfigureRole('designer', { canWriteCode: true, model: 'gpt-5' });
    const designer = orch.getState().roles.find((r) => r.id === 'designer');
    assert.equal(designer?.canWriteCode, true);
    assert.equal(designer?.model, 'gpt-5');
    const secondLeadErr = await orch
      .addRole({
        id: 'lead-2',
        name: 'Tech Lead',
        tool: 'codex',
        responsibilities: [],
        canWriteCode: false,
        requiredForSignoff: true,
      })
      .then(
        () => null,
        (e: unknown) => e as { status?: number },
      );
    assert.equal(secondLeadErr?.status, 409);
    const morphLeadErr = await orch.reconfigureRole('designer', { name: 'Team Lead' }).then(
      () => null,
      (e: unknown) => e as { status?: number },
    );
    assert.equal(morphLeadErr?.status, 409);
    assert.equal(orch.getState().roles.find((r) => r.id === 'designer')?.name, 'Designer');

    // Pause it (single-role) — status flips to paused.
    await orch.pauseRole('designer');
    assert.equal(orch.getState().roles.find((r) => r.id === 'designer')?.status, 'paused');

    // Remove it.
    await orch.removeRole('designer');
    assert.equal(
      orch.getState().roles.some((r) => r.id === 'designer'),
      false,
    );

    // The Lead cannot be removed.
    const err = await orch.removeRole('lead').then(
      () => null,
      (e: unknown) => e as { status?: number },
    );
    assert.equal(err?.status, 409);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

test('listRuns and exportRun surface a persisted run read-only', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-history-'));
  try {
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      completionGate: neverComplete(),
      runner: {
        async runRoleTurn() {
          return { status: 'completed' };
        },
      },
    });
    const created = await orch.createTeamRun({ workspace, goal: 'History and export.', roles: leadTeam() });

    const runs = await orch.listRuns(workspace);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.runId, created.runId);
    assert.equal(runs[0]?.name, 'History and export.');

    const json = await orch.exportRun(workspace, created.runId, 'json');
    assert.equal(json.format, 'json');
    const parsed = JSON.parse(json.content) as { goal: string; doneGate: { openBlockers: unknown[] } };
    assert.equal(parsed.goal, 'History and export.');
    assert.ok(Array.isArray(parsed.doneGate.openBlockers));

    const md = await orch.exportRun(workspace, created.runId, 'markdown');
    assert.equal(md.format, 'markdown');
    assert.match(md.content, /# AI Team Run/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

// --- Finding #7: ambiguous verification prose is inconclusive, never `passed` ---

test('an ambiguous prose verification is recorded inconclusive (skipped) and keeps the done-gate open', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-infer-'));
  try {
    let assigned = false;
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      maxTurns: 6,
      maxIdleLeadTurns: 1,
      runner: {
        async runRoleTurn(input) {
          if (input.role.id === 'lead' && !assigned) {
            assigned = true;
            return {
              status: 'completed',
              messages: [
                {
                  from: 'lead',
                  kind: 'task',
                  to: 'developer',
                  body: 'Verify ambiguously.\nAcceptance: report evidence.',
                },
              ],
            };
          }
          if (input.role.id === 'developer') {
            // Prose with NO clear pass/fail signal — must NOT be inferred as passed.
            return {
              status: 'completed',
              messages: [
                { from: 'developer', kind: 'verification', body: 'I looked at the code and ran some things.' },
                { from: 'developer', kind: 'signoff', body: 'done' },
              ],
              signoffs: [{}],
            };
          }
          return { status: 'completed' };
        },
      },
    });
    await orch.createTeamRun({
      workspace,
      goal: 'Infer ambiguous verification.',
      roles: [
        {
          id: 'lead',
          name: 'Lead',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: false,
          requiredForSignoff: false,
        },
        {
          id: 'developer',
          name: 'Developer',
          tool: 'codex' as const,
          responsibilities: [],
          canWriteCode: true,
          requiredForSignoff: true,
        },
      ],
    });
    await orch.start();
    const final = await waitForTerminal(orch);

    // The ambiguous report was recorded as inconclusive (`skipped`), not `passed`.
    const inferred = final.verifications.find((v) => v.summary?.startsWith('I looked at the code'));
    assert.ok(inferred, 'the prose verification was recorded');
    assert.equal(inferred?.status, 'skipped', 'ambiguous prose must be inconclusive, never passed');
    // And the done-gate is NOT satisfied by an inconclusive verification.
    assert.notEqual(final.status, 'completed');
    const gate = TeamOrchestrator.computeDoneGate(final);
    assert.ok(
      gate.openBlockers.some((b) => b.code === 'verification_failed'),
      'the inconclusive verification blocks the gate',
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

// --- Finding #3: inbox messages survive a failed turn (re-delivered next time) ---

test('a sendMessage inbox entry is preserved when the recipient turn fails, then delivered on a later success', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-inbox-'));
  try {
    let devTurns = 0;
    let leadTurns = 0;
    const inboxSeen: number[] = [];
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      maxTurns: 24,
      maxConsecutiveFailures: 99, // never give up on a single failure during this test
      completionGate: completeWhenSignedOff('developer'),
      runner: {
        async runRoleTurn(input) {
          if (input.role.id === 'lead') {
            leadTurns += 1;
            // The Lead assigns work to the developer AND sends it ONE inbox note (only on its
            // first turn, so later Lead turns do not enqueue additional notes and the count
            // stays a clean measure of the single preserved note).
            return {
              status: 'completed',
              messages: [{ from: 'lead', kind: 'task', to: 'developer', body: 'Build the feature\nAcceptance: done.' }],
              coordinationDirectives:
                leadTurns === 1
                  ? [
                      {
                        verb: 'sendMessage',
                        fromRoleId: 'lead',
                        toRoleId: 'developer',
                        title: 'Heads up',
                        body: 'Watch the edge case.',
                      },
                    ]
                  : undefined,
            };
          }
          // developer: record how many inbox items it saw this turn. The FIRST claimed turn
          // fails (inbox must be preserved); the next succeeds and signs off.
          devTurns += 1;
          inboxSeen.push(input.inbox?.length ?? 0);
          if (devTurns === 1) return { status: 'failed', reason: 'transient failure' };
          return {
            status: 'completed',
            messages: [{ from: 'developer', kind: 'signoff', body: 'done' }],
            signoffs: [{}],
          };
        },
      },
    });
    await orch.createTeamRun({ workspace, goal: 'Preserve inbox on failure.', roles: leadTeam() });
    await orch.start();
    const final = await waitForTerminal(orch, 8000);

    assert.equal(final.status, 'completed');
    assert.ok(devTurns >= 2, 'the developer ran at least twice (a failed then a successful turn)');
    // The inbox note was surfaced on the failed turn AND survived to be re-surfaced on the retry —
    // it was NOT silently dropped by the failed turn.
    assert.equal(inboxSeen[0], 1, 'the failed turn saw the inbox note');
    assert.equal(inboxSeen[1], 1, 'the inbox note was re-delivered after the failure');
    // Once a turn completed, the inbox is finally drained.
    assert.deepEqual(final.inboxes?.developer ?? [], []);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

// --- Finding #2: a completed task title can be re-assigned for rework ------------

test('the Lead can re-assign a completed task title for rework (not silently deduped)', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-rework-'));
  try {
    const created = await new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
    }).createTeamRun({ workspace, goal: 'unused', roles: leadTeam() });
    const runDir = path.join(workspace, '.tiger', 'team', created.runId);
    const board = new TaskBoard(runDir);
    // First assignment of "Fix the bug" → claimed → completed.
    await board.enqueue({
      roleId: 'developer',
      title: 'Fix the bug',
      body: 'first pass',
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    const claimed = await board.claimNext('developer', '2020-01-01T00:01:00.000Z');
    await board.complete(claimed!, '2020-01-01T00:02:00.000Z');
    assert.deepEqual(await board.counts('developer'), { todo: 0, inProgress: 0, done: 1 });

    // A rework re-assignment of the SAME title must NOT be deduped against the done task — it
    // must enqueue a fresh todo (the regression: openTitles excludes done, so this is allowed).
    const openTitles = await board.openTitles('developer');
    assert.equal(openTitles.has('Fix the bug'), false, 'no OPEN task with that title remains');
    await board.enqueue({
      roleId: 'developer',
      title: 'Fix the bug',
      body: 'rework pass',
      createdAt: '2020-01-01T00:03:00.000Z',
    });
    assert.deepEqual(await board.counts('developer'), { todo: 1, inProgress: 0, done: 1 });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});

// --- Finding #6: board-pending blocker excludes the open handoff (no double count) ---

test('computeDoneGate does not double-count an open handoff in board_pending and handoff_pending', () => {
  const base = TeamOrchestrator.computeDoneGate({
    runId: 'r1',
    workspace: '/x',
    tigerRoot: '/x/.tiger',
    status: 'running',
    goal: 'g',
    roles: [
      {
        id: 'lead',
        name: 'Lead',
        tool: 'codex',
        responsibilities: [],
        canWriteCode: false,
        requiredForSignoff: true,
        status: 'idle',
        taskCounts: { todo: 0, inProgress: 0, done: 0 },
      },
    ],
    round: 0,
    turnCount: 0,
    currentTurn: null,
    turns: [],
    directives: [],
    signoffs: [],
    verifications: [],
    tasks: null,
    findings: null,
    messageCount: 0,
    pendingSteeringCount: 0,
    materialChangeAt: '2020-01-01T00:00:00.000Z',
    createdAt: '2020-01-01T00:00:00.000Z',
  } as unknown as TeamRunState);
  // No handoff, no board work → neither blocker present.
  assert.equal(
    base.openBlockers.some((b) => b.code === 'board_pending'),
    false,
  );
  assert.equal(
    base.openBlockers.some((b) => b.code === 'handoff_pending'),
    false,
  );

  // Now: the target role has ONE in-progress task that IS the open handoff. It must surface as a
  // handoff_pending blocker but NOT also as a board_pending blocker (the count nets to zero).
  const withHandoff = TeamOrchestrator.computeDoneGate({
    runId: 'r1',
    workspace: '/x',
    tigerRoot: '/x/.tiger',
    status: 'running',
    goal: 'g',
    roles: [
      {
        id: 'lead',
        name: 'Lead',
        tool: 'codex',
        responsibilities: [],
        canWriteCode: false,
        requiredForSignoff: true,
        status: 'idle',
        taskCounts: { todo: 0, inProgress: 0, done: 0 },
      },
      {
        id: 'dev',
        name: 'Dev',
        tool: 'codex',
        responsibilities: [],
        canWriteCode: true,
        requiredForSignoff: false,
        status: 'idle',
        taskCounts: { todo: 0, inProgress: 1, done: 0 },
      },
    ],
    handoffs: [
      { id: 'h1', taskId: 'TASK-0001', fromRoleId: 'lead', toRoleId: 'dev', createdAt: '2020-01-01T00:00:00.000Z' },
    ],
    round: 0,
    turnCount: 0,
    currentTurn: null,
    turns: [],
    directives: [],
    signoffs: [],
    verifications: [],
    tasks: null,
    findings: null,
    messageCount: 0,
    pendingSteeringCount: 0,
    materialChangeAt: '2020-01-01T00:00:00.000Z',
    createdAt: '2020-01-01T00:00:00.000Z',
  } as unknown as TeamRunState);
  assert.ok(
    withHandoff.openBlockers.some((b) => b.code === 'handoff_pending'),
    'the open handoff is surfaced',
  );
  assert.equal(
    withHandoff.openBlockers.some((b) => b.code === 'board_pending'),
    false,
    'the handoff task is not also board_pending',
  );
});

test('resume rejects a genuinely ended run but a stopped run is resumable', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-resume-guard-'));
  try {
    const orch = new TeamOrchestrator({
      executionPersistence: new MemoryExecutionPersistence(),
      // Completes after a single role message so we reach a genuinely ended ('completed') run.
      completionGate: completionAfterRoleMessages(1),
      scheduler: roundRobinScheduler(),
      runner: {
        async runRoleTurn(input) {
          return { status: 'completed', messages: [{ from: input.role.id, kind: 'chat', body: 'done' }] };
        },
      },
    });
    await orch.createTeamRun({ workspace, goal: 'Drive to completion.', roles: roles.slice(0, 1) });
    await orch.start();
    const final = await waitForTerminal(orch);
    assert.equal(final.status, 'completed');

    const err = await orch.resume().then(
      () => null,
      (e: unknown) => e as { status?: number; message?: string },
    );
    assert.equal(err?.status, 409);
    assert.match(err?.message ?? '', /cannot resume a completed team run/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
  }
});
