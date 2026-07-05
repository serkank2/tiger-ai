import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import type { AppCtx } from '../context.js';
import type { PersistedState, TerminalDefinition, TerminalRuntimeStatus } from '../store/types.js';
import { createTerminalsRouter } from './terminals.routes.js';
import { errorHandler } from './errors.js';

interface Res {
  status: number;
  json: <T = unknown>() => T;
}

interface TestServer {
  req: (method: string, path: string, body?: unknown) => Promise<Res>;
  close: () => Promise<void>;
}

/**
 * `http.request` with `agent: false` (no keep-alive client sockets) so `--test-force-exit`
 * has no lingering socket handle to abort libuv on during teardown.
 */
async function listen(router: express.Router): Promise<TestServer> {
  const app = express();
  app.use('/api/terminals', express.json({ limit: '160kb' }), router);
  app.use(errorHandler());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    req: (method, p, body) =>
      new Promise<Res>((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const r = http.request(
          new URL(p, base),
          { method, agent: false, headers: payload ? { 'content-type': 'application/json' } : {} },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, json: () => (data ? JSON.parse(data) : undefined) }),
            );
          },
        );
        r.on('error', reject);
        if (payload) r.write(payload);
        r.end();
      }),
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function baseState(): PersistedState {
  return {
    schemaVersion: 1,
    terminals: [],
    groups: [],
    settings: {
      theme: 'system',
      defaultCwd: os.tmpdir(),
      defaultShell: { kind: 'system-default' },
      commandRouting: { appendNewlineByDefault: true, startTerminalOnSend: true },
    },
    tiger: {},
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Minimal in-memory manager double recording the lifecycle calls the routes make. */
function fakeManager() {
  const calls: string[] = [];
  return {
    calls,
    upsertDefinition: (d: TerminalDefinition) => {
      calls.push(`upsert:${d.id}`);
      return { deferred: false };
    },
    getStatus: (_id: string): TerminalRuntimeStatus | undefined => undefined,
    getBuffer: (_id: string) => '',
    remove: async (id: string) => {
      calls.push(`remove:${id}`);
    },
    start: async (id: string): Promise<TerminalRuntimeStatus> => {
      calls.push(`start:${id}`);
      return { id, state: 'running', cols: 80, rows: 30, exitCode: null };
    },
    stop: async (id: string): Promise<TerminalRuntimeStatus> => {
      calls.push(`stop:${id}`);
      return { id, state: 'stopped', cols: 80, rows: 30, exitCode: null };
    },
    restart: async (id: string): Promise<TerminalRuntimeStatus> => {
      calls.push(`restart:${id}`);
      return { id, state: 'running', cols: 80, rows: 30, exitCode: null };
    },
  };
}

function ctxWith(state: PersistedState, manager: ReturnType<typeof fakeManager>): { ctx: AppCtx; saves: () => number } {
  let saveCount = 0;
  const ctx = {
    state,
    manager: manager as unknown as AppCtx['manager'],
    save: async () => {
      saveCount += 1;
    },
  } as unknown as AppCtx;
  return { ctx, saves: () => saveCount };
}

function existingDef(id = 't1'): TerminalDefinition {
  return {
    id,
    name: 'orig',
    cwd: os.tmpdir(),
    groupId: null,
    shell: { kind: 'system-default' },
    autostart: false,
    protected: false,
    createdAt: 'x',
    updatedAt: 'x',
  };
}

test('POST /api/terminals creates a terminal, persists it, and returns 201 with live status', async () => {
  const state = baseState();
  const mgr = fakeManager();
  const { ctx, saves } = ctxWith(state, mgr);
  const srv = await listen(createTerminalsRouter(ctx));
  try {
    const res = await srv.req('POST', '/api/terminals', { name: 'My Term', cwd: os.tmpdir() });
    assert.equal(res.status, 201);
    const body = res.json<{ id: string; name: string; cwd: string }>();
    assert.equal(body.name, 'My Term');
    assert.equal(body.cwd, path.resolve(os.tmpdir()));
    assert.ok(body.id);
    assert.equal(state.terminals.length, 1);
    assert.equal(saves(), 1);
    assert.deepEqual(mgr.calls, [`upsert:${body.id}`]);
  } finally {
    await srv.close();
  }
});

test('POST /api/terminals returns a bad_request envelope when the name is missing', async () => {
  const { ctx } = ctxWith(baseState(), fakeManager());
  const srv = await listen(createTerminalsRouter(ctx));
  try {
    const res = await srv.req('POST', '/api/terminals', { cwd: os.tmpdir() });
    assert.equal(res.status, 400);
    const body = res.json<{ error: { code: string; message: string } }>();
    assert.equal(body.error.code, 'bad_request');
    assert.match(body.error.message, /name is required/);
  } finally {
    await srv.close();
  }
});

test('POST /api/terminals rejects a non-existent working directory', async () => {
  const { ctx } = ctxWith(baseState(), fakeManager());
  const srv = await listen(createTerminalsRouter(ctx));
  try {
    const res = await srv.req('POST', '/api/terminals', {
      name: 'T',
      cwd: path.join(os.tmpdir(), 'definitely-not-here-xyz-123'),
    });
    assert.equal(res.status, 400);
    assert.match(res.json<{ error: { message: string } }>().error.message, /invalid working directory/);
  } finally {
    await srv.close();
  }
});

test('GET /api/terminals/:id returns 404 with a not_found envelope for an unknown id', async () => {
  const { ctx } = ctxWith(baseState(), fakeManager());
  const srv = await listen(createTerminalsRouter(ctx));
  try {
    const res = await srv.req('GET', '/api/terminals/ghost');
    assert.equal(res.status, 404);
    assert.equal(res.json<{ error: { code: string } }>().error.code, 'not_found');
  } finally {
    await srv.close();
  }
});

test('PUT validates the whole patch before mutating: a bad shell leaves the definition untouched', async () => {
  const state = baseState();
  state.terminals.push(existingDef());
  const { ctx } = ctxWith(state, fakeManager());
  const srv = await listen(createTerminalsRouter(ctx));
  try {
    const res = await srv.req('PUT', '/api/terminals/t1', { name: 'changed', shell: { kind: 'not-a-real-shell' } });
    assert.equal(res.status, 400);
    assert.match(res.json<{ error: { message: string } }>().error.message, /invalid shell/);
    // The name must NOT have been applied (validate-then-apply contract).
    assert.equal(state.terminals[0]!.name, 'orig');
  } finally {
    await srv.close();
  }
});

test('PUT re-resolves after async validation so a concurrent DELETE yields 404, not a ghost re-insert', async () => {
  const state = baseState();
  state.terminals.push(existingDef());
  const mgr = fakeManager();
  const { ctx } = ctxWith(state, mgr);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'put-race-'));
  const srv = await listen(createTerminalsRouter(ctx));
  try {
    const p = srv.req('PUT', '/api/terminals/t1', { cwd: dir });
    // Drop the terminal from state mid-flight: the route re-reads it after awaiting cwd resolution.
    state.terminals.splice(0, 1);
    const res = await p;
    assert.equal(res.status, 404);
    assert.equal(res.json<{ error: { code: string } }>().error.code, 'not_found');
    // A ghost definition must not have been pushed back onto the manager.
    assert.equal(mgr.calls.includes('upsert:t1'), false);
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('DELETE removes the terminal, tears down the live session, and returns 204', async () => {
  const state = baseState();
  state.terminals.push(existingDef());
  const mgr = fakeManager();
  const { ctx, saves } = ctxWith(state, mgr);
  const srv = await listen(createTerminalsRouter(ctx));
  try {
    const res = await srv.req('DELETE', '/api/terminals/t1');
    assert.equal(res.status, 204);
    assert.equal(state.terminals.length, 0);
    assert.deepEqual(mgr.calls, ['remove:t1']);
    assert.equal(saves(), 1);
  } finally {
    await srv.close();
  }
});

test('lifecycle endpoints 404 for unknown ids and route to the manager for known ones', async () => {
  const state = baseState();
  state.terminals.push(existingDef());
  const mgr = fakeManager();
  const { ctx } = ctxWith(state, mgr);
  const srv = await listen(createTerminalsRouter(ctx));
  try {
    assert.equal((await srv.req('POST', '/api/terminals/ghost/start')).status, 404);
    const started = await srv.req('POST', '/api/terminals/t1/start');
    assert.equal(started.status, 200);
    assert.equal(started.json<{ state: string }>().state, 'running');
    await srv.req('POST', '/api/terminals/t1/stop');
    await srv.req('POST', '/api/terminals/t1/restart');
    assert.deepEqual(mgr.calls, ['start:t1', 'stop:t1', 'restart:t1']);
  } finally {
    await srv.close();
  }
});
