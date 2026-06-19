import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './util/env.js';

// Pull a local, gitignored `.env` (DB password etc.) into process.env before we read
// any config below. Real environment variables still take precedence.
loadDotEnv();

// Repo root, resolved from this module's location (apps/backend/src/config.ts → up 3).
// Used for the default prompts dir so it lands at <repo>/prompts regardless of cwd.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Resolve the directory where Kaplan persists its state.
 * Default: OS app-data dir. Override with KAPLAN_DATA_DIR (useful for dev/portable mode).
 */
function resolveDataDir(): string {
  const override = process.env.KAPLAN_DATA_DIR;
  if (override && override.trim()) return path.resolve(override.trim());

  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'kaplan');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'kaplan');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'kaplan');
}

const dataDir = resolveDataDir();

/**
 * Bind to loopback by default. A non-loopback host exposes the unauthenticated
 * terminal API to the network, so it requires an explicit KAPLAN_ALLOW_REMOTE=1 opt-in.
 */
function resolveHost(): string {
  const h = process.env.KAPLAN_HOST;
  if (!h) return '127.0.0.1';
  const isLoopback = h === '127.0.0.1' || h === '::1' || h === 'localhost';
  if (isLoopback || process.env.KAPLAN_ALLOW_REMOTE === '1') return h;
  console.warn(
    `[kaplan] refusing non-loopback KAPLAN_HOST="${h}" (no auth); set KAPLAN_ALLOW_REMOTE=1 to override. Binding 127.0.0.1.`,
  );
  return '127.0.0.1';
}

/** Where prompt .md files live. Default: <repo>/prompts. Override: KAPLAN_PROMPTS_DIR. */
function resolvePromptsDir(): string {
  const override = process.env.KAPLAN_PROMPTS_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(repoRoot, 'prompts');
}

function parseOrigins(): string[] {
  const raw = process.env.KAPLAN_CORS_ORIGINS;
  if (raw && raw.trim()) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ['http://localhost:3000', 'http://127.0.0.1:3000'];
}

/** Comma-separated absolute directories agents/runs may use as workspaces. */
function parseList(name: string): string[] {
  const raw = process.env[name];
  if (raw && raw.trim()) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

const isProd = process.env.NODE_ENV === 'production';

/** Read an env var as an integer, falling back to `fallback` when unset/invalid. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * MySQL connection settings — the durable system of record. Safe local defaults so a
 * fresh checkout points at a loopback MySQL; the root password is intentionally NOT
 * defaulted and must come from the gitignored `.env` (see .env.example).
 */
const db = {
  host: process.env.KAPLAN_DB_HOST?.trim() || '127.0.0.1',
  port: envInt('KAPLAN_DB_PORT', 3306),
  user: process.env.KAPLAN_DB_USER?.trim() || 'root',
  password: process.env.KAPLAN_DB_PASSWORD ?? '',
  database: process.env.KAPLAN_DB_NAME?.trim() || 'kaplan',
  charset: 'utf8mb4',
  // Pool sizing — modest; this is a single-user local tool.
  connectionLimit: envInt('KAPLAN_DB_POOL_SIZE', 10),
  // Connect-with-retry window applied at startup (initial connection + CREATE DATABASE).
  connectRetries: envInt('KAPLAN_DB_CONNECT_RETRIES', 10),
  connectRetryDelayMs: envInt('KAPLAN_DB_CONNECT_RETRY_DELAY_MS', 500),
  connectMaxDelayMs: envInt('KAPLAN_DB_CONNECT_MAX_DELAY_MS', 5000),
};

export const config = {
  repoRoot,
  host: resolveHost(),
  port: Number(process.env.KAPLAN_PORT || 4517),
  dataDir,
  stateFile: path.join(dataDir, 'state.json'),
  promptsDir: resolvePromptsDir(),
  corsOrigins: parseOrigins(),

  // MySQL — durable system of record (see db/pool.ts, db/migrate.ts).
  db,

  // pty output coalescing + scrollback
  outputFlushMs: 16,
  outputFlushBytes: 32 * 1024,
  scrollbackBytes: 256 * 1024,

  // graceful-stop window before force kill
  stopTimeoutMs: 2500,

  // Provider limit probes.
  limitProbeIntervalMs: Math.max(0, envInt('KAPLAN_LIMIT_PROBE_MS', 5 * 60 * 1000)),
  limitStaleAfterMs: Math.max(60_000, envInt('KAPLAN_LIMIT_STALE_AFTER_MS', 15 * 60 * 1000)),

  // Structured logging. JSON in production, human-friendly otherwise; level gates output.
  log: {
    level: (process.env.KAPLAN_LOG_LEVEL?.trim() || (isProd ? 'info' : 'debug')) as
      | 'debug'
      | 'info'
      | 'warn'
      | 'error',
    json: envBool('KAPLAN_LOG_JSON', isProd),
  },

  // Optional auth. When a token is set, every HTTP request and WS upgrade must present it
  // (Authorization: Bearer <token>, or ?token= for WS). Empty token = auth disabled (local).
  auth: {
    token: process.env.KAPLAN_AUTH_TOKEN?.trim() || '',
    get enabled(): boolean {
      return this.token.length > 0;
    },
  },

  // Workspace safety. When enforcement is on, runs/agents may only operate inside one of the
  // allow-listed directories (or the data dir). Off by default to preserve local single-user UX.
  security: {
    workspaceAllowlist: parseList('KAPLAN_WORKSPACE_ALLOWLIST').map((p) => path.resolve(p)),
    enforceWorkspaceBoundary: envBool('KAPLAN_ENFORCE_WORKSPACE', false),
    // The blanket `--dangerously-*` agent permission is opt-in; safer per-permission config
    // is always honored. Default false => dangerous blanket modes are NOT applied implicitly.
    allowDangerousAgentPermissions: envBool('KAPLAN_ALLOW_DANGEROUS_AGENT_PERMISSIONS', false),
  },

  // Basic abuse guard on the HTTP API (per-IP fixed window). Generous for a local tool.
  rateLimit: {
    enabled: envBool('KAPLAN_RATE_LIMIT', true),
    windowMs: envInt('KAPLAN_RATE_LIMIT_WINDOW_MS', 60_000),
    max: envInt('KAPLAN_RATE_LIMIT_MAX', 600),
  },
};

export type Config = typeof config;
