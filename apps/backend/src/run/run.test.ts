import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { RunEngine } from './engine.js';
import { PLAN_RESULT_JSON_SCHEMA, parsePlanResult } from './plan.js';
import { selectRunnable, propagateDoom, isDrained, type RunGraph, type WorkItem } from './graph.js';
import type { AgentTurnReport, RunAgentTurnOptions } from '../agents/runner.js';

// --- pure graph scheduler ------------------------------------------------------

function item(partial: Partial<WorkItem> & Pick<WorkItem, 'id' | 'kind' | 'status'>): WorkItem {
  return {
    title: partial.id,
    description: partial.id,
    dependsOn: [],
    agentKey: partial.kind === 'plan' ? 'planner' : partial.kind === 'review' ? 'reviewer' : 'builder',
    attempts: 0,
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

test('scheduler: plan runs alone and first; builds respect the parallel cap', () => {
  const graph: RunGraph = {
    items: [
      item({ id: 'P1', kind: 'plan', status: 'pending' }),
      item({ id: 'T1', kind: 'build', status: 'pending' }),
      item({ id: 'T2', kind: 'build', status: 'pending' }),
    ],
  };
  const first = selectRunnable(graph, { maxParallelBuilds: 2 });
  assert.deepEqual(
    first.map((entry) => entry.id),
    ['P1'],
  );

  graph.items[0]!.status = 'done';
  const builds = selectRunnable(graph, { maxParallelBuilds: 1 });
  assert.deepEqual(
    builds.map((entry) => entry.id),
    ['T1'],
  );
  const parallel = selectRunnable(graph, { maxParallelBuilds: 2 });
  assert.deepEqual(
    parallel.map((entry) => entry.id),
    ['T1', 'T2'],
  );
});

test('scheduler: dependencies gate builds; review waits for quiet', () => {
  const graph: RunGraph = {
    items: [
      item({ id: 'T1', kind: 'build', status: 'running' }),
      item({ id: 'T2', kind: 'build', status: 'pending', dependsOn: ['T1'] }),
      item({ id: 'R1', kind: 'review', status: 'pending' }),
    ],
  };
  assert.deepEqual(selectRunnable(graph, { maxParallelBuilds: 2 }), []);
  graph.items[0]!.status = 'done';
  assert.deepEqual(
    selectRunnable(graph, { maxParallelBuilds: 2 }).map((entry) => entry.id),
    ['T2'],
  );
  graph.items[1]!.status = 'done';
  assert.deepEqual(
    selectRunnable(graph, { maxParallelBuilds: 2 }).map((entry) => entry.id),
    ['R1'],
  );
});

test('doom propagation cascades and drains the graph', () => {
  const graph: RunGraph = {
    items: [
      item({ id: 'T1', kind: 'build', status: 'blocked' }),
      item({ id: 'T2', kind: 'build', status: 'pending', dependsOn: ['T1'] }),
      item({ id: 'T3', kind: 'build', status: 'pending', dependsOn: ['T2'] }),
    ],
  };
  const changed = propagateDoom(graph);
  assert.deepEqual(
    changed.map((entry) => entry.id),
    ['T2', 'T3'],
  );
  assert.ok(isDrained(graph));
});

// --- plan contract ---------------------------------------------------------------

test('parsePlanResult extracts a fenced plan with dependencies', () => {
  const text =
    'Plan ready.\n```json\n' +
    JSON.stringify({
      status: 'done',
      summary: '2 tasks',
      tasks: [
        { id: 'T1', title: 'A', description: 'do A' },
        { id: 'T2', title: 'B', description: 'do B', dependsOn: ['T1'], acceptanceCriteria: ['B works'] },
      ],
    }) +
    '\n```';
  const plan = parsePlanResult(text);
  assert.equal(plan?.tasks.length, 2);
  assert.deepEqual(plan?.tasks[1]?.dependsOn, ['T1']);
});

// --- engine end-to-end with a scripted fake runner --------------------------------

interface FakeCall {
  agentKey: string;
  resumed: boolean;
  hadPreamble: boolean;
  prompt: string;
}

function fakeRunner(calls: FakeCall[]): (opts: RunAgentTurnOptions) => Promise<AgentTurnReport> {
  let turn = 0;
  return async (opts) => {
    turn += 1;
    const prompt = opts.request.prompt;
    calls.push({
      agentKey: /You are "(\w+)"/.exec(prompt)?.[1] ?? '(resumed)',
      resumed: opts.request.resumeSessionId !== undefined,
      hadPreamble: prompt.includes('# KAPLAN SESSION'),
      prompt,
    });
    const isPlan = opts.request.resultSchema === PLAN_RESULT_JSON_SCHEMA;
    const resultText = isPlan
      ? JSON.stringify({
          status: 'done',
          summary: 'planned two tasks',
          tasks: [
            { id: 'T1', title: 'Implement A', description: 'do A fully' },
            { id: 'T2', title: 'Implement B', description: 'do B fully', dependsOn: ['T1'] },
          ],
        })
      : JSON.stringify({ status: 'done', summary: `turn ${turn} ok` });
    return {
      state: 'completed',
      exitCode: 0,
      sessionId: `sess-${opts.driver.id}`,
      resultText,
      result: isPlan ? null : { status: 'done', summary: `turn ${turn} ok` },
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.02 },
      eventCount: 3,
      durationMs: 5,
      command: 'fake',
    };
  };
}

async function makeWorkspace(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-run-'));
}

test('engine: plan → builds (delta briefs, resumed sessions) → review → completed', async () => {
  const calls: FakeCall[] = [];
  const engine = new RunEngine({ turnRunner: fakeRunner(calls) });
  const workspace = await makeWorkspace();
  await engine.createRun({
    workspace,
    goal: 'Build the feature',
    config: { reviewPolicy: 'final', verifyPolicy: 'none' },
  });

  const done = new Promise<void>((resolve) => {
    engine.on('engine-event', (payload: { kind: string; state?: { status: string } }) => {
      if (payload.kind === 'state' && ['completed', 'failed', 'blocked'].includes(payload.state?.status ?? ''))
        resolve();
    });
  });
  engine.start();
  await done;

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot?.status, 'completed');
  const statuses = Object.fromEntries(snapshot!.graph.items.map((entry) => [entry.id, entry.status]));
  assert.deepEqual(statuses, { P1: 'done', T1: 'done', T2: 'done', R1: 'done' });

  // 4 turns: plan, T1, T2, review. Cost accounted for each.
  assert.equal(snapshot?.usage.turns, 4);
  assert.equal(snapshot?.usage.costUsd, 0.08);

  // Token-efficiency contract: the planner's first turn carries the preamble;
  // the builder's FIRST turn carries it once; the builder's SECOND turn (T2)
  // resumes the session and must NOT re-send it.
  const t1 = calls[1]!;
  const t2 = calls[2]!;
  assert.equal(t1.hadPreamble, true);
  assert.equal(t1.resumed, false);
  assert.equal(t2.hadPreamble, false);
  assert.equal(t2.resumed, true);
  assert.ok(t2.prompt.includes('New since your last turn'));
  assert.ok(t2.prompt.length < t1.prompt.length);

  // Review turn saw the completed-task rollup.
  const review = calls[3]!;
  assert.ok(review.prompt.includes('Completed tasks'));

  // Events were persisted with monotonically increasing seq.
  const events = await engine.listEvents(0);
  assert.ok(events.length >= 8);
  assert.ok(events.every((event, index) => index === 0 || event.seq > events[index - 1]!.seq));
});

test('engine: steering inserts a re-plan instead of a Lead chat turn', async () => {
  const calls: FakeCall[] = [];
  const engine = new RunEngine({ turnRunner: fakeRunner(calls) });
  const workspace = await makeWorkspace();
  await engine.createRun({ workspace, goal: 'Goal', config: { reviewPolicy: 'none', verifyPolicy: 'none' } });
  await engine.steer('Focus only on module X');

  const done = new Promise<void>((resolve) => {
    engine.on('engine-event', (payload: { kind: string; state?: { status: string } }) => {
      if (payload.kind === 'state' && ['completed', 'failed', 'blocked'].includes(payload.state?.status ?? ''))
        resolve();
    });
  });
  engine.start();
  await done;

  assert.equal(engine.getSnapshot()?.status, 'completed');
  // The very first turn is the (re-)plan and carries the steering verbatim.
  assert.ok(calls[0]!.prompt.includes('Focus only on module X'));
  assert.ok(calls[0]!.prompt.includes('User steering'));
  const steering = engine.getSnapshot()?.steering ?? [];
  assert.deepEqual(
    steering.map((entry) => entry.status),
    ['applied'],
  );
});

test('engine: council fans out plan candidates + synthesis and merges review lenses', async () => {
  const calls: Array<{ kind: string; provider: string; resumed: boolean }> = [];
  const engine = new RunEngine({
    turnRunner: async (opts) => {
      const prompt = opts.request.prompt;
      const isPlanSchema = opts.request.resultSchema === PLAN_RESULT_JSON_SCHEMA;
      const kind = prompt.includes('independent plan candidate')
        ? 'plan-candidate'
        : prompt.includes('SYNTHESIZER')
          ? 'synthesis'
          : prompt.includes('review lens')
            ? 'review-lens'
            : isPlanSchema
              ? 'plan'
              : 'build';
      calls.push({ kind, provider: opts.driver.id, resumed: opts.request.resumeSessionId !== undefined });
      const planJson = JSON.stringify({
        status: 'done',
        summary: `plan via ${kind}`,
        tasks: [{ id: 'T1', title: 'Do the work', description: 'do it fully' }],
      });
      const reviewJson = JSON.stringify({
        status: 'done',
        summary: `verdict via ${kind}`,
        followUpTasks: [{ title: 'Fix shared issue' }],
      });
      const resultText = isPlanSchema
        ? planJson
        : kind === 'review-lens'
          ? reviewJson
          : JSON.stringify({ status: 'done', summary: 'built' });
      return {
        state: 'completed',
        exitCode: 0,
        sessionId: `sess-${opts.driver.id}`,
        resultText,
        result: isPlanSchema ? null : (JSON.parse(resultText) as never),
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
        eventCount: 1,
        durationMs: 1,
        command: 'fake',
      };
    },
  });
  const workspace = await makeWorkspace();
  await engine.createRun({
    workspace,
    goal: 'Important goal',
    config: {
      reviewPolicy: 'final',
      verifyPolicy: 'none',
      importance: 'high',
      council: { plan: 3, review: 2, providers: ['claude', 'codex'] },
    },
  });

  const done = new Promise<void>((resolve) => {
    engine.on('engine-event', (payload: { kind: string; state?: { status: string } }) => {
      if (payload.kind === 'state' && ['completed', 'failed', 'blocked'].includes(payload.state?.status ?? ''))
        resolve();
    });
  });
  engine.start();
  await done;

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot?.status, 'completed');
  assert.equal(snapshot?.importance, 'high');

  const counts = calls.reduce<Record<string, number>>((acc, call) => {
    acc[call.kind] = (acc[call.kind] ?? 0) + 1;
    return acc;
  }, {});
  // 3 independent plan candidates, then ONE synthesis on the planner session.
  assert.equal(counts['plan-candidate'], 3);
  assert.equal(counts['synthesis'], 1);
  // 2 review lenses merged in code — no extra single-reviewer turn.
  assert.equal(counts['review-lens'], 2);
  assert.equal(counts['plan'] ?? 0, 0);

  // Candidates rotate across the configured providers.
  const candidateProviders = calls.filter((c) => c.kind === 'plan-candidate').map((c) => c.provider);
  assert.ok(candidateProviders.includes('claude') && candidateProviders.includes('codex'));

  // The two lenses proposed the same follow-up → deduped to ONE fix task.
  const fixTasks = snapshot!.graph.items.filter((item) => item.title === 'Fix shared issue');
  assert.equal(fixTasks.length, 1);
});

test('engine: an explicit council roster pins per-provider counts + models and stamps event identity', async () => {
  const seats: Array<{ kind: string; provider: string; model?: string; effort?: string }> = [];
  const engine = new RunEngine({
    turnRunner: async (opts) => {
      const prompt = opts.request.prompt;
      const isPlanSchema = opts.request.resultSchema === PLAN_RESULT_JSON_SCHEMA;
      const kind = prompt.includes('independent plan candidate')
        ? 'plan-candidate'
        : prompt.includes('SYNTHESIZER')
          ? 'synthesis'
          : prompt.includes('review lens')
            ? 'review-lens'
            : isPlanSchema
              ? 'plan'
              : 'build';
      seats.push({ kind, provider: opts.driver.id, model: opts.request.model, effort: opts.request.effort });
      // Every turn streams one persisted event (text) and one live-only line (raw).
      opts.onEvent?.({ type: 'text', at: new Date().toISOString(), text: `${kind} speaking` });
      opts.onEvent?.({ type: 'raw', at: new Date().toISOString(), text: 'raw noise' });
      const resultText = isPlanSchema
        ? JSON.stringify({
            status: 'done',
            summary: 'one task',
            tasks: [{ id: 'T1', title: 'Do it', description: 'do it fully' }],
          })
        : JSON.stringify({ status: 'done', summary: 'ok' });
      return {
        state: 'completed',
        exitCode: 0,
        sessionId: `sess-${opts.driver.id}`,
        resultText,
        result: isPlanSchema ? null : { status: 'done', summary: 'ok' },
        eventCount: 1,
        durationMs: 1,
        command: 'fake',
      };
    },
  });
  const workspace = await makeWorkspace();
  await engine.createRun({
    workspace,
    goal: 'Goal',
    config: {
      reviewPolicy: 'final',
      verifyPolicy: 'none',
      council: {
        // No explicit plan/review counts → the roster total sizes both phases.
        providers: [],
        members: [
          { provider: 'claude', model: 'opus', effort: 'xhigh', count: 2 },
          { provider: 'codex', model: 'gpt-5.5', count: 1 },
        ],
      },
    },
  });

  // The roster IS the council: 2 + 1 seats at both read-only phases.
  const snapshotBefore = engine.getSnapshot();
  assert.equal(snapshotBefore?.council.plan, 3);
  assert.equal(snapshotBefore?.council.review, 3);
  assert.deepEqual(snapshotBefore?.council.providers, ['claude', 'codex']);

  const done = new Promise<void>((resolve) => {
    engine.on('engine-event', (payload: { kind: string; state?: { status: string } }) => {
      if (payload.kind === 'state' && ['completed', 'failed', 'blocked'].includes(payload.state?.status ?? ''))
        resolve();
    });
  });
  engine.start();
  await done;
  assert.equal(engine.getSnapshot()?.status, 'completed');

  const planSeats = seats
    .filter((seat) => seat.kind === 'plan-candidate')
    .map((seat) => `${seat.provider}:${seat.model}:${seat.effort ?? '-'}`)
    .sort();
  assert.deepEqual(planSeats, ['claude:opus:xhigh', 'claude:opus:xhigh', 'codex:gpt-5.5:-']);
  const reviewSeats = seats
    .filter((seat) => seat.kind === 'review-lens')
    .map((seat) => `${seat.provider}:${seat.model}`)
    .sort();
  assert.deepEqual(reviewSeats, ['claude:opus', 'claude:opus', 'codex:gpt-5.5']);

  // Persisted agent events carry the terminal identity; raw stays live-only.
  const events = await engine.listEvents(0);
  const agentEvents = events.filter((event) => event.type === 'agent');
  assert.ok(agentEvents.length > 0);
  assert.ok(agentEvents.every((event) => typeof event.agentId === 'string' && event.provider !== undefined));
  assert.ok(agentEvents.some((event) => event.agentId === 'plan-candidate-1'));
  // Build turns stream under a per-item agentId (parallel-safe), not the shared 'builder' key.
  assert.ok(agentEvents.some((event) => event.agentId === 'T1' && event.model === undefined));
  assert.ok(agentEvents.every((event) => event.agent?.type !== 'raw'));
});

test('engine: staged planning plans in batches until remainingScope is cleared', async () => {
  let planTurns = 0;
  const engine = new RunEngine({
    turnRunner: async (opts) => {
      const isPlan = opts.request.resultSchema === PLAN_RESULT_JSON_SCHEMA;
      if (isPlan) {
        planTurns += 1;
        // First batch leaves scope behind; the second batch finishes it.
        const remainingScope = planTurns === 1 ? 'the second half of the goal' : undefined;
        return {
          state: 'completed',
          exitCode: 0,
          sessionId: 's',
          resultText: JSON.stringify({
            status: 'done',
            summary: `batch ${planTurns}`,
            tasks: [{ id: `T${planTurns}`, title: `Task ${planTurns}`, description: 'do it fully' }],
            ...(remainingScope ? { remainingScope } : {}),
          }),
          result: null,
          eventCount: 1,
          durationMs: 1,
          command: 'fake',
        };
      }
      return {
        state: 'completed',
        exitCode: 0,
        sessionId: 's',
        resultText: JSON.stringify({ status: 'done', summary: 'built' }),
        result: { status: 'done', summary: 'built' },
        eventCount: 1,
        durationMs: 1,
        command: 'fake',
      };
    },
  });
  const workspace = await makeWorkspace();
  await engine.createRun({
    workspace,
    goal: 'A big two-part goal',
    config: { reviewPolicy: 'none', verifyPolicy: 'none', planBatchSize: 1 },
  });

  const done = new Promise<void>((resolve) => {
    engine.on('engine-event', (payload: { kind: string; state?: { status: string } }) => {
      if (payload.kind === 'state' && ['completed', 'failed', 'blocked'].includes(payload.state?.status ?? ''))
        resolve();
    });
  });
  engine.start();
  await done;

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot?.status, 'completed');
  // Two plan items (batches) and two build tasks, all done.
  const kinds = snapshot!.graph.items.map((item) => `${item.kind}:${item.status}`).sort();
  assert.deepEqual(kinds, ['build:done', 'build:done', 'plan:done', 'plan:done']);
  assert.equal(planTurns, 2);
});

test('engine: per-build verification uses the QUICK set; finalize uses the FULL set', async () => {
  const ran: Array<{ ids: string[]; cwd: string }> = [];
  const fakeVerification = {
    run: async (commands: Array<{ id: string }>, opts: { cwd: string }) => {
      ran.push({ ids: commands.map((c) => c.id), cwd: opts.cwd });
      return commands.map((command) => ({
        id: command.id,
        command: command.id,
        outcome: 'passed' as const,
        exitCode: 0,
        durationMs: 1,
        outputTail: '',
        at: new Date().toISOString(),
      }));
    },
  };
  const engine = new RunEngine({
    verification: fakeVerification as never,
    turnRunner: async (opts) => {
      const isPlan = opts.request.resultSchema === PLAN_RESULT_JSON_SCHEMA;
      return {
        state: 'completed',
        exitCode: 0,
        sessionId: 's',
        resultText: isPlan
          ? JSON.stringify({
              status: 'done',
              summary: 'one task',
              tasks: [{ id: 'T1', title: 'X', description: 'do X' }],
            })
          : JSON.stringify({ status: 'done', summary: 'built' }),
        result: isPlan ? null : { status: 'done', summary: 'built' },
        eventCount: 1,
        durationMs: 1,
        command: 'fake',
      };
    },
  });
  const workspace = await makeWorkspace();
  await engine.createRun({
    workspace,
    goal: 'Goal',
    config: {
      reviewPolicy: 'none',
      verifyPolicy: 'both',
      quickVerifyCommands: [{ id: 'typecheck', command: 'x', args: [] }],
      verifyCommands: [
        { id: 'typecheck', command: 'x', args: [] },
        { id: 'test', command: 'x', args: [] },
      ],
    },
  });

  const done = new Promise<void>((resolve) => {
    engine.on('engine-event', (payload: { kind: string; state?: { status: string } }) => {
      if (payload.kind === 'state' && ['completed', 'failed', 'blocked'].includes(payload.state?.status ?? ''))
        resolve();
    });
  });
  engine.start();
  await done;
  assert.equal(engine.getSnapshot()?.status, 'completed');

  // The per-build gate ran ONLY the quick set; finalize ran the full suite.
  const perBuild = ran.find((entry) => entry.ids.length === 1 && entry.ids[0] === 'typecheck');
  const final = ran.find((entry) => entry.ids.includes('test'));
  assert.ok(perBuild, 'per-build quick check ran');
  assert.ok(final, 'finalize full check ran');
});

test('engine: review council fuzzy-dedupes findings that describe the same issue', async () => {
  let lens = 0;
  const engine = new RunEngine({
    turnRunner: async (opts) => {
      const prompt = opts.request.prompt;
      const isPlanSchema = opts.request.resultSchema === PLAN_RESULT_JSON_SCHEMA;
      if (prompt.includes('review lens')) {
        lens += 1;
        // Two lenses report the SAME defect with reordered wording (exact-string
        // dedup would keep both; fuzzy token-overlap dedup collapses them).
        const title = lens === 1 ? 'Null check missing in parseConfig' : 'parseConfig missing a null check';
        return {
          state: 'completed',
          exitCode: 0,
          sessionId: 's',
          resultText: JSON.stringify({ status: 'done', summary: `lens ${lens}`, followUpTasks: [{ title }] }),
          result: null,
          eventCount: 1,
          durationMs: 1,
          command: 'fake',
        };
      }
      return {
        state: 'completed',
        exitCode: 0,
        sessionId: 's',
        resultText: isPlanSchema
          ? JSON.stringify({ status: 'done', summary: 'one', tasks: [{ id: 'T1', title: 'X', description: 'do X' }] })
          : JSON.stringify({ status: 'done', summary: 'built' }),
        result: isPlanSchema ? null : { status: 'done', summary: 'built' },
        eventCount: 1,
        durationMs: 1,
        command: 'fake',
      };
    },
  });
  const workspace = await makeWorkspace();
  await engine.createRun({
    workspace,
    goal: 'Goal',
    config: {
      reviewPolicy: 'final',
      verifyPolicy: 'none',
      council: { plan: 1, review: 2, providers: ['claude'] },
    },
  });

  const done = new Promise<void>((resolve) => {
    engine.on('engine-event', (payload: { kind: string; state?: { status: string } }) => {
      if (payload.kind === 'state' && ['completed', 'failed', 'blocked'].includes(payload.state?.status ?? ''))
        resolve();
    });
  });
  engine.start();
  await done;

  // Both lenses flagged the same defect → exactly ONE fix task, not two.
  const fixTasks = engine.getSnapshot()!.graph.items.filter((item) => item.fixOf?.startsWith('review'));
  assert.equal(fixTasks.length, 1);
});

test('engine: interactive mode drives PTY turns and routes user input/complete by agentId', async () => {
  // A fake interactive runner whose turns stay live until engine.interactiveComplete()
  // is called — exactly the user-driven completion the real PTY runner models.
  const writes: string[] = [];
  const seen: string[] = [];
  const engine = new RunEngine({
    interactiveRunner: (opts) => {
      let resolveFn!: (r: AgentTurnReport) => void;
      const promise = new Promise<AgentTurnReport>((resolve) => (resolveFn = resolve));
      const isPlan = opts.prompt.includes('Decompose the goal');
      seen.push(/You are "([^"]+)"/.exec(opts.prompt)?.[1] ?? 'unknown');
      return {
        promise,
        write: (data: string) => writes.push(data),
        complete: () =>
          resolveFn({
            state: 'completed',
            exitCode: 0,
            resultText: isPlan
              ? JSON.stringify({ status: 'done', summary: 'p', tasks: [{ id: 'T1', title: 'X', description: 'do X' }] })
              : JSON.stringify({ status: 'done', summary: 'built interactively' }),
            result: isPlan ? null : { status: 'done', summary: 'built interactively' },
            eventCount: 1,
            durationMs: 1,
            command: 'fake-interactive',
          }),
        abort: () =>
          resolveFn({ state: 'stopped', exitCode: null, result: null, eventCount: 0, durationMs: 1, command: 'x' }),
      };
    },
  });
  const workspace = await makeWorkspace();
  await engine.createRun({
    workspace,
    goal: 'Do it live',
    config: { reviewPolicy: 'none', verifyPolicy: 'none', interactive: true },
  });
  assert.equal(engine.getSnapshot()?.interactive, true);

  const done = new Promise<void>((resolve) => {
    engine.on('engine-event', (payload: { kind: string; state?: { status: string } }) => {
      if (payload.kind === 'state' && ['completed', 'failed', 'blocked'].includes(payload.state?.status ?? ''))
        resolve();
    });
  });
  const waitLive = async (agentId: string): Promise<void> => {
    for (let i = 0; i < 200; i += 1) {
      if (engine.listInteractiveAgents().includes(agentId)) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`interactive agent "${agentId}" never went live`);
  };

  engine.start();

  // The plan turn goes live under agentId 'planner'; user input routes to it,
  // then the user completes the turn — the engine advances to the build.
  await waitLive('planner');
  const routed = engine.interactiveInput('planner', '/compact\r');
  assert.ok(routed, 'input routed to the live planner turn');
  assert.equal(engine.interactiveInput('nobody', 'x'), false, 'unknown agent → no-op');
  engine.interactiveComplete('planner');

  // The build turn goes live under its item id (parallel-safe); complete it too.
  await waitLive('T1');
  engine.interactiveComplete('T1');

  await done;
  assert.equal(engine.getSnapshot()?.status, 'completed');
  assert.ok(writes.includes('/compact\r'));
  assert.ok(seen.includes('planner') && seen.includes('T1'));
});

test('engine: skipPlanning seeds a single direct build task (no planner turn)', async () => {
  const kinds: string[] = [];
  const engine = new RunEngine({
    turnRunner: async (opts) => {
      kinds.push(opts.request.resultSchema === PLAN_RESULT_JSON_SCHEMA ? 'plan' : 'build');
      return {
        state: 'completed',
        exitCode: 0,
        sessionId: 's',
        resultText: JSON.stringify({ status: 'done', summary: 'did the whole goal' }),
        result: { status: 'done', summary: 'did the whole goal' },
        eventCount: 1,
        durationMs: 1,
        command: 'fake',
      };
    },
  });
  const workspace = await makeWorkspace();
  await engine.createRun({
    workspace,
    goal: 'Just do this one thing',
    config: { reviewPolicy: 'none', verifyPolicy: 'none', skipPlanning: true },
  });

  const done = new Promise<void>((resolve) => {
    engine.on('engine-event', (payload: { kind: string; state?: { status: string } }) => {
      if (payload.kind === 'state' && ['completed', 'failed', 'blocked'].includes(payload.state?.status ?? ''))
        resolve();
    });
  });
  engine.start();
  await done;

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot?.status, 'completed');
  // No plan turn ran; exactly one build item executed.
  assert.ok(!kinds.includes('plan'), 'no planner turn with skipPlanning');
  assert.deepEqual(
    snapshot!.graph.items.map((item) => `${item.kind}:${item.status}`),
    ['build:done'],
  );
  assert.ok(snapshot!.graph.items[0]!.description.includes('Just do this one thing'));
});

test('engine: a rate-limited failure backs off and still retries with context intact', async () => {
  let attempt = 0;
  const engine = new RunEngine({
    turnRunner: async (opts) => {
      const isPlan = opts.request.resultSchema === PLAN_RESULT_JSON_SCHEMA;
      if (isPlan) {
        return {
          state: 'completed',
          exitCode: 0,
          sessionId: 's',
          resultText: JSON.stringify({
            status: 'done',
            summary: 'one task',
            tasks: [{ id: 'T1', title: 'X', description: 'do X' }],
          }),
          result: null,
          eventCount: 1,
          durationMs: 1,
          command: 'fake',
        };
      }
      attempt += 1;
      // First build attempt hits a 429; second succeeds.
      if (attempt === 1) {
        return {
          state: 'failed',
          exitCode: 1,
          result: null,
          error: 'HTTP 429 rate_limit_exceeded: too many requests',
          eventCount: 1,
          durationMs: 1,
          command: 'fake',
        };
      }
      return {
        state: 'completed',
        exitCode: 0,
        sessionId: 's',
        resultText: JSON.stringify({ status: 'done', summary: 'ok' }),
        result: { status: 'done', summary: 'ok' },
        eventCount: 1,
        durationMs: 1,
        command: 'fake',
      };
    },
  });
  const workspace = await makeWorkspace();
  await engine.createRun({
    workspace,
    goal: 'Goal',
    config: { reviewPolicy: 'none', verifyPolicy: 'none', maxAttemptsPerItem: 2, rateLimitBackoffMs: 10 },
  });

  const done = new Promise<void>((resolve) => {
    engine.on('engine-event', (payload: { kind: string; state?: { status: string } }) => {
      if (payload.kind === 'state' && ['completed', 'failed', 'blocked'].includes(payload.state?.status ?? ''))
        resolve();
    });
  });
  engine.start();
  await done;

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot?.status, 'completed');
  assert.equal(attempt, 2, 'retried after the rate-limit backoff');
  // The backoff note was recorded.
  const events = await engine.listEvents(0);
  assert.ok(events.some((event) => event.type === 'note' && /rate.*limit/i.test(event.text ?? '')));
});

test('engine: a persistently blocked builder blocks the item and the run — honestly', async () => {
  const engine = new RunEngine({
    turnRunner: async (opts) => {
      const isPlan = opts.request.resultSchema === PLAN_RESULT_JSON_SCHEMA;
      return {
        state: 'completed',
        exitCode: 0,
        sessionId: 's',
        resultText: isPlan
          ? JSON.stringify({
              status: 'done',
              summary: 'one task',
              tasks: [{ id: 'T1', title: 'X', description: 'do X' }],
            })
          : JSON.stringify({ status: 'blocked', summary: 'cannot proceed: missing credentials' }),
        result: isPlan ? null : { status: 'blocked', summary: 'cannot proceed: missing credentials' },
        eventCount: 1,
        durationMs: 1,
        command: 'fake',
      };
    },
  });
  const workspace = await makeWorkspace();
  await engine.createRun({
    workspace,
    goal: 'Goal',
    config: { reviewPolicy: 'none', verifyPolicy: 'none', maxAttemptsPerItem: 2 },
  });

  const done = new Promise<void>((resolve) => {
    engine.on('engine-event', (payload: { kind: string; state?: { status: string } }) => {
      if (payload.kind === 'state' && ['completed', 'failed', 'blocked'].includes(payload.state?.status ?? ''))
        resolve();
    });
  });
  engine.start();
  await done;

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot?.status, 'blocked');
  const blocked = snapshot?.graph.items.find((entry) => entry.id === 'T1');
  assert.equal(blocked?.status, 'blocked');
  assert.match(blocked?.error ?? '', /missing credentials/);
  assert.equal(blocked?.attempts, 2);
});
