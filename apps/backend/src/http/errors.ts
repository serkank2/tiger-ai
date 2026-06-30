import type { NextFunction, Request, Response } from 'express';
import { logger } from '../obs/logger.js';

/**
 * Shared HTTP error type with a machine-readable `code`.
 *
 * Clients used to string-match prose (`err.message`) to react to failures; that breaks the
 * moment wording changes. `HttpError` carries a stable `code` (an enum value below) that the
 * frontend can switch on, plus the human message for display. The central error middleware
 * (`errorHandler`) maps any thrown error — `HttpError`, body-parser errors, or unknown — to a
 * consistent `{ error: { message, code } }` envelope.
 */

export const ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'forbidden_origin',
  'not_found',
  'conflict',
  'payload_too_large',
  'validation_failed',
  'workspace_not_allowed',
  'rate_limited',
  'limit_blocked',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Convenience constructors for the common cases. */
export const httpError = (status: number, code: ErrorCode, message: string, details?: unknown): HttpError =>
  new HttpError(status, code, message, details);

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'authentication required') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'forbidden') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'not found') => new HttpError(404, 'not_found', message);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
export const validationFailed = (message: string, details?: unknown) =>
  new HttpError(422, 'validation_failed', message, details);

function statusToCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 422:
      return 'validation_failed';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'internal' : 'bad_request';
  }
}

/**
 * Central Express error handler. Honors `HttpError`, then any `status`/`statusCode` carrying
 * error (body-parser 400/413, legacy `httpError(status, msg)` helpers), then falls back to 500.
 * 5xx messages are not leaked to the client; they are logged with the request id for tracing.
 */
export function errorHandler() {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const reqId = (req as Request & { id?: string }).id;
    const log = reqId ? logger.child({ reqId }) : logger;

    if (err instanceof HttpError) {
      if (err.status >= 500) log.error('request failed', { err, path: req.path, status: err.status });
      res.status(err.status).json({ error: { message: err.message, code: err.code, details: err.details } });
      return;
    }

    const e = err as { code?: string; status?: number; statusCode?: number };
    const explicit =
      typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
    const status = explicit && explicit >= 400 && explicit < 600 ? explicit : e.code === 'EINVAL_CWD' ? 400 : 500;
    const rawMessage = err instanceof Error ? err.message : String(err);

    if (status >= 500) log.error('unhandled error', { err, path: req.path });

    res.status(status).json({
      error: {
        message: status >= 500 ? 'internal server error' : rawMessage,
        code: statusToCode(status),
      },
    });
  };
}
