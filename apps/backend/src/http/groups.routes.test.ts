import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import type { AppCtx } from '../context.js';
import type { PersistedState, TerminalDefinition } from '../store/types.js';
import { createGroupsRouter } from './groups.routes.js';
import { errorHandler } from './errors.js';

interface Res {
  status: number;
  json: <T = unknown>() => T;
}

/**
 * `http.request` with `agent: false` (no keep-alive client sockets) so `--test-force-exit`
 * has no lingering socket handle to abort libuv on during teardown.
 */
async function listen(router: express.Router): Promise<{ req: (m: string, p: string, b?: unknown) => Promise<Res>; close: () => Promise<void> }> {
  const app = express();
  app.use('/api/groups', express.json({ limit: '160kb' }), router);
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

function state(): PersistedState {
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
    updatedAt: 'x',
  };
}

function ctxWith(s: PersistedState) {
  const upserts: string[] = [];
  const ctx = {
    state: s,
    manager: { upsertDefinition: (d: TerminalDefinition) => upserts.push(d.id) } as unknown as AppCtx['manager'],
    save: async () => {},
  } as unknown as AppCtx;
  return { ctx, upserts };
}

test('POST /api/groups creates a group with a valid hex color and returns 201', async () => {
  const s = state();
  const { ctx } = ctxWith(s);
  const srv = await listen(createGroupsRouter(ctx));
  try {
    const res = await srv.req('POST', '/api/groups', { name: 'Frontend', color: '#ff8800' });
    assert.equal(res.status, 201);
    const body = res.json<{ name: string; color?: string }>();
    assert.equal(body.name, 'Frontend');
    assert.equal(body.color, '#ff8800');
    assert.equal(s.groups.length, 1);
  } finally {
    await srv.close();
  }
});

test('POST /api/groups drops a non-hex color (e.g. CSS url) rather than storing it', async () => {
  const s = state();
  const { ctx } = ctxWith(s);
  const srv = await listen(createGroupsRouter(ctx));
  try {
    const res = await srv.req('POST', '/api/groups', { name: 'X', color: 'url(evil.png)' });
    assert.equal(res.status, 201);
    assert.equal(res.json<{ color?: string }>().color, undefined);
  } finally {
    await srv.close();
  }
});

test('POST /api/groups requires a name', async () => {
  const { ctx } = ctxWith(state());
  const srv = await listen(createGroupsRouter(ctx));
  try {
    const res = await srv.req('POST', '/api/groups', { color: '#fff' });
    assert.equal(res.status, 400);
    assert.equal(res.json<{ error: { code: string } }>().error.code, 'bad_request');
  } finally {
    await srv.close();
  }
});

test('PUT /api/groups/:id 404s for an unknown group', async () => {
  const { ctx } = ctxWith(state());
  const srv = await listen(createGroupsRouter(ctx));
  try {
    const res = await srv.req('PUT', '/api/groups/ghost', { name: 'x' });
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }
});

test('DELETE /api/groups/:id unassigns member terminals and re-syncs the manager', async () => {
  const s = state();
  s.groups.push({ id: 'g1', name: 'G' });
  const member: TerminalDefinition = {
    id: 't1', name: 'm', cwd: os.tmpdir(), groupId: 'g1', shell: { kind: 'system-default' },
    autostart: false, protected: false, createdAt: 'x', updatedAt: 'x',
  };
  s.terminals.push(member);
  const { ctx, upserts } = ctxWith(s);
  const srv = await listen(createGroupsRouter(ctx));
  try {
    const res = await srv.req('DELETE', '/api/groups/g1');
    assert.equal(res.status, 204);
    assert.equal(s.groups.length, 0);
    assert.equal(s.terminals[0]!.groupId, null, 'member terminal must be unassigned');
    assert.deepEqual(upserts, ['t1'], 'manager must be re-synced for the unassigned terminal');
  } finally {
    await srv.close();
  }
});
