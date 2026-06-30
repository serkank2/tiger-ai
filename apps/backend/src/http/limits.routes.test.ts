import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import type { AppCtx } from '../context.js';
import { createLimitsRouter } from './limits.routes.js';
import { LimitRuleValidationError } from '../services/LimitService.js';
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
  app.use('/api/limits', express.json({ limit: '160kb' }), router);
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

const STATE = { providers: [], decision: null, updatedAt: 'x' } as unknown as ReturnType<AppCtx['limits']['getState']>;

function ctxWith(limits: Partial<AppCtx['limits']>): AppCtx {
  return {
    limits: { getState: () => STATE, listRules: () => [], ...limits } as unknown as AppCtx['limits'],
  } as unknown as AppCtx;
}

test('GET /api/limits returns the current state snapshot', async () => {
  const srv = await listen(createLimitsRouter(ctxWith({})));
  try {
    const res = await srv.req('GET', '/api/limits');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), STATE);
  } finally {
    await srv.close();
  }
});

test('POST /api/limits/rules returns 201 with the new state on success', async () => {
  const ctx = ctxWith({ createRule: async () => STATE });
  const srv = await listen(createLimitsRouter(ctx));
  try {
    const res = await srv.req('POST', '/api/limits/rules', { provider: 'claude' });
    assert.equal(res.status, 201);
    assert.deepEqual(res.json(), STATE);
  } finally {
    await srv.close();
  }
});

test('POST /api/limits/rules maps a validation error to a 400 bad_request envelope', async () => {
  const ctx = ctxWith({
    createRule: async () => {
      throw new LimitRuleValidationError('provider must be one of claude, codex, antigravity');
    },
  });
  const srv = await listen(createLimitsRouter(ctx));
  try {
    const res = await srv.req('POST', '/api/limits/rules', { provider: 'bogus' });
    assert.equal(res.status, 400);
    const body = res.json<{ error: { code: string; message: string } }>();
    assert.equal(body.error.code, 'bad_request');
    assert.match(body.error.message, /provider must be one of/);
  } finally {
    await srv.close();
  }
});

test('PUT /api/limits/rules/:id maps a "not found" validation error to a 404 not_found envelope', async () => {
  const ctx = ctxWith({
    updateRule: async () => {
      throw new LimitRuleValidationError('rule "r9" not found');
    },
  });
  const srv = await listen(createLimitsRouter(ctx));
  try {
    const res = await srv.req('PUT', '/api/limits/rules/r9', { provider: 'claude' });
    assert.equal(res.status, 404);
    assert.equal(res.json<{ error: { code: string } }>().error.code, 'not_found');
  } finally {
    await srv.close();
  }
});

test('POST /api/limits/refresh delegates to the service', async () => {
  let refreshed = '';
  const ctx = ctxWith({
    refresh: async (source) => {
      refreshed = source ?? '';
      return STATE;
    },
  });
  const srv = await listen(createLimitsRouter(ctx));
  try {
    const res = await srv.req('POST', '/api/limits/refresh');
    assert.equal(res.status, 200);
    assert.equal(refreshed, 'manual');
  } finally {
    await srv.close();
  }
});
