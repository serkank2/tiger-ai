import path from 'node:path';
import { config } from '../config.js';
import { HttpError } from '../http/errors.js';

// ---------------------------------------------------------------------------
// Workspace allow-listing / boundary enforcement.
//
// Kaplan launches AI coding agents that read/write the REAL filesystem at a
// client-supplied workspace directory. Without a boundary, a request can point
// a fully-autonomous agent at any directory the server process can reach. This
// module is the single chokepoint that decides whether a workspace path is
// permitted before a run is created or opened.
//
// Two layers:
//   1. Sanity — the path must resolve to a non-empty absolute directory and
//      must not be a UNC/device path. Applied ALWAYS, even when enforcement is
//      off, so obviously bad input never reaches a pty spawn.
//   2. Containment — when `enforceWorkspaceBoundary` is on, the resolved path
//      must live inside one of the allow-listed roots (or the data dir).
//
// Enforcement is OFF by default to preserve the local single-user UX; turning
// it on (KAPLAN_ENFORCE_WORKSPACE=1) locks runs to the configured roots.
// ---------------------------------------------------------------------------

/**
 * True when `child` is the same path as, or nested inside, `parent`. Uses
 * `path.relative` so the comparison is segment-aware: `/data/foobar` is NOT
 * considered inside `/data/foo` (a naive `startsWith` prefix check would wrongly
 * match it), and a `..` escape (`/data/../etc`) is rejected because the relative
 * path then begins with `..`. Both inputs must already be resolved+normalized.
 */
function isInside(parent: string, child: string): boolean {
  if (!parent) return false;
  const rel = path.relative(parent, child);
  // Same dir => rel === ''. Inside => rel has no leading '..' and is not absolute.
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) return false;
  if (path.isAbsolute(rel)) return false; // different drive on Windows
  return true;
}

/**
 * Resolve + normalize a client-supplied workspace path and decide whether it is
 * allowed. Pure: takes the allowlist and data dir explicitly so it is trivially
 * testable. Returns the resolved absolute path on success, or a reason string on
 * failure (callers map this to an HttpError).
 *
 * Semantics:
 *  - Empty / non-string input is rejected.
 *  - UNC / device / posix-network roots (`\\host\share`, `//x`) are rejected.
 *  - The input must be absolute; after `path.resolve` it must stay absolute.
 *  - When `enforce` is false, any sane absolute dir is allowed (local UX).
 *  - When `enforce` is true, the resolved path must be inside one of the
 *    allowlist roots or the data dir.
 */
export function isWorkspaceAllowed(
  dir: unknown,
  allowlist: readonly string[],
  dataDir: string,
  enforce: boolean,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof dir !== 'string' || !dir.trim()) {
    return { ok: false, reason: 'workspace path is required' };
  }
  const raw = dir.trim();
  // Reject UNC / device / posix-network roots outright (defense in depth; these
  // can escape drive-scoped allowlists and confuse containment checks).
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    return { ok: false, reason: 'workspace path must be a local directory' };
  }
  if (!path.isAbsolute(raw)) {
    return { ok: false, reason: 'workspace path must be absolute' };
  }
  const resolved = path.resolve(raw);
  // After resolution it must still be absolute and not a UNC root.
  if (!path.isAbsolute(resolved) || resolved.startsWith('\\\\')) {
    return { ok: false, reason: 'workspace path resolves to an invalid location' };
  }

  if (!enforce) return { ok: true, path: resolved };

  // Enforcement on: the path must live inside an allow-listed root or the data dir.
  const roots = [...allowlist, dataDir].filter((r): r is string => typeof r === 'string' && r.length > 0).map((r) => path.resolve(r));
  if (roots.some((root) => isInside(root, resolved))) {
    return { ok: true, path: resolved };
  }
  return {
    ok: false,
    reason: 'workspace is outside the allowed directories',
  };
}

/**
 * Enforce the workspace boundary using the live `config.security` settings.
 * Returns the resolved absolute path, or throws `HttpError(403, 'workspace_not_allowed')`
 * so the central error handler emits the stable `workspace_not_allowed` code that the
 * frontend reacts to. Bad input that is rejected by the always-on sanity layer also
 * throws this code (it is the closest stable error for "this workspace can't be used").
 */
export function assertWorkspaceAllowed(dir: unknown): string {
  const result = isWorkspaceAllowed(
    dir,
    config.security.workspaceAllowlist,
    config.dataDir,
    config.security.enforceWorkspaceBoundary,
  );
  if (!result.ok) {
    throw new HttpError(403, 'workspace_not_allowed', result.reason);
  }
  return result.path;
}
