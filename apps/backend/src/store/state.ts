import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '../config.js';
import type { AppSettings, PersistedState, ShellSpec } from './types.js';

const SCHEMA_VERSION = 1 as const;

export function defaultShell(): ShellSpec {
  return { kind: 'system-default' };
}

export function defaultSettings(): AppSettings {
  return {
    theme: 'system',
    defaultCwd: os.homedir(),
    defaultShell: defaultShell(),
    confirmBeforeKill: true,
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
  return {
    schemaVersion: SCHEMA_VERSION,
    terminals: Array.isArray(p.terminals) ? p.terminals : [],
    groups: Array.isArray(p.groups) ? p.groups : [],
    settings: {
      ...base.settings,
      ...settings,
      defaultShell: settings.defaultShell ?? base.settings.defaultShell,
      commandRouting: {
        ...base.settings.commandRouting,
        ...(settings.commandRouting ?? {}),
      },
    },
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : base.updatedAt,
  };
}

function parseAndNormalize(raw: string): PersistedState {
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
  } catch {
    // Corrupt (or newer-schema) primary. Preserve it, then recover from backup.
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
  const tmp = file + '.tmp';
  const bak = file + '.bak';
  const data = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2);

  const fh = await fs.open(tmp, 'w');
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
  await fs.rename(tmp, file);
}
