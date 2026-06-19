import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from './request-context.js';

interface FakeRes {
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
  on(event: string, cb: () => void): void;
}

function fakeRes(): FakeRes {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    on() {},
  };
}

function runMw(path: string, headers: Record<string, unknown> = {}): { req: Request; res: FakeRes } {
  const mw = requestContext();
  const req = { method: 'GET', path, headers } as unknown as Request;
  const res = fakeRes();
  const next: NextFunction = () => {};
  mw(req, res as unknown as Response, next);
  return { req, res };
}

test('mints a UUID and echoes it when no inbound id is present', () => {
  const { req, res } = runMw('/api/tiger/state');
  assert.match(req.id, /^[0-9a-f-]{36}$/);
  assert.equal(res.headers['x-request-id'], req.id);
});

test('honors a valid inbound X-Request-Id', () => {
  const { req, res } = runMw('/api/tiger/state', { 'x-request-id': 'trace-abc.123' });
  assert.equal(req.id, 'trace-abc.123');
  assert.equal(res.headers['x-request-id'], 'trace-abc.123');
});

test('rejects an unsafe inbound X-Request-Id and falls back to a UUID', () => {
  const { req } = runMw('/api/tiger/state', { 'x-request-id': 'bad id with spaces!' });
  assert.match(req.id, /^[0-9a-f-]{36}$/);
});

test('skips id generation entirely for the liveness probe', () => {
  const { req, res } = runMw('/api/health/live');
  assert.equal(req.id, '');
  // No correlation header on the hammered liveness path.
  assert.equal(res.headers['x-request-id'], undefined);
});
