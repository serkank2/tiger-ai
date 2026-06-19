import test from 'node:test';
import assert from 'node:assert/strict';

// Auth is gated on KAPLAN_AUTH_TOKEN, read by config at import time. Set it BEFORE importing the
// module under test so `config.auth.enabled` is true for this whole file.
process.env.KAPLAN_AUTH_TOKEN = 'secret-token';

const { bearerFromHeader, tokenIsValid, tokenFromUpgrade, verifyUpgrade, requireAuth } = await import('./auth.js');

test('bearerFromHeader extracts the token, case-insensitively, trimming whitespace', () => {
  assert.equal(bearerFromHeader('Bearer secret-token'), 'secret-token');
  assert.equal(bearerFromHeader('bearer   secret-token  '), 'secret-token');
  assert.equal(bearerFromHeader('Basic abc'), undefined);
  assert.equal(bearerFromHeader(undefined), undefined);
});

test('tokenIsValid accepts the configured token and rejects wrong/empty ones', () => {
  assert.equal(tokenIsValid('secret-token'), true);
  assert.equal(tokenIsValid('wrong'), false);
  assert.equal(tokenIsValid(''), false);
  assert.equal(tokenIsValid(undefined), false);
});

test('tokenFromUpgrade reads Authorization, then ?token=, then Sec-WebSocket-Protocol', () => {
  assert.equal(tokenFromUpgrade({ headers: { authorization: 'Bearer hdr' }, url: '/ws' } as never), 'hdr');
  assert.equal(tokenFromUpgrade({ headers: {}, url: '/ws?token=qp' } as never), 'qp');
  assert.equal(
    tokenFromUpgrade({ headers: { 'sec-websocket-protocol': 'proto-token, other' }, url: '/ws' } as never),
    'proto-token',
  );
  assert.equal(tokenFromUpgrade({ headers: {}, url: '/ws' } as never), undefined);
});

test('verifyUpgrade enforces the token when auth is enabled', () => {
  assert.equal(verifyUpgrade({ headers: { authorization: 'Bearer secret-token' }, url: '/ws' } as never), true);
  assert.equal(verifyUpgrade({ headers: {}, url: '/ws?token=secret-token' } as never), true);
  assert.equal(verifyUpgrade({ headers: {}, url: '/ws?token=nope' } as never), false);
  assert.equal(verifyUpgrade({ headers: {}, url: '/ws' } as never), false);
});

test('requireAuth calls next() with a 401 HttpError when the token is missing', () => {
  const mw = requireAuth();
  let nextArg: unknown = 'unset';
  mw({ headers: {} } as never, {} as never, (e?: unknown) => {
    nextArg = e;
  });
  assert.ok(nextArg && typeof nextArg === 'object');
  assert.equal((nextArg as { status: number }).status, 401);
  assert.equal((nextArg as { code: string }).code, 'unauthorized');
});

test('requireAuth passes through with a valid bearer token', () => {
  const mw = requireAuth();
  let called = false;
  let nextArg: unknown = 'unset';
  mw({ headers: { authorization: 'Bearer secret-token' } } as never, {} as never, (e?: unknown) => {
    called = true;
    nextArg = e;
  });
  assert.equal(called, true);
  assert.equal(nextArg, undefined);
});

test('requireAuth skips paths matched by the skip predicate', () => {
  const mw = requireAuth({ skip: (req) => req.path === '/api/health/live' });
  let nextArg: unknown = 'unset';
  mw({ headers: {}, path: '/api/health/live' } as never, {} as never, (e?: unknown) => {
    nextArg = e;
  });
  assert.equal(nextArg, undefined);
});
