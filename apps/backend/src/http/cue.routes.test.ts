import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import type { AppCtx } from '../context.js';
import type { CueEngineStatus } from '../cue/types.js';
import { createCueRouter } from './cue.routes.js';
import { errorHandler } from './errors.js';

interface Res {
  status: number;
  json: <T = unknown>() => T;
}

async function listen(
  getEngine: () => unknown,
): Promise<{ req: (m: string, p: string, b?: unknown) => Promise<Res>; close: () => Promise<void> }> {
  const app = express();
  app.use('/api/cue', express.json({ limit: '64kb' }), createCueRouter({} as AppCtx, getEngine as never));
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

const STATUS: CueEngineStatus = {
  enabled: true,
  running: true,
  workspace: 'C:/repo',
  configPath: 'C:/repo/.kaplan/cue.json',
  subscriptions: [
    {
      id: 'manual',
      name: 'Manual job',
      event: 'cli.trigger',
      target: 'queue',
      enabled: true,
      lastFiredAt: null,
      fireCount: 0,
      lastError: null,
    },
  ],
};

test('GET /api/cue/status returns the engine status payload', async () => {
  const engine = { getStatus: () => STATUS };
  const srv = await listen(() => engine);
  try {
    const res = await srv.req('GET', '/api/cue/status');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), STATUS);
  } finally {
    await srv.close();
  }
});

test('GET /api/cue/status is reachable when the engine is disabled', async () => {
  const srv = await listen(() => null);
  try {
    const res = await srv.req('GET', '/api/cue/status');
    assert.equal(res.status, 409);
    const body = res.json<{ error: { code: string; message: string } }>();
    assert.equal(body.error.code, 'conflict');
    assert.equal(body.error.message, 'cue engine is not enabled');
  } finally {
    await srv.close();
  }
});
