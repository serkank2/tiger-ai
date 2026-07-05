import { Router } from 'express';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppCtx } from '../context.js';
import { config } from '../config.js';
import { isWorkspaceAllowed } from '../security/workspace.js';
import { safeDirPath as safePath } from '../util/paths.js';
import { badRequest, forbidden, httpError, notFound } from './errors.js';

/** Filesystem helpers for the cwd picker (validate a path, browse directories). */
export function createFsRouter(_ctx: AppCtx): Router {
  const router = Router();

  // Under KAPLAN_ENFORCE_WORKSPACE the picker must not enumerate the whole host —
  // it is scoped to the same allow-listed roots that gate a run's workspace.
  const enforced = (): boolean => config.security.enforceWorkspaceBoundary;
  const pickerAllowed = (p: string): boolean =>
    !enforced() || isWorkspaceAllowed(p, config.security.workspaceAllowlist, config.dataDir, true).ok;
  const pickerRoot = (): string => (enforced() && config.security.workspaceAllowlist[0]) || os.homedir();

  router.get('/home', (_req, res) => {
    res.json({ home: pickerRoot(), sep: path.sep });
  });

  router.get('/validate', async (req, res) => {
    const p = safePath(req.query.path);
    if (!p) throw badRequest('an absolute local directory path is required');
    if (!pickerAllowed(p)) throw forbidden('path is outside the allowed directories');
    try {
      const st = await fsp.stat(p);
      res.json({ path: p, exists: true, isDirectory: st.isDirectory() });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        res.json({ path: p, exists: false, isDirectory: false });
        return;
      }
      // Don't leak raw OS message (contains absolute paths); map to a stable error code.
      throw code === 'EACCES' || code === 'EPERM' ? forbidden('cannot access path') : badRequest('cannot access path');
    }
  });

  router.get('/list', async (req, res) => {
    const p = req.query.path === undefined ? pickerRoot() : safePath(req.query.path);
    if (!p) throw badRequest('an absolute local directory path is required');
    if (!pickerAllowed(p)) throw forbidden('path is outside the allowed directories');
    try {
      const entries = await fsp.readdir(p, { withFileTypes: true });
      const directories = entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: path.join(p, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ path: p, parent: path.dirname(p), directories });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // static msg; no path leak. Map OS errno to a stable error code.
      if (code === 'ENOENT') throw notFound('cannot read directory');
      if (code === 'EACCES' || code === 'EPERM') throw forbidden('cannot read directory');
      throw httpError(400, 'bad_request', 'cannot read directory');
    }
  });

  return router;
}
