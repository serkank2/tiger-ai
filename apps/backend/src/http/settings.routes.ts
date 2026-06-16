import { Router } from 'express';
import type { AppCtx } from '../context.js';
import { normalizeShell } from './validate.js';
import { resolveExistingDir } from '../util/paths.js';
import type { ShellSpec } from '../store/types.js';

export function createSettingsRouter(ctx: AppCtx): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(ctx.state.settings);
  });

  router.put('/', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const s = ctx.state.settings;

    // validate before mutating anything
    let defaultCwd: string | undefined;
    if (typeof body.defaultCwd === 'string' && body.defaultCwd.trim()) {
      const check = await resolveExistingDir(body.defaultCwd);
      if (!check.ok) {
        res.status(400).json({ error: { message: `invalid defaultCwd: ${check.reason}` } });
        return;
      }
      defaultCwd = check.path;
    }
    let defaultShell: ShellSpec | undefined;
    if (body.defaultShell !== undefined) {
      const shell = normalizeShell(body.defaultShell);
      if (!shell) {
        res.status(400).json({ error: { message: 'invalid defaultShell' } });
        return;
      }
      defaultShell = shell;
    }

    if (typeof body.theme === 'string' && body.theme.trim()) {
      s.theme = body.theme.trim();
    }
    if (defaultCwd) s.defaultCwd = defaultCwd;
    if (defaultShell) s.defaultShell = defaultShell;
    if (body.commandRouting && typeof body.commandRouting === 'object') {
      const cr = body.commandRouting as Record<string, unknown>;
      if (typeof cr.appendNewlineByDefault === 'boolean') {
        s.commandRouting.appendNewlineByDefault = cr.appendNewlineByDefault;
      }
      if (typeof cr.startTerminalOnSend === 'boolean') {
        s.commandRouting.startTerminalOnSend = cr.startTerminalOnSend;
      }
    }

    await ctx.save();
    res.json(s);
  });

  return router;
}
