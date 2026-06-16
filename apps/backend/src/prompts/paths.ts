import path from 'node:path';
import { promises as fs } from 'node:fs';
import { config } from '../config.js';

export const MAX_PROMPT_BYTES = 128 * 1024;

export type Resolved = { ok: true; abs: string; rel: string } | { ok: false; reason: string };

/**
 * Resolve a client-supplied relative prompt path to an absolute path inside the
 * prompts dir, or reject it. Rejects absolute/UNC/drive paths, `..`/`.`/empty
 * segments, control chars, non-.md, anything resolving outside the root, and symlinks.
 */
export async function resolvePromptPath(rel: unknown): Promise<Resolved> {
  if (typeof rel !== 'string' || !rel.trim()) return { ok: false, reason: 'path required' };
  const r = rel.trim().replace(/\\/g, '/');
  if (r.startsWith('/') || /^[a-zA-Z]:/.test(r)) return { ok: false, reason: 'absolute path' };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(r)) return { ok: false, reason: 'control char' };
  if (r.split('/').some((s) => s === '' || s === '.' || s === '..')) return { ok: false, reason: 'invalid segment' };
  if (!r.toLowerCase().endsWith('.md')) return { ok: false, reason: 'must be .md' };

  const root = await fs.realpath(config.promptsDir).catch(() => path.resolve(config.promptsDir));
  const abs = path.resolve(root, r);
  const inside = (p: string): boolean => {
    const rel2 = path.relative(root, p);
    return rel2 === '' || (!rel2.startsWith('..') && !path.isAbsolute(rel2));
  };
  if (!inside(abs)) return { ok: false, reason: 'outside prompts dir' };
  // Reject symlinked/junction ancestors: the real path of the deepest existing parent
  // must still resolve inside the root (the final-component lstat below is not enough).
  const realParent = await fs.realpath(path.dirname(abs)).catch(() => null);
  if (realParent && !inside(realParent)) return { ok: false, reason: 'symlinked outside prompts dir' };
  try {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  } catch {
    /* missing target is fine (e.g. create) */
  }
  return { ok: true, abs, rel: r };
}
