import { Router } from 'express';
import type { AppCtx } from '../context.js';
import { LimitRuleValidationError, type LimitRuleInput } from '../services/LimitService.js';
import { badRequest, notFound } from './errors.js';

export function createLimitsRouter(ctx: AppCtx): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(ctx.limits.getState());
  });

  router.post('/refresh', async (_req, res) => {
    res.json(await ctx.limits.refresh('manual'));
  });

  // --- Limit-rules CRUD ---
  router.get('/rules', (_req, res) => {
    res.json(ctx.limits.listRules());
  });

  router.post('/rules', async (req, res) => {
    try {
      res.status(201).json(await ctx.limits.createRule((req.body ?? {}) as LimitRuleInput));
    } catch (err) {
      sendRuleError(res, err);
    }
  });

  router.put('/rules/:id', async (req, res) => {
    try {
      res.json(await ctx.limits.updateRule(req.params.id, (req.body ?? {}) as LimitRuleInput));
    } catch (err) {
      sendRuleError(res, err);
    }
  });

  router.delete('/rules/:id', async (req, res) => {
    res.json(await ctx.limits.deleteRule(req.params.id));
  });

  return router;
}

function sendRuleError(_res: import('express').Response, err: unknown): never {
  if (err instanceof LimitRuleValidationError) {
    throw /not found/i.test(err.message) ? notFound(err.message) : badRequest(err.message);
  }
  throw err;
}
