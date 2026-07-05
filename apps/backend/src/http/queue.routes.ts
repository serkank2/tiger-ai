import { Router } from 'express';
import { nanoid } from 'nanoid';
import type { AppCtx } from '../context.js';
import type {
  QueueBulkAction,
  QueueJobStatus,
  QueueProvider,
  QueueRule,
  QueueRuleAction,
  QueueRuleOperator,
  QueueRuleProvider,
  QueueTargetType,
} from '../queue/types.js';
import { badRequest, notFound } from './errors.js';
import { assertWorkspaceAllowed } from '../security/workspace.js';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function int(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isInteger(v) && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number.parseInt(v, 10);
  return fallback;
}

function provider(v: unknown, fallback: QueueProvider = 'claude'): QueueProvider {
  return v === 'claude' || v === 'codex' || v === 'antigravity' || v === 'mixed' ? v : fallback;
}

function ruleProvider(v: unknown): QueueRuleProvider {
  if (v === 'claude' || v === 'codex' || v === 'antigravity' || v === 'mixed' || v === 'any') return v;
  throw badRequest('provider must be claude, codex, antigravity, mixed, or any');
}

function operator(v: unknown): QueueRuleOperator {
  if (v === 'gte' || v === 'gt' || v === 'lte' || v === 'lt' || v === 'eq') return v;
  throw badRequest('operator must be gte, gt, lte, lt, or eq');
}

function action(v: unknown): QueueRuleAction {
  if (v === undefined || v === 'block_dispatch') return 'block_dispatch';
  throw badRequest('action must be block_dispatch');
}

const BULK_ACTIONS: ReadonlySet<QueueBulkAction> = new Set<QueueBulkAction>([
  'pause',
  'resume',
  'cancel',
  'retry',
  'delete',
]);

function bulkAction(v: unknown): QueueBulkAction {
  if (typeof v === 'string' && BULK_ACTIONS.has(v as QueueBulkAction)) return v as QueueBulkAction;
  throw badRequest('action must be pause, resume, cancel, retry, or delete');
}

function targetType(v: unknown): QueueTargetType | undefined {
  if (v === undefined) return undefined;
  if (v === 'terminal' || v === 'project' || v === 'team') return v;
  throw badRequest('target must be terminal, project, or team');
}

function terminalStatus(v: unknown): QueueJobStatus | undefined {
  if (v === undefined) return undefined;
  if (v === 'completed' || v === 'failed' || v === 'canceled') return v;
  throw badRequest('status must be completed, failed, or canceled');
}

function cursor(v: unknown): string | undefined {
  return typeof v === 'string' && /^\d+$/.test(v) ? v : undefined;
}

function ruleFromBody(body: Record<string, unknown>, existing?: QueueRule): QueueRule {
  const now = new Date().toISOString();
  const name = str(body.name) ?? existing?.name;
  if (!name) throw badRequest('name is required');
  const threshold =
    typeof body.threshold === 'number' && Number.isFinite(body.threshold) ? body.threshold : existing?.threshold;
  if (threshold == null || threshold < 0 || threshold > 100) throw badRequest('threshold must be between 0 and 100');
  return {
    id: str(body.id) ?? existing?.id ?? nanoid(),
    name,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : (existing?.enabled ?? true),
    provider: body.provider === undefined && existing ? existing.provider : ruleProvider(body.provider),
    windowKey: str(body.windowKey) ?? existing?.windowKey ?? 'any',
    metric: 'percent_used',
    operator: body.operator === undefined && existing ? existing.operator : operator(body.operator),
    threshold,
    action: body.action === undefined && existing ? existing.action : action(body.action),
    config:
      body.config && typeof body.config === 'object' && !Array.isArray(body.config)
        ? (body.config as Record<string, unknown>)
        : (existing?.config ?? null),
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

  router.get('/history', async (req, res) => {
    res.json(
      await service.getHistory({
        status: terminalStatus(req.query.status),
        target: targetType(req.query.target),
        cursor: cursor(req.query.cursor),
        limit: int(req.query.limit, 50),
      }),
    );
  });

  router.post('/enqueue', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // A workspace-targeted job spawns a run/PTY at this path, so it must clear
    // the same allow-list the /runs and /terminals routes enforce — otherwise
    // the queue is an escape hatch around KAPLAN_ENFORCE_WORKSPACE.
    const rawWorkspace = str(body.workspacePath) ?? str(body.workspace);
    const workspacePath = rawWorkspace ? assertWorkspaceAllowed(rawWorkspace) : undefined;
    const job = await service.enqueue({
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
      body: typeof body.body === 'string' ? body.body : undefined,
      title: str(body.title),
      workspacePath,
      projectName: str(body.projectName),
      provider: body.provider === undefined ? undefined : provider(body.provider),
      priority: int(body.priority, 0),
      maxAttempts: int(body.maxAttempts, 1),
      configSnapshot: body.configSnapshot && typeof body.configSnapshot === 'object' ? body.configSnapshot : undefined,
      target:
        body.target === undefined
          ? undefined
          : targetType(
              typeof body.target === 'string' ? body.target : (body.target as { type?: unknown } | undefined)?.type,
            ),
      payload:
        body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
          ? (body.payload as Record<string, unknown>)
          : body.target && typeof body.target === 'object' && !Array.isArray(body.target)
            ? ((body.target as Record<string, unknown>).payload as Record<string, unknown> | undefined)
            : undefined,
    });
    res.status(202).json(job);
  });

  router.post('/reorder', async (req, res) => {
    const ids = (req.body as { ids?: unknown })?.ids;
    if (!Array.isArray(ids)) throw badRequest('ids must be an array');
    await service.reorder(ids.filter((id): id is string => typeof id === 'string'));
    res.json(await service.getState());
  });

  router.post('/bulk', async (req, res) => {
    const body = (req.body ?? {}) as { action?: unknown; ids?: unknown };
    const act = bulkAction(body.action);
    if (!Array.isArray(body.ids)) throw badRequest('ids must be an array');
    const ids = body.ids.filter((id): id is string => typeof id === 'string');
    const results = await service.bulk(act, ids);
    res.json({ action: act, results, state: await service.getState() });
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
    if (!current) throw notFound('rule not found');
    res.json(
      await service.upsertRule(
        ruleFromBody({ ...(req.body ?? {}), id: req.params.id } as Record<string, unknown>, current),
      ),
    );
  });

  router.delete('/rules/:id', async (req, res) => {
    await service.deleteRule(req.params.id);
    res.status(204).end();
  });

  return router;
}
