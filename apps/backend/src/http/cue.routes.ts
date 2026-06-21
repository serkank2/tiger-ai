import { Router } from 'express';
import type { AppCtx } from '../context.js';
import { CueConfigError, CueNotFoundError, type CueEngine } from '../cue/CueEngine.js';
import { badRequest, conflict, notFound } from './errors.js';

/**
 * REST surface for the Cue engine. The router is mounted even when Cue is disabled so a probing
 * client gets the stable 409 disabled signal instead of a 404; the engine itself is still only
 * constructed when `config.cue.enabled` is set.
 */
export function createCueRouter(ctx: AppCtx, getEngine: () => CueEngine | null): Router {
  const router = Router();

  const requireEngine = (): CueEngine => {
    const engine = getEngine();
    if (!engine) throw conflict('cue engine is not enabled');
    return engine;
  };

  // List subscriptions (engine status carries them).
  router.get('/subscriptions', (_req, res) => {
    res.json({ subscriptions: requireEngine().getStatus().subscriptions });
  });

  // Engine status (running flag, workspace, config path, per-sub status).
  router.get('/status', (_req, res) => {
    res.json(requireEngine().getStatus());
  });

  // Reload the config from disk and re-attach watchers.
  router.post('/reload', async (_req, res) => {
    const status = await requireEngine().reload();
    res.json(status);
  });

  // Fetch one subscription's full editable config (all fields, for the edit form).
  router.get('/subscriptions/:id', async (req, res) => {
    const id = req.params.id;
    if (!id) throw badRequest('subscription id is required');
    const subscription = await requireEngine().getEditableSubscription(id);
    if (!subscription) throw notFound(`subscription "${id}" not found`);
    res.json({ subscription });
  });

  // Create a new subscription (writes .kaplan/cue.json, then reloads).
  router.post('/subscriptions', async (req, res) => {
    try {
      const { subscription, status } = await requireEngine().saveSubscription(req.body ?? {});
      res.status(201).json({ subscription, status });
    } catch (err) {
      throw toCueHttpError(err);
    }
  });

  // Update an existing subscription by id (rename allowed via the body's id).
  router.put('/subscriptions/:id', async (req, res) => {
    const id = req.params.id;
    if (!id) throw badRequest('subscription id is required');
    try {
      const { subscription, status } = await requireEngine().saveSubscription(req.body ?? {}, id);
      res.json({ subscription, status });
    } catch (err) {
      throw toCueHttpError(err);
    }
  });

  // Delete a subscription by id.
  router.delete('/subscriptions/:id', async (req, res) => {
    const id = req.params.id;
    if (!id) throw badRequest('subscription id is required');
    try {
      const status = await requireEngine().deleteSubscription(id);
      res.json(status);
    } catch (err) {
      throw toCueHttpError(err);
    }
  });

  // Manually fire a cli.trigger subscription.
  router.post('/trigger/:id', async (req, res) => {
    const id = req.params.id;
    if (!id) throw badRequest('subscription id is required');
    const body = (req.body ?? {}) as { vars?: unknown };
    const extra =
      body.vars && typeof body.vars === 'object' && !Array.isArray(body.vars)
        ? sanitizeVars(body.vars as Record<string, unknown>)
        : undefined;
    try {
      const status = await requireEngine().triggerManual(id, extra);
      res.status(202).json(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) throw notFound(message);
      if (message.includes('is disabled') || message.includes('not a cli.trigger')) throw conflict(message);
      throw err;
    }
  });

  return router;
}

/** Map a Cue engine mutation error to the right HTTP status. */
function toCueHttpError(err: unknown): Error {
  if (err instanceof CueNotFoundError) return notFound(err.message);
  if (err instanceof CueConfigError) {
    return err.message.includes('already exists') ? conflict(err.message) : badRequest(err.message);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Coerce a free-form vars object to string→string for safe template substitution. */
function sanitizeVars(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (/^[A-Z0-9_]+$/.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      out[k] = String(v);
    }
  }
  return out;
}
