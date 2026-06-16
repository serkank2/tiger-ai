import { Router } from 'express';
import { nanoid } from 'nanoid';
import type { AppCtx } from '../context.js';
import type { TerminalDefinition, TerminalRuntimeStatus } from '../store/types.js';
import { asBool, isStringRecord, nonEmptyString, normalizeShell, toDimension } from './validate.js';
import { resolveExistingDir } from '../util/paths.js';

/** Validate a groupId payload: must be null/absent or reference an existing group. */
function resolveGroupId(ctx: AppCtx, raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw === 'string' && ctx.state.groups.some((g) => g.id === raw)) return { ok: true, value: raw };
  return { ok: false };
}

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

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|[\r\b]/g;

/** Last non-empty line of a terminal's scrollback, cleaned for a sidebar preview. */
function tail(buffer: string, max = 160): string {
  if (!buffer) return '';
  const clean = buffer.replace(ANSI, '\n');
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1]! : '';
  return last.length > max ? last.slice(last.length - max) : last;
}

/** Definition + live status + a short last-output preview. */
function present(ctx: AppCtx, def: TerminalDefinition) {
  return { ...def, status: statusOf(ctx, def), lastOutput: tail(ctx.manager.getBuffer(def.id)) };
}

export function createTerminalsRouter(ctx: AppCtx): Router {
  const router = Router();

  // List definitions merged with live runtime status.
  router.get('/', (_req, res) => {
    res.json(ctx.state.terminals.map((def) => (present(ctx, def))));
  });

  router.get('/:id', (req, res) => {
    const def = ctx.state.terminals.find((t) => t.id === req.params.id);
    if (!def) {
      res.status(404).json({ error: { message: 'terminal not found' } });
      return;
    }
    res.json(present(ctx, def));
  });

  router.post('/', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = nonEmptyString(body.name);
    if (!name) {
      res.status(400).json({ error: { message: 'name is required' } });
      return;
    }
    const group = resolveGroupId(ctx, body.groupId);
    if (!group.ok) {
      res.status(400).json({ error: { message: 'invalid groupId' } });
      return;
    }
    const cwdCheck = await resolveExistingDir(nonEmptyString(body.cwd) ?? ctx.state.settings.defaultCwd);
    if (!cwdCheck.ok) {
      res.status(400).json({ error: { message: `invalid working directory: ${cwdCheck.reason}` } });
      return;
    }
    let shell = ctx.state.settings.defaultShell;
    if (body.shell !== undefined) {
      const s = normalizeShell(body.shell);
      if (!s) {
        res.status(400).json({ error: { message: 'invalid shell' } });
        return;
      }
      shell = s;
    }
    if (body.env != null && !isStringRecord(body.env)) {
      res.status(400).json({ error: { message: 'env must be a map of string values' } });
      return;
    }
    if (typeof body.initialCommand === 'string' && body.initialCommand.length > 8192) {
      res.status(400).json({ error: { message: 'initialCommand too long (max 8192 chars)' } });
      return;
    }
    const now = new Date().toISOString();
    const def: TerminalDefinition = {
      id: nanoid(),
      name,
      groupId: group.value,
      cwd: cwdCheck.path,
      initialCommand: typeof body.initialCommand === 'string' ? body.initialCommand : undefined,
      shell,
      env: isStringRecord(body.env) ? body.env : undefined,
      autostart: asBool(body.autostart),
      createdAt: now,
      updatedAt: now,
    };
    ctx.state.terminals.push(def);
    ctx.manager.upsertDefinition(def);
    await ctx.save();
    res.status(201).json(present(ctx, def));
  });

  router.put('/:id', async (req, res) => {
    const def = ctx.state.terminals.find((t) => t.id === req.params.id);
    if (!def) {
      res.status(404).json({ error: { message: 'terminal not found' } });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Validate everything into a patch FIRST; only apply once all checks pass, so a
    // rejected request can never partially mutate the live definition.
    const patch: Partial<TerminalDefinition> = {};

    const name = nonEmptyString(body.name);
    if (name) patch.name = name;
    if ('groupId' in body) {
      const group = resolveGroupId(ctx, body.groupId);
      if (!group.ok) {
        res.status(400).json({ error: { message: 'invalid groupId' } });
        return;
      }
      patch.groupId = group.value;
    }
    if (nonEmptyString(body.cwd)) {
      const cwdCheck = await resolveExistingDir(body.cwd);
      if (!cwdCheck.ok) {
        res.status(400).json({ error: { message: `invalid working directory: ${cwdCheck.reason}` } });
        return;
      }
      patch.cwd = cwdCheck.path;
    }
    if ('initialCommand' in body) {
      if (typeof body.initialCommand === 'string' && body.initialCommand.length > 8192) {
        res.status(400).json({ error: { message: 'initialCommand too long (max 8192 chars)' } });
        return;
      }
      patch.initialCommand = typeof body.initialCommand === 'string' ? body.initialCommand : undefined;
    }
    if (body.shell !== undefined) {
      const shell = normalizeShell(body.shell);
      if (!shell) {
        res.status(400).json({ error: { message: 'invalid shell' } });
        return;
      }
      patch.shell = shell;
    }
    if ('env' in body) {
      if (body.env != null && !isStringRecord(body.env)) {
        res.status(400).json({ error: { message: 'env must be a map of string values' } });
        return;
      }
      patch.env = isStringRecord(body.env) ? body.env : undefined;
    }
    if ('autostart' in body) patch.autostart = asBool(body.autostart);

    // Re-resolve after the await(s): a concurrent DELETE could have removed this terminal
    // while we were validating, and mutating the stale object would re-insert a ghost
    // definition into the manager (manager/state divergence).
    const current = ctx.state.terminals.find((t) => t.id === req.params.id);
    if (!current) {
      res.status(404).json({ error: { message: 'terminal not found' } });
      return;
    }
    Object.assign(current, patch);
    current.updatedAt = new Date().toISOString();
    ctx.manager.upsertDefinition(current);
    await ctx.save();
    res.json(present(ctx, current));
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
    const status = await ctx.manager.start(req.params.id, toDimension(body.cols), toDimension(body.rows));
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
    const status = await ctx.manager.restart(req.params.id, toDimension(body.cols), toDimension(body.rows));
    res.json(status);
  });

  return router;
}
