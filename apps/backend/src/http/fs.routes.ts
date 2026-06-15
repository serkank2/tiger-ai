import { Router } from 'express';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppCtx } from '../context.js';

/**
 * Accept only absolute local directory paths. Reject relative paths (which would
 * resolve against the backend cwd) and Windows UNC/device paths like \\host\share
 * or \\?\... (a crafted localhost request could otherwise trigger outbound access).
 */
function safePath(input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim()) return null;
  const raw = input.trim();
  if (process.platform === 'win32' && (raw.startsWith('\\\\') || raw.startsWith('//'))) return null;
  if (!path.isAbsolute(raw)) return null;
  const resolved = path.resolve(raw);
  if (process.platform === 'win32' && resolved.startsWith('\\\\')) return null;
  return resolved;
}

/** Filesystem helpers for the cwd picker (validate a path, browse directories). */
export function createFsRouter(_ctx: AppCtx): Router {
  const router = Router();

  router.get('/home', (_req, res) => {
    res.json({ home: os.homedir(), sep: path.sep });
  });

  router.get('/validate', async (req, res) => {
    const p = safePath(req.query.path);
    if (!p) {
      res.status(400).json({ error: { message: 'an absolute local directory path is required' } });
      return;
    }
    try {
      const st = await fsp.stat(p);
      res.json({ path: p, exists: true, isDirectory: st.isDirectory() });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        res.json({ path: p, exists: false, isDirectory: false });
        return;
      }
      res.status(code === 'EACCES' || code === 'EPERM' ? 403 : 400).json({
        error: { message: err instanceof Error ? err.message : 'cannot access path', code },
      });
    }
  });

  router.get('/list', async (req, res) => {
    const p = req.query.path === undefined ? os.homedir() : safePath(req.query.path);
    if (!p) {
      res.status(400).json({ error: { message: 'an absolute local directory path is required' } });
      return;
    }
    try {
      const entries = await fsp.readdir(p, { withFileTypes: true });
      const directories = entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: path.join(p, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ path: p, parent: path.dirname(p), directories });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const status = code === 'ENOENT' ? 404 : code === 'EACCES' || code === 'EPERM' ? 403 : 400;
      res.status(status).json({ error: { message: err instanceof Error ? err.message : 'cannot read directory', code } });
    }
  });

  return router;
}
