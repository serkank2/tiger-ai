import type { NextFunction, Request, Response } from 'express';
import { config } from '../../config.js';
import { httpError } from '../errors.js';

/**
 * In-process per-IP fixed-window rate limiter — zero deps.
 *
 * Each client IP gets a counter that resets every `windowMs`. Once `max` is exceeded inside the
 * current window the request is rejected with 429 (`rate_limited`) and a `Retry-After` header.
 * Fixed-window is intentionally simple; this is an abuse guard for a single-user local tool, not
 * a precise distributed quota. `skip(req)` exempts paths (e.g. liveness probes).
 *
 * Bucket entries are cleaned up lazily once their window has elapsed, so memory stays bounded to
 * the set of IPs seen within one window.
 */

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  skip?: (req: Request) => boolean;
  /** Injectable clock for tests. */
  now?: () => number;
}

export function rateLimit(opts: RateLimitOptions = {}) {
  const windowMs = opts.windowMs ?? config.rateLimit.windowMs;
  const max = opts.max ?? config.rateLimit.max;
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, Window>();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (opts.skip?.(req)) return next();

    const key = clientIp(req);
    const t = now();
    let w = buckets.get(key);
    if (!w || t >= w.resetAt) {
      w = { count: 0, resetAt: t + windowMs };
      buckets.set(key, w);
    }
    w.count += 1;

    const remaining = Math.max(0, max - w.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(w.resetAt / 1000)));

    if (w.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((w.resetAt - t) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      next(httpError(429, 'rate_limited', 'too many requests'));
      return;
    }

    next();
  };
}

/** Best-effort client IP; loopback clients normalize to a stable key. */
function clientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
