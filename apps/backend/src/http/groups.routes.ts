import { Router } from 'express';
import { nanoid } from 'nanoid';
import type { AppCtx } from '../context.js';
import type { TerminalGroup } from '../store/types.js';
import { nonEmptyString } from './validate.js';

export function createGroupsRouter(ctx: AppCtx): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(ctx.state.groups);
  });

  router.post('/', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = nonEmptyString(body.name);
    if (!name) {
      res.status(400).json({ error: { message: 'name is required' } });
      return;
    }
    const group: TerminalGroup = {
      id: nanoid(),
      name,
      color: typeof body.color === 'string' ? body.color : undefined,
    };
    ctx.state.groups.push(group);
    await ctx.save();
    res.status(201).json(group);
  });

  router.put('/:id', async (req, res) => {
    const group = ctx.state.groups.find((g) => g.id === req.params.id);
    if (!group) {
      res.status(404).json({ error: { message: 'group not found' } });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = nonEmptyString(body.name);
    if (name) group.name = name;
    if ('color' in body) group.color = typeof body.color === 'string' ? body.color : undefined;
    await ctx.save();
    res.json(group);
  });

  router.delete('/:id', async (req, res) => {
    const idx = ctx.state.groups.findIndex((g) => g.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: { message: 'group not found' } });
      return;
    }
    ctx.state.groups.splice(idx, 1);
    // Unassign terminals that belonged to this group.
    for (const t of ctx.state.terminals) {
      if (t.groupId === req.params.id) {
        t.groupId = null;
        ctx.manager.upsertDefinition(t);
      }
    }
    await ctx.save();
    res.status(204).end();
  });

  return router;
}
