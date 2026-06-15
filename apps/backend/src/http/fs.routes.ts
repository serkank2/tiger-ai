import { Router } from 'express';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppCtx } from '../context.js';

/** Filesystem helpers for the cwd picker (validate a path, browse directories). */
export function createFsRouter(_ctx: AppCtx): Router {
  const router = Router();

  router.get('/home', (_req, res) => {
    res.json({ home: os.homedir(), sep: path.sep });
  });

  router.get('/validate', async (req, res) => {
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    if (!p) {
      res.status(400).json({ error: { message: 'path query param is required' } });
      return;
    }
    try {
      const st = await fsp.stat(p);
      res.json({ path: p, exists: true, isDirectory: st.isDirectory() });
    } catch {
      res.json({ path: p, exists: false, isDirectory: false });
    }
  });

  router.get('/list', async (req, res) => {
    const p = typeof req.query.path === 'string' && req.query.path ? req.query.path : os.homedir();
    try {
      const entries = await fsp.readdir(p, { withFileTypes: true });
      const directories = entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: path.join(p, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ path: p, parent: path.dirname(p), directories });
    } catch (err) {
      res.status(400).json({ error: { message: err instanceof Error ? err.message : 'cannot read directory' } });
    }
  });

  return router;
}
