import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import type { AppCtx } from '../context.js';
import { createFsRouter } from './fs.routes.js';
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
 * Drive the router over an ephemeral server using `http.request` with `agent: false`
 * (no keep-alive client sockets). This avoids the global fetch keep-alive agent leaving
 * a socket handle open during `--test-force-exit` teardown, which aborts libuv on Windows.
 */
async function listen(router: express.Router): Promise<TestServer> {
  const app = express();
  app.use('/api/fs', router);
  app.use(errorHandler());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
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

test('GET /api/fs/home returns the home dir and the platform separator', async () => {
  const srv = await listen(createFsRouter({} as AppCtx));
  try {
    const res = await srv.req('GET', '/api/fs/home');
    assert.equal(res.status, 200);
    const body = res.json<{ home: string; sep: string }>();
    assert.equal(body.home, os.homedir());
    assert.equal(body.sep, path.sep);
  } finally {
    await srv.close();
  }
});

test('GET /api/fs/validate reports an existing directory as exists+isDirectory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-validate-'));
  const srv = await listen(createFsRouter({} as AppCtx));
  try {
    const res = await srv.req('GET', `/api/fs/validate?path=${encodeURIComponent(dir)}`);
    assert.equal(res.status, 200);
    const body = res.json<{ exists: boolean; isDirectory: boolean; path: string }>();
    assert.equal(body.exists, true);
    assert.equal(body.isDirectory, true);
    assert.equal(body.path, path.resolve(dir));
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/fs/validate reports a missing path as exists:false (ENOENT mapped, not an error)', async () => {
  const srv = await listen(createFsRouter({} as AppCtx));
  try {
    const missing = path.join(os.tmpdir(), 'fs-validate-missing-xyz-999');
    const res = await srv.req('GET', `/api/fs/validate?path=${encodeURIComponent(missing)}`);
    assert.equal(res.status, 200);
    const body = res.json<{ exists: boolean; isDirectory: boolean }>();
    assert.equal(body.exists, false);
    assert.equal(body.isDirectory, false);
  } finally {
    await srv.close();
  }
});

test('GET /api/fs/validate rejects a relative path with a bad_request envelope', async () => {
  const srv = await listen(createFsRouter({} as AppCtx));
  try {
    const res = await srv.req('GET', `/api/fs/validate?path=${encodeURIComponent('./relative')}`);
    assert.equal(res.status, 400);
    assert.equal(res.json<{ error: { code: string } }>().error.code, 'bad_request');
  } finally {
    await srv.close();
  }
});

test('GET /api/fs/list returns child directories sorted by name with a parent pointer', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-list-'));
  await fs.mkdir(path.join(dir, 'zeta'));
  await fs.mkdir(path.join(dir, 'alpha'));
  await fs.writeFile(path.join(dir, 'a-file.txt'), 'x'); // files are excluded
  const srv = await listen(createFsRouter({} as AppCtx));
  try {
    const res = await srv.req('GET', `/api/fs/list?path=${encodeURIComponent(dir)}`);
    assert.equal(res.status, 200);
    const body = res.json<{ directories: { name: string }[]; parent: string }>();
    assert.deepEqual(
      body.directories.map((d) => d.name),
      ['alpha', 'zeta'],
    );
    assert.equal(body.parent, path.dirname(path.resolve(dir)));
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/fs/list maps a missing directory to a not_found envelope', async () => {
  const srv = await listen(createFsRouter({} as AppCtx));
  try {
    const missing = path.join(os.tmpdir(), 'fs-list-missing-xyz-999');
    const res = await srv.req('GET', `/api/fs/list?path=${encodeURIComponent(missing)}`);
    assert.equal(res.status, 404);
    assert.equal(res.json<{ error: { code: string } }>().error.code, 'not_found');
  } finally {
    await srv.close();
  }
});
