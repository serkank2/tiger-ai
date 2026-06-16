import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * Accept only fully-qualified LOCAL directory paths. Rejects relative paths,
 * Windows root-relative paths (\Windows), and UNC/device paths (\\host\share,
 * \\?\...). Returns the normalized absolute path, or null if unacceptable.
 *
 * Shared by the fs browse/validate routes, terminal create/update, and (defense
 * in depth) the cwd check before spawning a pty — so validation and launch agree.
 */
export function safeDirPath(input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim()) return null;
  const raw = input.trim();
  // UNC / device / posix-network roots
  if (raw.startsWith('\\\\') || raw.startsWith('//')) return null;
  if (!path.isAbsolute(raw)) return null;
  if (process.platform === 'win32' && !/^[a-zA-Z]:[\\/]/.test(raw)) return null; // require a drive letter
  const resolved = path.resolve(raw);
  if (resolved.startsWith('\\\\')) return null;
  return resolved;
}

export type DirCheck = { ok: true; path: string } | { ok: false; reason: string };

/** safeDirPath + confirm it exists and is a directory. */
export async function resolveExistingDir(input: unknown): Promise<DirCheck> {
  const p = safeDirPath(input);
  if (!p) return { ok: false, reason: 'must be an absolute local directory path' };
  try {
    const st = await fsp.stat(p);
    if (!st.isDirectory()) return { ok: false, reason: 'path is not a directory' };
    return { ok: true, path: p };
  } catch {
    return { ok: false, reason: 'directory does not exist' };
  }
}
