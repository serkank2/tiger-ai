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
