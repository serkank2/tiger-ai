import os from 'node:os';
import path from 'node:path';

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

function parseOrigins(): string[] {
  const raw = process.env.KAPLAN_CORS_ORIGINS;
  if (raw && raw.trim()) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ['http://localhost:3000', 'http://127.0.0.1:3000'];
}

export const config = {
  host: process.env.KAPLAN_HOST || '127.0.0.1',
  port: Number(process.env.KAPLAN_PORT || 4517),
  dataDir,
  stateFile: path.join(dataDir, 'state.json'),
  corsOrigins: parseOrigins(),

  // pty output coalescing + scrollback
  outputFlushMs: 16,
  outputFlushBytes: 32 * 1024,
  scrollbackBytes: 256 * 1024,

  // graceful-stop window before force kill
  stopTimeoutMs: 2500,
};

export type Config = typeof config;
