import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '../config.js';
import type { AppSettings, PersistedState, ShellSpec } from './types.js';
import { defaultLimitRules } from '../limits/types.js';
import type { LimitRule, LimitRuleDecision, LimitSnapshot, LimitsPersistedState } from '../limits/types.js';
import { isAgentType } from '../orchestrator/types.js';

const SCHEMA_VERSION = 1 as const;

let stateTmpSeq = 0; // unique temp-filename counter for atomic writes

// Defensive shape checks so a corrupt-but-valid-JSON state.json can't crash startup
// (e.g. present()/manager dereferencing a malformed definition).
function isValidTerminal(t: unknown): boolean {
  if (!t || typeof t !== 'object') return false;
  const d = t as Record<string, unknown>;
  return (
    typeof d.id === 'string' &&
    typeof d.name === 'string' &&
    typeof d.cwd === 'string' &&
    !!d.shell &&
    typeof d.shell === 'object'
  );
}
function isValidGroup(g: unknown): boolean {
  if (!g || typeof g !== 'object') return false;
  const x = g as Record<string, unknown>;
  return typeof x.id === 'string' && typeof x.name === 'string';
}

export function defaultShell(): ShellSpec {
  return { kind: 'system-default' };
}

export function defaultSettings(): AppSettings {
  return {
    theme: 'kaplan-dark',
    defaultCwd: os.homedir(),
    defaultShell: defaultShell(),
    commandRouting: {
      appendNewlineByDefault: true,
      startTerminalOnSend: false,
    },
  };
}

export function defaultState(): PersistedState {
  return {
    schemaVersion: SCHEMA_VERSION,
    terminals: [],
    groups: [],
    settings: defaultSettings(),
    limits: { snapshots: [], rules: defaultLimitRules() },
    updatedAt: new Date().toISOString(),
  };
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
}

/** Fill in any missing fields so callers always get a complete, valid object. */
function normalize(parsed: unknown): PersistedState {
  const base = defaultState();
  if (!parsed || typeof parsed !== 'object') return base;
  const p = parsed as Partial<PersistedState> & { settings?: Partial<AppSettings> };
  const settings: Partial<AppSettings> = p.settings ?? {};
  const tigerRaw = p.tiger && typeof p.tiger === 'object' ? p.tiger : undefined;
  const tigerWorkspace = tigerRaw && typeof tigerRaw.lastWorkspace === 'string' ? tigerRaw.lastWorkspace : undefined;
  const tigerProjects =
    tigerRaw && Array.isArray(tigerRaw.projects)
      ? tigerRaw.projects.filter((x): x is string => typeof x === 'string')
      : undefined;
  const tiger =
    tigerWorkspace || (tigerProjects && tigerProjects.length)
      ? { ...(tigerWorkspace ? { lastWorkspace: tigerWorkspace } : {}), ...(tigerProjects ? { projects: tigerProjects } : {}) }
      : undefined;
  return {
    schemaVersion: SCHEMA_VERSION,
    terminals: Array.isArray(p.terminals) ? p.terminals.filter(isValidTerminal) : [],
    groups: Array.isArray(p.groups) ? p.groups.filter(isValidGroup) : [],
    settings: {
      ...base.settings,
      ...settings,
      defaultShell: settings.defaultShell ?? base.settings.defaultShell,
      commandRouting: {
        ...base.settings.commandRouting,
        ...(settings.commandRouting ?? {}),
      },
    },
    ...(tiger ? { tiger } : {}),
    limits: normalizeLimits(p.limits),
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : base.updatedAt,
  };
}

/** Parse + normalize a raw state.json string (exported so reload normalization is unit-testable). */
export function parseAndNormalize(raw: string): PersistedState {
  const parsed = JSON.parse(raw); // throws SyntaxError on corruption
  const ver = (parsed as { schemaVersion?: unknown })?.schemaVersion;
  if (typeof ver === 'number' && ver > SCHEMA_VERSION) {
    // Newer schema than this build understands — refuse to silently downgrade it.
    const e = new Error(`state schemaVersion ${ver} is newer than supported ${SCHEMA_VERSION}`);
    (e as NodeJS.ErrnoException).code = 'ESCHEMA_NEWER';
    throw e;
  }
  return normalize(parsed);
}

function isValidMetricRaw(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.percent === 'number' &&
    Number.isFinite(raw.percent) &&
    (raw.metric === 'used' || raw.metric === 'left')
  );
}

function isValidLimitSnapshot(value: unknown): value is LimitSnapshot {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.id === 'string' &&
    isAgentType(raw.provider) &&
    typeof raw.windowKey === 'string' &&
    typeof raw.label === 'string' &&
    (raw.percentUsed === null || (typeof raw.percentUsed === 'number' && Number.isFinite(raw.percentUsed))) &&
    isValidMetricRaw(raw.metricRaw) &&
    (raw.resetText === null || typeof raw.resetText === 'string') &&
    (raw.resetAt === null || typeof raw.resetAt === 'string') &&
    typeof raw.ok === 'boolean' &&
    (raw.error === undefined || typeof raw.error === 'string') &&
    typeof raw.rawPanel === 'string' &&
    (raw.parseConfidence === 'trusted' || raw.parseConfidence === 'unknown') &&
    typeof raw.checkedAt === 'string'
  );
}

function isValidLimitRule(value: unknown): value is LimitRule {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.id === 'string' &&
    isAgentType(raw.provider) &&
    typeof raw.windowKey === 'string' &&
    typeof raw.thresholdPercent === 'number' &&
    Number.isFinite(raw.thresholdPercent) &&
    raw.comparison === 'gte' &&
    raw.action === 'block' &&
    typeof raw.enabled === 'boolean' &&
    typeof raw.createdAt === 'string' &&
    typeof raw.updatedAt === 'string'
  );
}

function isValidLimitDecision(value: unknown): value is LimitRuleDecision {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.allowed === 'boolean' &&
    (raw.action === 'allow' || raw.action === 'block') &&
    typeof raw.reason === 'string' &&
    (raw.resumeAfter === null || typeof raw.resumeAfter === 'string') &&
    typeof raw.conservative === 'boolean' &&
    typeof raw.checkedAt === 'string'
  );
}

function normalizeLimits(raw: unknown): LimitsPersistedState {
  const now = new Date().toISOString();
  if (!raw || typeof raw !== 'object') return { snapshots: [], rules: defaultLimitRules(now) };
  const value = raw as Partial<LimitsPersistedState>;
  const snapshots = Array.isArray(value.snapshots) ? value.snapshots.filter(isValidLimitSnapshot) : [];
  const rules = Array.isArray(value.rules) ? value.rules.filter(isValidLimitRule) : [];
  return {
    snapshots,
    rules: rules.length ? rules : defaultLimitRules(now),
    ...(isValidLimitDecision(value.lastDecision) ? { lastDecision: value.lastDecision } : {}),
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  };
}

async function tryLoadBackup(): Promise<PersistedState | null> {
  try {
    const raw = await fs.readFile(config.stateFile + '.bak', 'utf8');
    return parseAndNormalize(raw);
  } catch {
    return null;
  }
}

async function preserveBadFile(file: string): Promise<void> {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.rename(file, path.join(config.dataDir, `state.corrupt.${ts}.json`));
  } catch {
    /* best effort */
  }
}

export async function loadState(): Promise<PersistedState> {
  await ensureDir();
  const file = config.stateFile;

  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // Primary missing — recover from backup before resetting.
      const fromBak = await tryLoadBackup();
      if (fromBak) {
        await saveState(fromBak);
        return fromBak;
      }
      const fresh = defaultState();
      await saveState(fresh);
      return fresh;
    }
    // Operational FS error (EACCES, EIO, ...): surface it, never destroy state.
    throw err;
  }

  try {
    return parseAndNormalize(raw);
  } catch (err) {
    // Newer schema than we support: refuse to downgrade. Leave the file intact and fail
    // loudly rather than resetting (which would discard the user's newer data).
    if ((err as NodeJS.ErrnoException)?.code === 'ESCHEMA_NEWER') throw err;
    // Corrupt primary. Preserve it, then recover from backup.
    await preserveBadFile(file);
    const fromBak = await tryLoadBackup();
    if (fromBak) {
      await saveState(fromBak);
      return fromBak;
    }
    const fresh = defaultState();
    await saveState(fresh);
    return fresh;
  }
}

// Serialize writes so concurrent saveState() calls never interleave.
let writeChain: Promise<unknown> = Promise.resolve();

export function saveState(state: PersistedState): Promise<void> {
  // Snapshot at enqueue time so a later in-place mutation can't be written by this save.
  const snapshot = structuredClone(state);
  const next = writeChain.then(() => atomicWrite(snapshot));
  writeChain = next.catch(() => {}); // keep the chain alive even if one write fails
  return next;
}

async function atomicWrite(state: PersistedState): Promise<void> {
  await ensureDir();
  const file = config.stateFile;
  // Unique name + exclusive create ('wx'): never follow/clobber a stale or symlinked
  // `state.json.tmp`, and don't collide if two instances share a data dir.
  const tmp = `${file}.${process.pid}.${stateTmpSeq++}.tmp`;
  const bak = file + '.bak';
  const data = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2);

  const fh = await fs.open(tmp, 'wx');
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }

  // Keep a backup of the previous good file before replacing it.
  // (Directory-level fsync for power-loss durability is intentionally omitted —
  // low ROI for a single-user local tool; tmp+rename already prevents torn writes.)
  try {
    await fs.copyFile(file, bak);
  } catch {
    /* no prior file yet */
  }
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}
