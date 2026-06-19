import { Router } from 'express';
import { nanoid } from 'nanoid';
import type { AppCtx } from '../context.js';
import type { TerminalGroup } from '../store/types.js';
import { isValidColor, nonEmptyString } from './validate.js';
import { badRequest, notFound } from './errors.js';
import { TIGER_GROUP_NAME_MAX_CHARS } from '../orchestrator/config.js';

export function createGroupsRouter(ctx: AppCtx): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(ctx.state.groups);
  });

  router.post('/', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = nonEmptyString(body.name);
    if (!name) throw badRequest('name is required');
    if (name.length > TIGER_GROUP_NAME_MAX_CHARS) {
      throw badRequest(`name must be ${TIGER_GROUP_NAME_MAX_CHARS} characters or fewer`);
    }
    const group: TerminalGroup = {
      id: nanoid(),
      name,
      color: isValidColor(body.color) ? body.color.trim() : undefined,
    };
    ctx.state.groups.push(group);
    await ctx.save();
    res.status(201).json(group);
  });

  router.put('/:id', async (req, res) => {
    const group = ctx.state.groups.find((g) => g.id === req.params.id);
    if (!group) throw notFound('group not found');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = nonEmptyString(body.name);
    if (name && name.length > TIGER_GROUP_NAME_MAX_CHARS) {
      throw badRequest(`name must be ${TIGER_GROUP_NAME_MAX_CHARS} characters or fewer`);
    }
    if (name) group.name = name;
    if ('color' in body) group.color = isValidColor(body.color) ? body.color.trim() : undefined;
    await ctx.save();
    res.json(group);
  });

  router.delete('/:id', async (req, res) => {
    const idx = ctx.state.groups.findIndex((g) => g.id === req.params.id);
    if (idx === -1) throw notFound('group not found');
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
