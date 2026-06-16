import { Router } from 'express';
import type { AppCtx } from '../context.js';
import { normalizeShell } from './validate.js';

export function createSettingsRouter(ctx: AppCtx): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(ctx.state.settings);
  });

  router.put('/', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const s = ctx.state.settings;

    if (typeof body.theme === 'string' && body.theme.trim()) {
      s.theme = body.theme.trim();
    }
    if (typeof body.defaultCwd === 'string' && body.defaultCwd.trim()) {
      s.defaultCwd = body.defaultCwd;
    }
    if (body.defaultShell) {
      const shell = normalizeShell(body.defaultShell);
      if (shell) s.defaultShell = shell;
    }
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
