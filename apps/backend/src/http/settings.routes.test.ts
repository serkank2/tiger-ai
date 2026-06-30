import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import type { AppCtx } from '../context.js';
import type { PersistedState } from '../store/types.js';
import { createSettingsRouter } from './settings.routes.js';
import { errorHandler } from './errors.js';

interface Res {
  status: number;
  json: <T = unknown>() => T;
}

/**
 * `http.request` with `agent: false` (no keep-alive client sockets) so `--test-force-exit`
 * has no lingering socket handle to abort libuv on during teardown.
 */
async function listen(
  router: express.Router,
): Promise<{ req: (m: string, p: string, b?: unknown) => Promise<Res>; close: () => Promise<void> }> {
  const app = express();
  app.use('/api/settings', express.json({ limit: '160kb' }), router);
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
  let saves = 0;
  const ctx = {
    state: s,
    save: async () => {
      saves += 1;
    },
  } as unknown as AppCtx;
  return { ctx, saveCount: () => saves };
}

test('PUT /api/settings applies a valid theme, cwd and routing flags and persists', async () => {
  const s = state();
  const { ctx, saveCount } = ctxWith(s);
  const srv = await listen(createSettingsRouter(ctx));
  try {
    const res = await srv.req('PUT', '/api/settings', {
      theme: 'dark',
      defaultCwd: os.tmpdir(),
      commandRouting: { appendNewlineByDefault: false, startTerminalOnSend: false },
    });
    assert.equal(res.status, 200);
    assert.equal(s.settings.theme, 'dark');
    assert.equal(s.settings.defaultCwd, path.resolve(os.tmpdir()));
    assert.equal(s.settings.commandRouting.appendNewlineByDefault, false);
    assert.equal(s.settings.commandRouting.startTerminalOnSend, false);
    assert.equal(saveCount(), 1);
  } finally {
    await srv.close();
  }
});

test('PUT /api/settings rejects an invalid theme without mutating settings', async () => {
  const s = state();
  const { ctx, saveCount } = ctxWith(s);
  const srv = await listen(createSettingsRouter(ctx));
  try {
    const res = await srv.req('PUT', '/api/settings', { theme: 'has spaces & symbols!' });
    assert.equal(res.status, 400);
    assert.match(res.json<{ error: { message: string } }>().error.message, /invalid theme/);
    assert.equal(s.settings.theme, 'system', 'theme must be unchanged after a rejected request');
    assert.equal(saveCount(), 0, 'a rejected settings PUT must not persist');
  } finally {
    await srv.close();
  }
});

test('PUT /api/settings rejects a non-existent defaultCwd', async () => {
  const s = state();
  const { ctx } = ctxWith(s);
  const srv = await listen(createSettingsRouter(ctx));
  try {
    const res = await srv.req('PUT', '/api/settings', { defaultCwd: path.join(os.tmpdir(), 'nope-not-real-987') });
    assert.equal(res.status, 400);
    assert.match(res.json<{ error: { message: string } }>().error.message, /invalid defaultCwd/);
  } finally {
    await srv.close();
  }
});

test('PUT /api/settings ignores unknown commandRouting fields and non-boolean values', async () => {
  const s = state();
  const { ctx } = ctxWith(s);
  const srv = await listen(createSettingsRouter(ctx));
  try {
    await srv.req('PUT', '/api/settings', { commandRouting: { appendNewlineByDefault: 'yes', bogus: 1 } });
    // Non-boolean string must be ignored, leaving the default in place.
    assert.equal(s.settings.commandRouting.appendNewlineByDefault, true);
    assert.equal((s.settings.commandRouting as unknown as Record<string, unknown>).bogus, undefined);
  } finally {
    await srv.close();
  }
});
