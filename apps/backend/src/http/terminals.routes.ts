import { Router } from 'express';
import { nanoid } from 'nanoid';
import type { AppCtx } from '../context.js';
import type { TerminalDefinition, TerminalRuntimeStatus } from '../store/types.js';
import { isStringRecord, nonEmptyString, normalizeShell, toFiniteNumber } from './validate.js';

function statusOf(ctx: AppCtx, def: TerminalDefinition): TerminalRuntimeStatus {
  return (
    ctx.manager.getStatus(def.id) ?? {
      id: def.id,
      state: 'stopped',
      cols: 80,
      rows: 30,
      exitCode: null,
    }
  );
}

export function createTerminalsRouter(ctx: AppCtx): Router {
  const router = Router();

  // List definitions merged with live runtime status.
  router.get('/', (_req, res) => {
    res.json(ctx.state.terminals.map((def) => ({ ...def, status: statusOf(ctx, def) })));
  });

  router.get('/:id', (req, res) => {
    const def = ctx.state.terminals.find((t) => t.id === req.params.id);
    if (!def) {
      res.status(404).json({ error: { message: 'terminal not found' } });
      return;
    }
    res.json({ ...def, status: statusOf(ctx, def) });
  });

  router.post('/', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = nonEmptyString(body.name);
    if (!name) {
      res.status(400).json({ error: { message: 'name is required' } });
      return;
    }
    const now = new Date().toISOString();
    const def: TerminalDefinition = {
      id: nanoid(),
      name,
      groupId: typeof body.groupId === 'string' ? body.groupId : null,
      cwd: nonEmptyString(body.cwd) ?? ctx.state.settings.defaultCwd,
      initialCommand: typeof body.initialCommand === 'string' ? body.initialCommand : undefined,
      shell: normalizeShell(body.shell) ?? ctx.state.settings.defaultShell,
      env: isStringRecord(body.env) ? body.env : undefined,
      autostart: Boolean(body.autostart),
      createdAt: now,
      updatedAt: now,
    };
    ctx.state.terminals.push(def);
    ctx.manager.upsertDefinition(def);
    await ctx.save();
    res.status(201).json({ ...def, status: statusOf(ctx, def) });
  });

  router.put('/:id', async (req, res) => {
    const def = ctx.state.terminals.find((t) => t.id === req.params.id);
    if (!def) {
      res.status(404).json({ error: { message: 'terminal not found' } });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = nonEmptyString(body.name);
    if (name) def.name = name;
    if ('groupId' in body) def.groupId = typeof body.groupId === 'string' ? body.groupId : null;
    const cwd = nonEmptyString(body.cwd);
    if (cwd) def.cwd = cwd;
    if ('initialCommand' in body) {
      def.initialCommand = typeof body.initialCommand === 'string' ? body.initialCommand : undefined;
    }
    if (body.shell) {
      const shell = normalizeShell(body.shell);
      if (shell) def.shell = shell;
    }
    if ('env' in body) def.env = isStringRecord(body.env) ? body.env : undefined;
    if ('autostart' in body) def.autostart = Boolean(body.autostart);
    def.updatedAt = new Date().toISOString();

    ctx.manager.upsertDefinition(def);
    await ctx.save();
    res.json({ ...def, status: statusOf(ctx, def) });
  });

  router.delete('/:id', async (req, res) => {
    const idx = ctx.state.terminals.findIndex((t) => t.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: { message: 'terminal not found' } });
      return;
    }
    await ctx.manager.remove(req.params.id);
    ctx.state.terminals.splice(idx, 1);
    await ctx.save();
    res.status(204).end();
  });

  // --- lifecycle ---

  const exists = (ctx: AppCtx, id: string) => ctx.state.terminals.some((t) => t.id === id);

  router.post('/:id/start', async (req, res) => {
    if (!exists(ctx, req.params.id)) {
      res.status(404).json({ error: { message: 'terminal not found' } });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = await ctx.manager.start(req.params.id, toFiniteNumber(body.cols), toFiniteNumber(body.rows));
    res.json(status);
  });

  router.post('/:id/stop', async (req, res) => {
    if (!exists(ctx, req.params.id)) {
      res.status(404).json({ error: { message: 'terminal not found' } });
      return;
    }
    const status = await ctx.manager.stop(req.params.id);
    res.json(status);
  });

  router.post('/:id/restart', async (req, res) => {
    if (!exists(ctx, req.params.id)) {
      res.status(404).json({ error: { message: 'terminal not found' } });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = await ctx.manager.restart(req.params.id, toFiniteNumber(body.cols), toFiniteNumber(body.rows));
    res.json(status);
  });

  return router;
}
