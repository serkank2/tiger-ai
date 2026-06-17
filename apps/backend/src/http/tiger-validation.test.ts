import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AppCtx } from '../context.js';
import { Orchestrator } from '../orchestrator/Orchestrator.js';
import { TIGER_GROUP_NAME_MAX_CHARS, TIGER_PROJECT_PROMPT_MAX_CHARS } from '../orchestrator/config.js';
import type { TigerConfig } from '../orchestrator/types.js';
import type { PersistedState } from '../store/types.js';
import { TerminalManager } from '../terminal/TerminalManager.js';
import { createGroupsRouter } from './groups.routes.js';
import { createTigerRouter } from './tiger.routes.js';

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

function state(): PersistedState {
  return {
    schemaVersion: 1,
    terminals: [],
    groups: [],
    settings: {
      theme: 'system',
      defaultCwd: process.cwd(),
      defaultShell: { kind: 'system-default' },
      commandRouting: {
        appendNewlineByDefault: true,
        startTerminalOnSend: true,
      },
    },
    tiger: {},
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function listen(app: express.Express): Promise<TestServer> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const e = err as { code?: string; status?: number; statusCode?: number };
  const explicit = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
  const status = explicit && explicit >= 400 && explicit < 600 ? explicit : 500;
  res.status(status).json({ error: { message: err instanceof Error ? err.message : String(err), code: e.code } });
}

async function requestJson(
  baseUrl: string,
  method: 'POST' | 'PUT',
  route: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: await res.json().catch(() => null),
  };
}

async function tigerFixture(): Promise<TestServer & { workspace: string; orchestrator: Orchestrator; cleanup: () => Promise<void> }> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-tiger-route-'));
  const manager = new TerminalManager();
  const orchestrator = new Orchestrator(manager);
  const ctx: AppCtx = {
    state: state(),
    manager,
    orchestrator,
    save: async () => {},
  };
  await orchestrator.initialize(workspace, 'Build a small test project.');

  const app = express();
  app.use('/api/tiger', express.json({ limit: '2mb' }), createTigerRouter(ctx));
  app.use(errorHandler);
  const server = await listen(app);
  return {
    ...server,
    workspace,
    orchestrator,
    cleanup: async () => {
      await server.close();
      await orchestrator.killAgents();
      await fs.rm(workspace, { recursive: true, force: true });
    },
  };
}

test('PUT /api/tiger/config rejects invalid timing, execution, executable, and permission mode overrides', async () => {
  const f = await tigerFixture();
  try {
    const defaults = f.orchestrator.getConfig();
    const cases: { name: string; body: Partial<TigerConfig> }[] = [
      { name: 'non-numeric timing', body: { timing: { ...defaults.timing, markerPollMs: 'fast' as never } } },
      { name: 'negative timing', body: { timing: { ...defaults.timing, readyIdleMs: -1 } } },
      { name: 'out-of-range timing', body: { timing: { ...defaults.timing, agentTimeoutMs: 999_999_999 } } },
      { name: 'invalid execution number', body: { execution: { ...defaults.execution, maxConcurrent: 0 } } },
      { name: 'unknown executable', body: { cli: { ...defaults.cli, claude: { ...defaults.cli.claude, executable: 'node' } } } },
      {
        name: 'unknown permission mode',
        body: {
          cli: {
            ...defaults.cli,
            codex: {
              ...defaults.cli.codex,
              permissionModes: { ...defaults.cli.codex.permissionModes, custom: ['--ask-for-approval', 'never'] },
            },
          },
        },
      },
    ];

    for (const c of cases) {
      const res = await requestJson(f.baseUrl, 'PUT', '/api/tiger/config', c.body);
      assert.equal(res.status, 400, c.name);
    }
  } finally {
    await f.cleanup();
  }
});

test('stage run rejects out-of-range agent counts and unknown model or effort values before starting', async () => {
  const f = await tigerFixture();
  try {
    const valid = {
      claudeAgents: 1,
      codexAgents: 1,
      claudeModel: 'sonnet',
      codexModel: 'gpt-5',
      claudeEffort: 'medium',
      codexEffort: 'medium',
      claudePermission: 'dangerous',
      codexPermission: 'yolo',
      parallel: true,
    };
    const cases = [
      { claudeAgents: 0 },
      { codexAgents: -1 },
      { claudeAgents: 9 },
      { claudeModel: 'unknown-model' },
      { codexEffort: 'turbo' },
    ];

    for (const override of cases) {
      const res = await requestJson(f.baseUrl, 'POST', '/api/tiger/stages/brainstorming/run', { ...valid, ...override });
      assert.equal(res.status, 400, JSON.stringify(override));
      assert.equal(f.orchestrator.getState().busy, false);
    }
  } finally {
    await f.cleanup();
  }
});

test('workspace initialization rejects an overlong projectPrompt before creating tiger files', async () => {
  const f = await tigerFixture();
  try {
    const nextWorkspace = path.join(f.workspace, 'next-workspace');
    await fs.mkdir(nextWorkspace);
    const res = await requestJson(f.baseUrl, 'POST', '/api/tiger/workspace', {
      path: nextWorkspace,
      projectPrompt: 'x'.repeat(TIGER_PROJECT_PROMPT_MAX_CHARS + 1),
    });

    assert.equal(res.status, 400);
    await assert.rejects(fs.stat(path.join(nextWorkspace, '.tiger')));
  } finally {
    await f.cleanup();
  }
});

test('group routes reject overlength names before mutating state', async () => {
  const persisted = state();
  persisted.groups.push({ id: 'g1', name: 'Keep me', color: '#f59e42' });
  let saves = 0;
  const ctx: AppCtx = {
    state: persisted,
    manager: {} as AppCtx['manager'],
    orchestrator: {} as AppCtx['orchestrator'],
    save: async () => {
      saves += 1;
    },
  };
  const app = express();
  app.use('/api/groups', express.json(), createGroupsRouter(ctx));
  app.use(errorHandler);
  const server = await listen(app);
  try {
    const longName = 'x'.repeat(TIGER_GROUP_NAME_MAX_CHARS + 1);
    const create = await requestJson(server.baseUrl, 'POST', '/api/groups', { name: longName });
    assert.equal(create.status, 400);
    assert.equal(persisted.groups.length, 1);

    const rename = await requestJson(server.baseUrl, 'PUT', '/api/groups/g1', { name: longName });
    assert.equal(rename.status, 400);
    assert.equal(persisted.groups[0]!.name, 'Keep me');
    assert.equal(saves, 0);
  } finally {
    await server.close();
  }
});
