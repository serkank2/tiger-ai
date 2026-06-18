import { Router } from 'express';
import type { AppCtx } from '../context.js';

export function createLimitsRouter(ctx: AppCtx): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(ctx.limits.getState());
  });

  router.post('/refresh', async (_req, res) => {
    res.json(await ctx.limits.refresh('manual'));
  });

  return router;
}
