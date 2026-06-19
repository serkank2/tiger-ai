import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { rateLimit } from './rate-limit.js';

/** Minimal Express req/res/next doubles for exercising the middleware in isolation. */
function fakeReq(ip = '1.2.3.4', path = '/api/x'): Request {
  return { ip, path, socket: { remoteAddress: ip } } as unknown as Request;
}
function fakeRes(): Response {
  return { setHeader() {} } as unknown as Response;
}
function run(mw: ReturnType<typeof rateLimit>, req: Request): unknown {
  let captured: unknown;
  const next: NextFunction = (e?: unknown) => {
    captured = e;
  };
  mw(req, fakeRes(), next);
  return captured;
}

test('allows requests up to max, then rejects with a 429 HttpError', () => {
  const mw = rateLimit({ windowMs: 1000, max: 3, now: () => 0 });
  const req = fakeReq();
  assert.equal(run(mw, req), undefined); // 1
  assert.equal(run(mw, req), undefined); // 2
  assert.equal(run(mw, req), undefined); // 3
  const err = run(mw, req); // 4 — over the limit
  assert.ok(err && typeof err === 'object');
  assert.equal((err as { status: number }).status, 429);
  assert.equal((err as { code: string }).code, 'rate_limited');
});

test('resets the counter when the window elapses', () => {
  let clock = 0;
  const mw = rateLimit({ windowMs: 1000, max: 1, now: () => clock });
  const req = fakeReq();
  assert.equal(run(mw, req), undefined); // 1st in window
  assert.ok(run(mw, req)); // 2nd — blocked
  clock = 1000; // window rolled over
  assert.equal(run(mw, req), undefined); // counter reset, allowed again
});

test('tracks each client IP independently', () => {
  const mw = rateLimit({ windowMs: 1000, max: 1, now: () => 0 });
  assert.equal(run(mw, fakeReq('10.0.0.1')), undefined);
  assert.ok(run(mw, fakeReq('10.0.0.1'))); // same IP blocked
  assert.equal(run(mw, fakeReq('10.0.0.2')), undefined); // different IP fresh
});

test('skip predicate exempts matching requests entirely', () => {
  const mw = rateLimit({ windowMs: 1000, max: 1, now: () => 0, skip: (req) => req.path === '/api/health/live' });
  const req = fakeReq('9.9.9.9', '/api/health/live');
  for (let i = 0; i < 5; i++) assert.equal(run(mw, req), undefined);
});
