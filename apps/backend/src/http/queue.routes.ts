import { Router } from 'express';
import { nanoid } from 'nanoid';
import type { AppCtx } from '../context.js';
import type { QueueProvider, QueueRule, QueueRuleAction, QueueRuleOperator, QueueRuleProvider } from '../queue/types.js';

function badRequest(message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = 400;
  return e;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function int(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isInteger(v) && Number.isFinite(v) ? v : fallback;
}

function provider(v: unknown, fallback: QueueProvider = 'claude'): QueueProvider {
  return v === 'claude' || v === 'codex' || v === 'mixed' ? v : fallback;
}

function ruleProvider(v: unknown): QueueRuleProvider {
  if (v === 'claude' || v === 'codex' || v === 'mixed' || v === 'any') return v;
  throw badRequest('provider must be claude, codex, mixed, or any');
}

function operator(v: unknown): QueueRuleOperator {
  if (v === 'gte' || v === 'gt' || v === 'lte' || v === 'lt' || v === 'eq') return v;
  throw badRequest('operator must be gte, gt, lte, lt, or eq');
}

function action(v: unknown): QueueRuleAction {
  if (v === undefined || v === 'block_dispatch') return 'block_dispatch';
  throw badRequest('action must be block_dispatch');
}

function ruleFromBody(body: Record<string, unknown>, existing?: QueueRule): QueueRule {
  const now = new Date().toISOString();
  const name = str(body.name) ?? existing?.name;
  if (!name) throw badRequest('name is required');
  const threshold = typeof body.threshold === 'number' && Number.isFinite(body.threshold) ? body.threshold : existing?.threshold;
  if (threshold == null || threshold < 0 || threshold > 100) throw badRequest('threshold must be between 0 and 100');
  return {
    id: str(body.id) ?? existing?.id ?? nanoid(),
    name,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : existing?.enabled ?? true,
    provider: body.provider === undefined && existing ? existing.provider : ruleProvider(body.provider),
    windowKey: str(body.windowKey) ?? existing?.windowKey ?? 'any',
    metric: 'percent_used',
    operator: body.operator === undefined && existing ? existing.operator : operator(body.operator),
    threshold,
    action: body.action === undefined && existing ? existing.action : action(body.action),
    config: body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? (body.config as Record<string, unknown>) : existing?.config ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function createQueueRouter(ctx: AppCtx): Router {
  const router = Router();
  const service = ctx.queueService;

  router.get('/', async (_req, res) => {
    res.json(await service.getState());
  });

  router.get('/state', async (_req, res) => {
    res.json(await service.getState());
  });

  router.post('/enqueue', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const job = await service.enqueue({
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
      workspacePath: str(body.workspacePath) ?? str(body.workspace),
      projectName: str(body.projectName),
      provider: body.provider === undefined ? undefined : provider(body.provider),
      priority: int(body.priority, 0),
      maxAttempts: int(body.maxAttempts, 1),
      configSnapshot: body.configSnapshot && typeof body.configSnapshot === 'object' ? body.configSnapshot : undefined,
    });
    res.status(202).json(job);
  });

  router.post('/reorder', async (req, res) => {
    const ids = (req.body as { ids?: unknown })?.ids;
    if (!Array.isArray(ids)) throw badRequest('ids must be an array');
    await service.reorder(ids.filter((id): id is string => typeof id === 'string'));
    res.json(await service.getState());
  });

  router.post('/:id/pause', async (req, res) => {
    res.json(await service.pause(req.params.id));
  });

  router.post('/:id/resume', async (req, res) => {
    res.json(await service.resume(req.params.id));
  });

  router.post('/:id/cancel', async (req, res) => {
    res.json(await service.cancel(req.params.id));
  });

  router.post('/:id/retry', async (req, res) => {
    res.json(await service.retry(req.params.id));
  });

  router.get('/rules', async (_req, res) => {
    res.json(await service.listRules());
  });

  router.post('/rules', async (req, res) => {
    res.status(201).json(await service.upsertRule(ruleFromBody((req.body ?? {}) as Record<string, unknown>)));
  });

  router.put('/rules/:id', async (req, res) => {
    const current = (await service.listRules()).find((rule) => rule.id === req.params.id);
    if (!current) {
      res.status(404).json({ error: { message: 'rule not found' } });
      return;
    }
    res.json(await service.upsertRule(ruleFromBody({ ...(req.body ?? {}), id: req.params.id } as Record<string, unknown>, current)));
  });

  router.delete('/rules/:id', async (req, res) => {
    await service.deleteRule(req.params.id);
    res.status(204).end();
  });

  return router;
}
