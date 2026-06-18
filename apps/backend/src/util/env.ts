import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tiny, dependency-free `.env` loader.
 *
 * Secrets (notably the MySQL root password) must live only in a gitignored local
 * file, never in committed source. We load `apps/backend/.env` and, as a fallback,
 * the repo-root `.env`. Real process environment variables always win, so the file
 * only fills in values that aren't already set — and CI/production can override
 * everything via the real environment without touching the file.
 */

const utilDir = path.dirname(fileURLToPath(import.meta.url)); // apps/backend/src/util
// Candidates in precedence order: backend-local first, then repo root.
const candidates = [
  path.resolve(utilDir, '..', '..', '.env'), // apps/backend/.env
  path.resolve(utilDir, '..', '..', '..', '..', '.env'), // <repo>/.env
];

/** Parse a single `.env` line into [key, value] or null (blank/comment/invalid). */
function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
  const eq = withoutExport.indexOf('=');
  if (eq <= 0) return null;
  const key = withoutExport.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let value = withoutExport.slice(eq + 1).trim();
  // Strip matching surrounding quotes; leave unquoted values (incl. inline `#`) as-is.
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

let loaded = false;

/**
 * Load local `.env` files into `process.env` (existing vars are never overwritten).
 * Idempotent: safe to call from multiple modules; only the first call does work.
 */
export function loadDotEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const file of candidates) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue; // absent/unreadable — fine, just try the next candidate
    }
    for (const line of raw.split(/\r?\n/)) {
      const kv = parseLine(line);
      if (!kv) continue;
      const [key, value] = kv;
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
