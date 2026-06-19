import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '../../obs/logger.js';
import { logger } from '../../obs/logger.js';
import { metrics, statusClass } from '../../obs/metrics.js';

/**
 * Per-request correlation + access logging.
 *
 * Assigns `req.id` (a UUID), attaches a child logger bound to that id (`req.log`), echoes it
 * back as `X-Request-Id`, and logs one structured line per request on completion (method, path,
 * status, durationMs, reqId) — info for 2xx/3xx, warn for 4xx, error for 5xx. Also bumps the
 * `http_requests_total{class=…}` counter so /metrics reflects request volume by status class.
 *
 * Put this FIRST in the chain so every downstream handler (and the error handler) sees `req.id`.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
    }
  }
}

export function requestContext() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const reqId = crypto.randomUUID();
    req.id = reqId;
    req.log = logger.child({ reqId });
    res.setHeader('X-Request-Id', reqId);

    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const status = res.statusCode;
      metrics.inc('http_requests_total', { class: statusClass(status) });
      const fields = { method: req.method, path: req.path, status, durationMs: Math.round(durationMs), reqId };
      const msg = 'request';
      if (status >= 500) req.log.error(msg, fields);
      else if (status >= 400) req.log.warn(msg, fields);
      else req.log.info(msg, fields);
    });

    next();
  };
}
