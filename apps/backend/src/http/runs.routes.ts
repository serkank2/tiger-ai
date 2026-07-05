import { Router } from 'express';
import type { AppCtx } from '../context.js';
import { badRequest, conflict, notFound } from './errors.js';
import { assertWorkspaceAllowed } from '../security/workspace.js';
import { computeTeamChanges } from '../git/changes.js';
import { readRunEvents, readRunIndex, readRunSnapshot } from '../run/history.js';
import { effortsForProvider, isLaunchSafeModel } from '../orchestrator/config.js';
import type { CouncilMember, RunConfig } from '../run/types.js';

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

  // Steering: persisted immediately, applied at the next graph boundary as a
  // re-plan. `interrupt: true` aborts the in-flight turn so it applies NOW
  // (the aborted item re-queues; sessions resume with context intact).
  router.post('/current/steer', async (req, res) => {
    requireRun(engine.getSnapshot());
    const body = (req.body ?? {}) as { body?: unknown; interrupt?: unknown };
    if (typeof body.body !== 'string' || !body.body.trim()) throw badRequest('steering body is required');
    res.json({ run: await engine.steer(body.body, { interrupt: body.interrupt === true }) });
  });

  // Interactive mode: route a user keystroke into a live agent's PTY.
  router.post('/current/input', (req, res) => {
    requireRun(engine.getSnapshot());
    const body = (req.body ?? {}) as { agentId?: unknown; data?: unknown };
    if (typeof body.agentId !== 'string' || !body.agentId.trim()) throw badRequest('agentId is required');
    if (typeof body.data !== 'string') throw badRequest('data (string) is required');
    const routed = engine.interactiveInput(body.agentId, body.data);
    if (!routed) throw notFound(`no live interactive turn for agent "${body.agentId}"`);
    res.json({ ok: true });
  });

  // Interactive mode: the user declares an agent's turn complete.
  router.post('/current/complete', (req, res) => {
    requireRun(engine.getSnapshot());
    const body = (req.body ?? {}) as { agentId?: unknown };
    if (typeof body.agentId !== 'string' || !body.agentId.trim()) throw badRequest('agentId is required');
    const done = engine.interactiveComplete(body.agentId);
    if (!done) throw notFound(`no live interactive turn for agent "${body.agentId}"`);
    res.json({ ok: true });
  });

  // Event log replay for reconnect/reopen: ?afterSeq=N.
  router.get('/current/events', async (req, res) => {
    requireRun(engine.getSnapshot());
    const afterSeq = Number(req.query.afterSeq ?? 0);
    if (!Number.isFinite(afterSeq) || afterSeq < 0) throw badRequest('afterSeq must be a non-negative number');
    res.json({ events: await engine.listEvents(afterSeq) });
  });

  // Working-tree changes of the current run's workspace — the human review unit.
  router.get('/current/changes', async (_req, res) => {
    const snapshot = requireRun(engine.getSnapshot());
    res.json({ changes: await computeTeamChanges(snapshot.workspace, new Date().toISOString()) });
  });

  // Run history (global index, newest first). `/current*` routes above win the match.
  router.get('/', async (_req, res) => {
    res.json({ runs: await readRunIndex() });
  });

  // Read-only snapshot of a past run, rehydrated from its on-disk state.
  router.get('/:runId', async (req, res) => {
    const entry = await requireIndexed(req.params.runId);
    const snapshot = await readRunSnapshot(entry.workspace, entry.runId);
    if (!snapshot) throw notFound(`run "${entry.runId}" has no readable state on disk`);
    res.json({ run: snapshot });
  });

  router.get('/:runId/events', async (req, res) => {
    const entry = await requireIndexed(req.params.runId);
    const afterSeq = Number(req.query.afterSeq ?? 0);
    if (!Number.isFinite(afterSeq) || afterSeq < 0) throw badRequest('afterSeq must be a non-negative number');
    res.json({ events: await readRunEvents(entry.workspace, entry.runId, afterSeq) });
  });

  async function requireIndexed(runId: string | undefined) {
    if (!runId?.trim()) throw badRequest('runId is required');
    const entry = (await readRunIndex()).find((candidate) => candidate.runId === runId);
    if (!entry) throw notFound(`run "${runId}" not found in the history index`);
    return entry;
  }

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
          model: sanitizeModel(provider, record.model),
          effort: sanitizeEffort(provider, record.effort),
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
  if (typeof input.maxParallelBuilds === 'number' && input.maxParallelBuilds >= 1 && input.maxParallelBuilds <= 4) {
    out.maxParallelBuilds = Math.floor(input.maxParallelBuilds);
  }
  if (typeof input.planBatchSize === 'number' && input.planBatchSize >= 1 && input.planBatchSize <= 50) {
    out.planBatchSize = Math.floor(input.planBatchSize);
  }
  if (
    typeof input.sessionRotateTurns === 'number' &&
    input.sessionRotateTurns >= 0 &&
    input.sessionRotateTurns <= 100
  ) {
    out.sessionRotateTurns = Math.floor(input.sessionRotateTurns);
  }
  if (
    typeof input.rateLimitBackoffMs === 'number' &&
    input.rateLimitBackoffMs >= 0 &&
    input.rateLimitBackoffMs <= 5 * 60_000
  ) {
    out.rateLimitBackoffMs = Math.floor(input.rateLimitBackoffMs);
  }
  if (typeof input.hardTurnTimeoutMs === 'number' && input.hardTurnTimeoutMs >= 60_000) {
    out.hardTurnTimeoutMs = Math.min(input.hardTurnTimeoutMs, 6 * 60 * 60_000);
  }
  if (typeof input.allowDangerous === 'boolean') out.allowDangerous = input.allowDangerous;
  if (typeof input.interactive === 'boolean') out.interactive = input.interactive;
  if (typeof input.skipPlanning === 'boolean') out.skipPlanning = input.skipPlanning;
  if (
    input.importance === 'low' ||
    input.importance === 'normal' ||
    input.importance === 'high' ||
    input.importance === 'critical'
  ) {
    out.importance = input.importance;
  }
  if (typeof input.council === 'object' && input.council !== null) {
    const council = input.council as Record<string, unknown>;
    const providers = Array.isArray(council.providers)
      ? council.providers.filter(
          (p): p is 'claude' | 'codex' | 'antigravity' => p === 'claude' || p === 'codex' || p === 'antigravity',
        )
      : [];
    const members = sanitizeCouncilMembers(council.members);
    out.council = {
      plan: typeof council.plan === 'number' ? Math.max(1, Math.min(12, Math.floor(council.plan))) : 1,
      review: typeof council.review === 'number' ? Math.max(1, Math.min(12, Math.floor(council.review))) : 1,
      providers,
      ...(members.length ? { members } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/** A launch-safe model override, or undefined ('' and unsafe values mean "provider default"). */
function sanitizeModel(provider: 'claude' | 'codex' | 'antigravity', raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  return isLaunchSafeModel(provider, raw) ? raw : undefined;
}

/** A provider-valid reasoning effort, or undefined ('' means "provider default"). */
function sanitizeEffort(provider: 'claude' | 'codex' | 'antigravity', raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  return effortsForProvider(provider).includes(raw) ? raw : undefined;
}

/** The explicit council roster: whitelisted providers, clamped counts, launch-safe models. */
function sanitizeCouncilMembers(raw: unknown): CouncilMember[] {
  if (!Array.isArray(raw)) return [];
  const members: CouncilMember[] = [];
  for (const entry of raw.slice(0, 12)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const provider = record.provider;
    if (provider !== 'claude' && provider !== 'codex' && provider !== 'antigravity') continue;
    const count = typeof record.count === 'number' && Number.isFinite(record.count) ? Math.floor(record.count) : 0;
    if (count < 1) continue;
    members.push({
      provider,
      count: Math.min(count, 8),
      model: sanitizeModel(provider, record.model),
      effort: sanitizeEffort(provider, record.effort),
    });
  }
  return members;
}
