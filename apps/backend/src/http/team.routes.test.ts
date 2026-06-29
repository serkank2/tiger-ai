import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import type { AppCtx } from '../context.js';
import type {
  CreateTeamRunInput,
  TeamOrchestrationMode,
  TeamRoleInstance,
  TeamRunState as EngineTeamRunState,
} from '../team/TeamOrchestrator.js';
import { createTeamRouter } from './team.routes.js';
import { errorHandler } from './errors.js';

interface Res {
  status: number;
  json: <T = unknown>() => T;
}

async function listen(ctx: AppCtx): Promise<{ req: (m: string, p: string, b?: unknown) => Promise<Res>; close: () => Promise<void> }> {
  const app = express();
  app.use('/api/team', express.json({ limit: '2mb' }), createTeamRouter(ctx));
  app.use(errorHandler());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    req: (method, p, body) =>
      new Promise<Res>((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const r = http.request(new URL(p, base), { method, agent: false, headers: payload ? { 'content-type': 'application/json' } : {} }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: () => (data ? JSON.parse(data) : undefined) }));
        });
        r.on('error', reject);
        if (payload) r.write(payload);
        r.end();
      }),
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function role(input: CreateTeamRunInput['roles'][number], index: number): TeamRoleInstance {
  return {
    id: input.id ?? `role-${index + 1}`,
    templateId: input.templateId,
    name: input.name ?? `Role ${index + 1}`,
    tool: input.tool ?? 'codex',
    model: input.model,
    effort: input.effort,
    permission: input.permission,
    persona: input.persona,
    responsibilities: input.responsibilities ?? [],
    canWriteCode: input.canWriteCode === true,
    requiredForSignoff: input.requiredForSignoff !== false,
    status: 'idle',
  };
}

function runState(input: CreateTeamRunInput, mode: TeamOrchestrationMode): EngineTeamRunState {
  const now = '2026-06-21T12:00:00.000Z';
  return {
    runId: 'run-1',
    workspace: input.workspace,
    tigerRoot: path.join(input.workspace, '.tiger'),
    status: 'running',
    orchestrationMode: mode,
    projectComplete: false,
    goal: input.goal,
    roles: input.roles.map(role),
    attempts: [],
    currentAttemptId: null,
    promotedAttemptId: null,
    handoffs: [],
    inboxes: {},
    taskWorktrees: [],
    activeClaimedTaskIds: [],
    kindQueuedTasks: [],
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
    leadReviewPending: false,
    consecutiveIdleLeadTurns: 0,
    materialChangeAt: now,
    createdAt: now,
    startedAt: now,
  };
}

function runInput(workspace: string): CreateTeamRunInput {
  return {
    workspace,
    goal: 'Build the feature',
    roles: [{ id: 'lead', name: 'Lead', tool: 'codex' }],
  };
}

function gitAvailable(): boolean {
  return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

async function makeGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-route-git-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(dir, 'README.md'), '# Test\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

function fakeCtx(defaultMode: TeamOrchestrationMode) {
  const createdInputs: CreateTeamRunInput[] = [];
  let current: EngineTeamRunState | null = null;
  const setCurrent = (input: CreateTeamRunInput, mode: TeamOrchestrationMode = defaultMode): EngineTeamRunState => {
    current = runState(input, mode);
    return current;
  };
  const ctx = {
    state: { tiger: {}, team: {} },
    orchestrator: { getState: () => ({ initialized: false, workspace: null }) },
    teamTemplates: {
      get: async () => ({
        id: 'template-1',
        roles: [
          {
            id: 'lead',
            name: 'Lead',
            agent: { tool: 'codex', model: 'gpt-5', effort: 'medium', permission: 'workspace-write' },
            persona: 'You lead the work.',
            responsibilities: ['Plan and verify'],
            canWriteCode: true,
            requiredForSignoff: true,
          },
        ],
      }),
    },
    teamOrchestrator: {
      activeWorkspace: () => current?.workspace ?? null,
      createTeamRun: async (input: CreateTeamRunInput) => {
        createdInputs.push(input);
        current = runState(input, input.orchestrationMode ?? defaultMode);
        return current;
      },
      start: async () => current,
      getState: () => {
        if (!current) throw new Error('no current run');
        return current;
      },
      tryGetState: () => current,
      listMessages: async () => [],
    },
    save: async () => {},
  } as unknown as AppCtx;
  return { ctx, createdInputs, setCurrent };
}

test('POST /api/team/runs passes selected orchestrationMode through to createTeamRun and response state', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-route-'));
  const { ctx, createdInputs } = fakeCtx('legacy');
  const srv = await listen(ctx);
  try {
    const res = await srv.req('POST', '/api/team/runs', {
      goal: 'Build the feature',
      path: workspace,
      templateId: 'template-1',
      orchestrationMode: 'company',
    });

    assert.equal(res.status, 200);
    assert.equal(createdInputs[0]?.orchestrationMode, 'company');
    assert.equal(res.json<{ state: { orchestrationMode?: string } }>().state.orchestrationMode, 'company');
  } finally {
    await srv.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('POST /api/team/runs leaves orchestrationMode undefined when the client chooses server default', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-route-'));
  const { ctx, createdInputs } = fakeCtx('company');
  const srv = await listen(ctx);
  try {
    const res = await srv.req('POST', '/api/team/runs', {
      goal: 'Build the feature',
      path: workspace,
      templateId: 'template-1',
    });

    assert.equal(res.status, 200);
    assert.equal(createdInputs[0]?.orchestrationMode, undefined);
    assert.equal(res.json<{ state: { orchestrationMode?: string } }>().state.orchestrationMode, 'company');
  } finally {
    await srv.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('GET /api/team/runs/:id/changes rejects a different active run without using the active workspace', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-route-'));
  const { ctx, setCurrent } = fakeCtx('company');
  setCurrent(runInput(workspace));
  const srv = await listen(ctx);
  try {
    const res = await srv.req('GET', '/api/team/runs/not-run-1/changes');

    assert.equal(res.status, 409);
    const body = res.json<{ error: { message: string; code: string } }>();
    assert.equal(body.error.code, 'conflict');
    assert.match(body.error.message, /not the active run/i);
  } finally {
    await srv.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('GET /api/team/runs/:id/changes rejects non-active run ids even when a last workspace is known', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-route-'));
  const { ctx } = fakeCtx('company');
  ctx.state.team = { lastWorkspace: workspace, projects: [workspace] };
  const srv = await listen(ctx);
  try {
    const res = await srv.req('GET', '/api/team/runs/historical-run/changes');

    assert.equal(res.status, 404);
    const body = res.json<{ error: { message: string; code: string } }>();
    assert.equal(body.error.code, 'not_found');
    assert.match(body.error.message, /no active team run/i);
  } finally {
    await srv.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('GET /api/team/runs/:id/changes still works for the active run', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-route-'));
  const { ctx, setCurrent } = fakeCtx('company');
  setCurrent(runInput(workspace));
  const srv = await listen(ctx);
  try {
    const res = await srv.req('GET', '/api/team/runs/run-1/changes');

    assert.equal(res.status, 200);
    const body = res.json<{ isGitRepo: boolean; note?: string }>();
    assert.equal(body.isGitRepo, false);
    assert.match(body.note ?? '', /not a git repository/i);
  } finally {
    await srv.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('Team git write routes reject non-active run ids before git-specific validation', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-team-route-'));
  const { ctx, setCurrent } = fakeCtx('company');
  setCurrent(runInput(workspace));
  const srv = await listen(ctx);
  try {
    for (const [verb, body] of [
      ['stage', undefined],
      ['commit', { message: 'wrong run commit' }],
      ['pr', { title: 'Wrong run PR' }],
    ] as const) {
      const res = await srv.req('POST', `/api/team/runs/not-run-1/git/${verb}`, body);

      assert.equal(res.status, 409);
      const payload = res.json<{ error: { message: string; code: string } }>();
      assert.equal(payload.error.code, 'conflict');
      assert.match(payload.error.message, /not the active run/i);
    }
  } finally {
    await srv.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('POST /api/team/runs/:id/git/stage rejects a different active run without staging files', async (t) => {
  if (!gitAvailable()) return t.skip('git not available');
  const workspace = await makeGitRepo();
  const { ctx, setCurrent } = fakeCtx('company');
  setCurrent(runInput(workspace));
  await fs.writeFile(path.join(workspace, 'feature.txt'), 'work\n', 'utf8');
  const srv = await listen(ctx);
  try {
    const res = await srv.req('POST', '/api/team/runs/not-run-1/git/stage');

    assert.equal(res.status, 409);
    const body = res.json<{ error: { message: string; code: string } }>();
    assert.equal(body.error.code, 'conflict');
    assert.match(body.error.message, /not the active run/i);
    assert.equal(git(workspace, ['diff', '--cached', '--name-only']), '');
  } finally {
    await srv.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('POST /api/team/runs/:id/git/stage still works for the active run', async (t) => {
  if (!gitAvailable()) return t.skip('git not available');
  const workspace = await makeGitRepo();
  const { ctx, setCurrent } = fakeCtx('company');
  setCurrent(runInput(workspace));
  await fs.writeFile(path.join(workspace, 'feature.txt'), 'work\n', 'utf8');
  const srv = await listen(ctx);
  try {
    const res = await srv.req('POST', '/api/team/runs/run-1/git/stage');

    assert.equal(res.status, 200);
    assert.match(git(workspace, ['diff', '--cached', '--name-only']), /feature\.txt/);
    const body = res.json<{ isGitRepo: boolean; files: Array<{ path: string; status: string }> }>();
    assert.equal(body.isGitRepo, true);
    assert.ok(body.files.some((file) => file.path === 'feature.txt' && file.status === 'added'));
  } finally {
    await srv.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
