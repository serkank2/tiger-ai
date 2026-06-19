import { config } from '../config.js';

/**
 * Minimal structured logger — zero deps, ESM, fail-safe.
 *
 * Levels gate output; `config.log.json` switches between newline-delimited JSON (prod,
 * machine-ingestible) and a compact human-friendly line (dev). A logger carries `bindings`
 * (e.g. a request id, a run id) that are merged into every record, so call sites can
 * `logger.child({ reqId })` once and have correlation flow through automatically.
 *
 * This intentionally replaces scattered `console.*` calls: structured fields instead of
 * string-concatenated prose, and a single place to change transport later.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Derive a logger that merges `bindings` into every record (correlation context). */
  child(bindings: LogFields): Logger;
}

function serializeError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function normalizeFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = k === 'err' || v instanceof Error ? serializeError(v) : v;
  }
  return out;
}

function emit(level: LogLevel, bindings: LogFields, msg: string, fields?: LogFields): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[config.log.level]) return;
  const merged = { ...bindings, ...(fields ? normalizeFields(fields) : {}) };
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  if (config.log.json) {
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...merged }));
    return;
  }
  // Human-friendly: "HH:MM:SS LEVEL msg key=val …"
  const ts = new Date().toISOString().slice(11, 23);
  const tail = Object.entries(merged)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  sink(`${ts} ${level.toUpperCase().padEnd(5)} ${msg}${tail ? ' ' + tail : ''}`);
}

function make(bindings: LogFields): Logger {
  return {
    debug: (msg, fields) => emit('debug', bindings, msg, fields),
    info: (msg, fields) => emit('info', bindings, msg, fields),
    warn: (msg, fields) => emit('warn', bindings, msg, fields),
    error: (msg, fields) => emit('error', bindings, msg, fields),
    child: (extra) => make({ ...bindings, ...extra }),
  };
}

/** The root logger. Use `.child({ … })` to add correlation context. */
export const logger = make({});
