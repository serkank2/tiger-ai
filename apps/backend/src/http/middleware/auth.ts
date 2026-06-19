import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../../config.js';
import { unauthorized } from '../errors.js';

/**
 * Optional shared-token auth.
 *
 * When `config.auth.enabled` (a non-empty `KAPLAN_AUTH_TOKEN`), every `/api/*` request must
 * present `Authorization: Bearer <token>` (the WS upgrade may instead pass `?token=` or the
 * `Sec-WebSocket-Protocol` header). When the token is empty — the local single-user default —
 * auth is disabled and everything is allowed unchanged.
 *
 * The supplied token is compared in constant time so a wrong guess can't be distinguished from
 * a right one by timing.
 */

/** Constant-time string compare that doesn't early-exit on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual requires equal lengths; hash both so length never leaks and compare is fixed-cost.
  const ha = crypto.createHash('sha256').update(ab).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** True if `presented` matches the configured token. Returns true when auth is disabled. */
export function tokenIsValid(presented: string | undefined | null): boolean {
  if (!config.auth.enabled) return true;
  if (!presented) return false;
  return safeEqual(presented, config.auth.token);
}

/** Extract a bearer token from an `Authorization: Bearer <token>` header value. */
export function bearerFromHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : undefined;
}

/**
 * Resolve a token from a raw HTTP/WS upgrade request. Accepts (in order):
 *   - `Authorization: Bearer <token>` header
 *   - `?token=<token>` query param
 *   - `Sec-WebSocket-Protocol` header (browser WS clients can't set Authorization)
 */
export function tokenFromUpgrade(req: IncomingMessage): string | undefined {
  const fromHeader = bearerFromHeader(req.headers.authorization);
  if (fromHeader) return fromHeader;

  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const q = url.searchParams.get('token');
    if (q) return q.trim();
  } catch {
    /* malformed url — fall through */
  }

  const proto = req.headers['sec-websocket-protocol'];
  if (typeof proto === 'string' && proto.trim()) {
    // Comma-separated list; take the first non-empty entry as the token.
    const first = proto.split(',')[0]?.trim();
    if (first) return first;
  }
  return undefined;
}

/** Verify a raw upgrade request's token. Always true when auth is disabled. */
export function verifyUpgrade(req: IncomingMessage): boolean {
  if (!config.auth.enabled) return true;
  return tokenIsValid(tokenFromUpgrade(req));
}

/**
 * Express middleware enforcing the shared token on `/api/*`. `skip(req)` lets callers exempt
 * specific paths (e.g. the liveness endpoint) without baking path knowledge in here.
 */
export function requireAuth(opts: { skip?: (req: Request) => boolean } = {}) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!config.auth.enabled) return next();
    if (opts.skip?.(req)) return next();
    if (tokenIsValid(bearerFromHeader(req.headers.authorization))) return next();
    next(unauthorized());
  };
}
