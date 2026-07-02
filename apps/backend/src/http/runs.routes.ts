import { Router } from 'express';
import type { AppCtx } from '../context.js';
import { badRequest, conflict, notFound } from './errors.js';
import { assertWorkspaceAllowed } from '../security/workspace.js';
import type { RunConfig } from '../run/types.js';

/**
 * REST control plane for v2 runs (docs/REDESIGN.md §5). Side-effecting
 * create/start/stop/steer live here; live progress is pushed over the WS as
 * `run.state` / `run.event` frames — the client never polls for live data.
 */
export function createRunsRouter(ctx: AppCtx): Router {
  const router = Router();
  const engine = ctx.runEngine;

  // Create a run (does not start it): { workspace, goal, config? }.
  router.post('/', async (req, res) => {
    const body = (req.body ?? {}) as { workspace?: unknown; goal?: unknown; config?: unknown };
    if (typeof body.goal !== 'string' || !body.goal.trim()) throw badRequest('goal is required');
    if (typeof body.workspace !== 'string' || !body.workspace.trim()) throw badRequest('workspace is required');
    const workspace = assertWorkspaceAllowed(body.workspace);
    const config = sanitizeConfig(body.config);
    try {
      const snapshot = await engine.createRun({ workspace, goal: body.goal.trim(), config });
      res.status(201).json({ run: snapshot });
    } catch (err) {
      throw conflict(err instanceof Error ? err.message : String(err));
    }
  });

  // Current run snapshot (single-active-run model, mirroring the Team engine).
  router.get('/current', (_req, res) => {
    res.json({ run: engine.getSnapshot() });
  });

  router.post('/current/start', (_req, res) => {
    requireRun(engine.getSnapshot());
    res.json({ run: engine.start() });
  });

  router.post('/current/stop', async (req, res) => {
    requireRun(engine.getSnapshot());
    const reason =
      typeof (req.body as { reason?: unknown })?.reason === 'string'
        ? (req.body as { reason: string }).reason
        : undefined;
    res.json({ run: await engine.stop(reason) });
  });

  // Steering: persisted immediately, applied at the next graph boundary as a re-plan.
  router.post('/current/steer', async (req, res) => {
    requireRun(engine.getSnapshot());
    const body = (req.body ?? {}) as { body?: unknown };
    if (typeof body.body !== 'string' || !body.body.trim()) throw badRequest('steering body is required');
    res.json({ run: await engine.steer(body.body) });
  });

  // Event log replay for reconnect/reopen: ?afterSeq=N.
  router.get('/current/events', async (req, res) => {
    requireRun(engine.getSnapshot());
    const afterSeq = Number(req.query.afterSeq ?? 0);
    if (!Number.isFinite(afterSeq) || afterSeq < 0) throw badRequest('afterSeq must be a non-negative number');
    res.json({ events: await engine.listEvents(afterSeq) });
  });

  return router;
}

function requireRun<T>(snapshot: T | null): T {
  if (!snapshot) throw notFound('no run exists yet');
  return snapshot;
}

/** Whitelist + clamp the client-supplied config patch (never trust the wire). */
function sanitizeConfig(raw: unknown): Partial<RunConfig> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const input = raw as Record<string, unknown>;
  const out: Partial<RunConfig> = {};
  if (input.profile === 'mission' || input.profile === 'pipeline') out.profile = input.profile;
  for (const slot of ['builder', 'planner', 'reviewer'] as const) {
    const agent = input[slot];
    if (typeof agent === 'object' && agent !== null) {
      const record = agent as Record<string, unknown>;
      const provider = record.provider;
      if (provider === 'claude' || provider === 'codex' || provider === 'antigravity') {
        out[slot] = {
          provider,
          model: typeof record.model === 'string' ? record.model : undefined,
          effort: typeof record.effort === 'string' ? record.effort : undefined,
          permission: typeof record.permission === 'string' ? record.permission : undefined,
        };
      }
    }
  }
  if (input.reviewPolicy === 'final' || input.reviewPolicy === 'per-task' || input.reviewPolicy === 'none') {
    out.reviewPolicy = input.reviewPolicy;
  }
  if (
    input.verifyPolicy === 'per-build' ||
    input.verifyPolicy === 'final' ||
    input.verifyPolicy === 'both' ||
    input.verifyPolicy === 'none'
  ) {
    out.verifyPolicy = input.verifyPolicy;
  }
  if (typeof input.maxAttemptsPerItem === 'number' && input.maxAttemptsPerItem >= 1 && input.maxAttemptsPerItem <= 5) {
    out.maxAttemptsPerItem = Math.floor(input.maxAttemptsPerItem);
  }
  if (typeof input.hardTurnTimeoutMs === 'number' && input.hardTurnTimeoutMs >= 60_000) {
    out.hardTurnTimeoutMs = Math.min(input.hardTurnTimeoutMs, 6 * 60 * 60_000);
  }
  if (typeof input.allowDangerous === 'boolean') out.allowDangerous = input.allowDangerous;
  return Object.keys(out).length ? out : undefined;
}
