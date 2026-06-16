import { Router } from 'express';
import type { AppCtx } from '../context.js';
import { listPrompts, readPrompt, writePrompt, deletePrompt, renamePrompt } from '../prompts/store.js';

/**
 * Prompt library API over the prompts dir. Thrown errors carry `.status` and are
 * formatted by the central error handler. Sending is NOT here — the composer renders
 * variables client-side and reuses the existing WS command broadcast.
 */
export function createPromptsRouter(_ctx: AppCtx): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json({ items: await listPrompts() });
  });

  router.get('/file', async (req, res) => {
    res.json(await readPrompt(String(req.query.path ?? '')));
  });

  router.post('/', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.path !== 'string' || typeof b.content !== 'string') {
      res.status(400).json({ error: { message: 'path and content must be strings' } });
      return;
    }
    const out = await writePrompt(b.path, b.content, { create: true, overwrite: b.overwrite === true });
    res.status(201).json(out);
  });

  router.put('/file', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.path !== 'string' || typeof b.content !== 'string') {
      res.status(400).json({ error: { message: 'path and content must be strings' } });
      return;
    }
    const out = await writePrompt(b.path, b.content, {
      expectedVersion: typeof b.expectedVersion === 'string' ? b.expectedVersion : undefined,
    });
    res.json(out);
  });

  router.delete('/file', async (req, res) => {
    await deletePrompt(String(req.query.path ?? ''));
    res.status(204).end();
  });

  router.post('/rename', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const out = await renamePrompt(String(b.fromPath ?? ''), String(b.toPath ?? ''), {
      overwrite: b.overwrite === true,
    });
    res.json(out);
  });

  return router;
}
