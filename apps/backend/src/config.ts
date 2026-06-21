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

function envChoice<T extends string>(name: string, choices: readonly T[], fallback: T): T {
  const raw = process.env[name]?.trim();
  return raw && choices.includes(raw as T) ? (raw as T) : fallback;
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

  // Tiger pipeline execution toggles.
  tiger: {
    // Git-worktree-per-task isolation for the parallel execute stage. OFF by default: when
    // enabled (KAPLAN_WORKTREE_PER_TASK=1) AND the workspace is a git repo, each parallel task
    // agent runs in its OWN throwaway git worktree so concurrent agents can't collide on the
    // working tree; on clean completion its branch is merged back and the worktree pruned. When
    // disabled, agents share the workspace cwd exactly as before (behavior is byte-for-byte
    // unchanged).
    worktreePerTask: envBool('KAPLAN_WORKTREE_PER_TASK', false),
  },

  // AI Team execution toggles.
  team: {
    orchestrationMode: envChoice('KAPLAN_TEAM_ORCHESTRATION_MODE', ['legacy', 'company'] as const, 'legacy'),
    maxConcurrentReadOnly: Math.max(1, envInt('KAPLAN_TEAM_MAX_CONCURRENT_READ_ONLY', 2)),
    maxConcurrentWrite: Math.max(1, envInt('KAPLAN_TEAM_MAX_CONCURRENT_WRITE', 1)),
    // Git-worktree-per-task isolation for Team role turns. OFF by default: when enabled
    // (KAPLAN_TEAM_WORKTREE_PER_TASK=1) AND the workspace is a git repo, each role's CLAIMED
    // board task runs in its OWN throwaway git worktree (branch kaplan/<runId>-<taskId>) so a
    // task's edits are isolated; its per-task diff is captured and merged back to the workspace
    // base branch on completion. A merge CONFLICT aborts the merge, marks the task blocked, and
    // KEEPS the worktree intact for manual resolution (never auto-resolved); a clean merge prunes
    // it. When disabled, role turns use the shared workspace cwd exactly as today (byte-for-byte
    // unchanged). Extends the Tiger-only worktree feature (config.tiger.worktreePerTask).
    worktreePerTask: envBool('KAPLAN_TEAM_WORKTREE_PER_TASK', false),
  },

  // Queue execution toggles.
  queue: {
    queuePipelineV2: envChoice('KAPLAN_QUEUE_PIPELINE_V2', ['off', 'on'] as const, 'off'),
  },

  // Cue — event-driven orchestration engine. OFF by default: when enabled (KAPLAN_CUE_ENABLED=1)
  // the engine loads a per-project `.kaplan/cue.json` and wakes agents into self-running pipelines
  // (file changes / schedules / agent completions / manual triggers → queue jobs or team steering).
  // Disabled means the engine is never constructed, so a normal boot is byte-for-byte unchanged.
  cue: {
    enabled: envBool('KAPLAN_CUE_ENABLED', false),
    // Optional explicit workspace. Empty => use the active Tiger project's workspace.
    workspace: process.env.KAPLAN_CUE_WORKSPACE?.trim() || '',
  },

  // Basic abuse guard on the HTTP API (per-IP fixed window). Generous for a local tool.
  rateLimit: {
    enabled: envBool('KAPLAN_RATE_LIMIT', true),
    windowMs: envInt('KAPLAN_RATE_LIMIT_WINDOW_MS', 60_000),
    max: envInt('KAPLAN_RATE_LIMIT_MAX', 600),
  },
};

export type Config = typeof config;
