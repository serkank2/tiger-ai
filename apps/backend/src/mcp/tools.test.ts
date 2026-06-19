import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppCtx } from '../context.js';
import { buildTools } from './tools.js';

// A minimal stub ctx: only the services the tools actually touch are implemented,
// the rest are cast away. No DB, no transport — we call tool.run() directly to
// assert the tool list and a representative tool's output shape.
function makeStubCtx(over: Partial<Record<string, unknown>> = {}): AppCtx {
  const queueJob = {
    id: 'job-1',
    position: 1,
    status: 'queued',
    priority: 0,
    provider: 'claude',
    workspacePath: '/ws/job-1',
    projectName: 'Demo',
    prompt: 'do the thing',
    attempts: 0,
    maxAttempts: 1,
    currentStep: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const stub = {
    queueService: {
      getState: async () => ({ jobs: [queueJob], rules: [], events: [], updatedAt: 'now' }),
      getJob: async (id: string) => (id === 'job-1' ? queueJob : null),
      listSteps: async () => [{ stepKey: 'plan', status: 'pending', attempts: 0, error: null, position: 1 }],
      enqueue: async (input: { prompt: string; projectName?: string }) => ({
        id: 'job-new',
        position: 2,
        status: 'queued',
        provider: 'claude',
        projectName: input.projectName ?? 'Queue',
      }),
    },
    orchestrator: {
      getState: () => ({ workspace: '/ws', initialized: true, busy: false, currentStage: null }),
    },
    teamOrchestrator: {
      tryGetState: () => null,
      listMessages: async () => [],
      steer: async (body: string) => ({ id: 'msg-1', body, createdAt: 'now' }),
    },
    ...over,
  };
  return stub as unknown as AppCtx;
}

test('buildTools exposes the expected board tool set', () => {
  const names = buildTools().map((t) => t.name).sort();
  assert.deepEqual(names, [
    'enqueue_prompt',
    'get_queue_job',
    'get_team_run',
    'get_tiger_state',
    'list_queue_jobs',
    'list_team_messages',
    'post_team_steering',
  ]);
});

test('every tool declares a name, title, description, and readOnly flag', () => {
  for (const t of buildTools()) {
    assert.ok(t.name, 'name');
    assert.ok(t.title, `title for ${t.name}`);
    assert.ok(t.description, `description for ${t.name}`);
    assert.equal(typeof t.readOnly, 'boolean', `readOnly for ${t.name}`);
    assert.equal(typeof t.inputShape, 'object', `inputShape for ${t.name}`);
  }
});

test('write tools are not marked read-only; read tools are', () => {
  const byName = new Map(buildTools().map((t) => [t.name, t]));
  assert.equal(byName.get('list_queue_jobs')!.readOnly, true);
  assert.equal(byName.get('get_tiger_state')!.readOnly, true);
  assert.equal(byName.get('enqueue_prompt')!.readOnly, false);
  assert.equal(byName.get('post_team_steering')!.readOnly, false);
});

test('list_queue_jobs returns the expected shape from a stub ctx', async () => {
  const ctx = makeStubCtx();
  const tool = buildTools().find((t) => t.name === 'list_queue_jobs')!;
  const result = (await tool.run(ctx, {})) as { count: number; jobs: Array<{ id: string; promptPreview: string }> };
  assert.equal(result.count, 1);
  assert.equal(result.jobs[0]!.id, 'job-1');
  assert.equal(result.jobs[0]!.promptPreview, 'do the thing');
});

test('list_queue_jobs honors the status filter', async () => {
  const ctx = makeStubCtx();
  const tool = buildTools().find((t) => t.name === 'list_queue_jobs')!;
  const none = (await tool.run(ctx, { status: 'running' })) as { count: number };
  assert.equal(none.count, 0);
});

test('enqueue_prompt delegates to queueService.enqueue and returns the new id', async () => {
  const ctx = makeStubCtx();
  const tool = buildTools().find((t) => t.name === 'enqueue_prompt')!;
  const result = (await tool.run(ctx, { prompt: 'build it', projectName: 'X' })) as { id: string; projectName: string };
  assert.equal(result.id, 'job-new');
  assert.equal(result.projectName, 'X');
});

test('enqueue_prompt rejects a relative workspacePath (sanity layer, even with enforcement off)', async () => {
  const ctx = makeStubCtx();
  const tool = buildTools().find((t) => t.name === 'enqueue_prompt')!;
  const result = (await tool.run(ctx, { prompt: 'build it', workspacePath: '../../etc' })) as {
    ok?: boolean;
    error?: string;
  };
  assert.equal(result.ok, false);
  assert.equal(result.error, 'workspace_not_allowed');
});

test('enqueue_prompt passes a sane absolute workspacePath through (resolved)', async () => {
  let seen: string | undefined = 'unset';
  const ctx = makeStubCtx({
    queueService: {
      enqueue: async (input: { prompt: string; workspacePath?: string }) => {
        seen = input.workspacePath;
        return { id: 'job-new', position: 2, status: 'queued', provider: 'claude', projectName: 'Queue' };
      },
    },
  });
  const tool = buildTools().find((t) => t.name === 'enqueue_prompt')!;
  const abs = process.platform === 'win32' ? 'C:\\work\\ws' : '/work/ws';
  const result = (await tool.run(ctx, { prompt: 'build it', workspacePath: abs })) as { id?: string };
  assert.equal(result.id, 'job-new');
  assert.ok(seen && seen.length > 0 && seen !== 'unset', 'workspacePath forwarded');
});

test('enqueue_prompt leaves workspacePath unset when omitted (queue generates a safe path)', async () => {
  let seen: string | undefined = 'unset';
  const ctx = makeStubCtx({
    queueService: {
      enqueue: async (input: { prompt: string; workspacePath?: string }) => {
        seen = input.workspacePath;
        return { id: 'job-new', position: 2, status: 'queued', provider: 'claude', projectName: 'Queue' };
      },
    },
  });
  const tool = buildTools().find((t) => t.name === 'enqueue_prompt')!;
  await tool.run(ctx, { prompt: 'build it' });
  assert.equal(seen, undefined);
});

test('list_queue_jobs status arg is a closed enum (typos are rejected at the schema)', () => {
  const tool = buildTools().find((t) => t.name === 'list_queue_jobs')!;
  const statusSchema = tool.inputShape.status as unknown as { safeParse: (v: unknown) => { success: boolean } };
  assert.equal(statusSchema.safeParse('running').success, true);
  assert.equal(statusSchema.safeParse('queued').success, true);
  assert.equal(statusSchema.safeParse('runnning').success, false); // typo
  assert.equal(statusSchema.safeParse('bogus').success, false);
});

test('post_team_steering reports no_active_team_run when no run is loaded', async () => {
  const ctx = makeStubCtx();
  const tool = buildTools().find((t) => t.name === 'post_team_steering')!;
  const result = (await tool.run(ctx, { body: 'focus on tests' })) as { ok: boolean; error?: string };
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_active_team_run');
});

test('post_team_steering steers when a run is active', async () => {
  const ctx = makeStubCtx({
    teamOrchestrator: {
      tryGetState: () => ({ status: 'running' }),
      listMessages: async () => [],
      steer: async (body: string) => ({ id: 'msg-42', body, createdAt: 'now' }),
    },
  });
  const tool = buildTools().find((t) => t.name === 'post_team_steering')!;
  const result = (await tool.run(ctx, { body: 'focus on tests' })) as { ok: boolean; messageId?: string };
  assert.equal(result.ok, true);
  assert.equal(result.messageId, 'msg-42');
});

test('get_team_run returns active=false when no run loaded', async () => {
  const ctx = makeStubCtx();
  const tool = buildTools().find((t) => t.name === 'get_team_run')!;
  const result = (await tool.run(ctx, {})) as { active: boolean };
  assert.equal(result.active, false);
});
