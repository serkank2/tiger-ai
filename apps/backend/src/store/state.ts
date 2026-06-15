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

export async function loadState(): Promise<PersistedState> {
  await ensureDir();
  const file = config.stateFile;
  try {
    const raw = await fs.readFile(file, 'utf8');
    return normalize(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      const fresh = defaultState();
      await saveState(fresh);
      return fresh;
    }
    // Corrupt or unreadable: try the backup, then preserve the bad file and reset.
    try {
      const rawBak = await fs.readFile(file + '.bak', 'utf8');
      return normalize(JSON.parse(rawBak));
    } catch {
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        await fs.rename(file, path.join(config.dataDir, `state.corrupt.${ts}.json`));
      } catch {
        /* nothing to preserve */
      }
      const fresh = defaultState();
      await saveState(fresh);
      return fresh;
    }
  }
}

// Serialize writes so concurrent saveState() calls never interleave.
let writeChain: Promise<unknown> = Promise.resolve();

export function saveState(state: PersistedState): Promise<void> {
  const next = writeChain.then(() => atomicWrite(state));
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
  try {
    await fs.copyFile(file, bak);
  } catch {
    /* no prior file yet */
  }
  await fs.rename(tmp, file);
}
