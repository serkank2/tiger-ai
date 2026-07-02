import { Router } from 'express';
import type { AppCtx } from '../context.js';
import { listPrompts, readPrompt, writePrompt, deletePrompt, renamePrompt } from '../prompts/store.js';
import type { AgentType } from '../orchestrator/types.js';
import type { PromptGenerationRecord, PromptGenerationStatus } from '../repositories/PromptGenerationRepository.js';
import type { PromptHistoryFilters } from '../repositories/PromptHistoryRepository.js';
import type { QueueProvider } from '../queue/types.js';
import { badRequest, conflict, notFound } from './errors.js';

/**
 * Prompt library API over the prompts dir. Thrown errors carry `.status` and are
 * formatted by the central error handler. Sending is NOT here — the composer renders
 * variables client-side and reuses the existing WS command broadcast.
 */
export function createPromptsRouter(ctx: AppCtx): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json({ items: await listPrompts() });
  });

  router.get('/history', async (req, res) => {
    const filters: PromptHistoryFilters = {
      text: queryStringValue(req.query.text),
      kind: queryStringValue(req.query.kind),
      projectId: queryStringValue(req.query.projectId),
      dateFrom: queryStringValue(req.query.dateFrom),
      dateTo: queryStringValue(req.query.dateTo),
      status: queryStringValue(req.query.status),
      generationId: queryStringValue(req.query.generationId),
      limit: queryIntegerValue(req.query.limit, 'limit'),
    };
    res.json(await ctx.promptGenerations.listHistory(cleanHistoryFilters(filters)));
  });

  router.post('/generate', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const generation = await ctx.promptGenerations.start({
      inputText: asString(body.inputText, 'inputText'),
      agentType: asAgentType(body.agentType),
      model: optionalString(body.model),
      effort: optionalString(body.effort),
      permission: optionalString(body.permission),
      projectId: optionalString(body.projectId),
    });
    res.status(202).json(ctx.promptGenerations.toState(generation));
  });

  router.get('/generate/:id', async (req, res) => {
    const generation = await ctx.promptGenerations.get(req.params.id);
    if (!generation) throw notFound('prompt generation not found');
    res.json(ctx.promptGenerations.toState(generation));
  });

  router.post('/generate/:id/reuse', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = String(body.action ?? '');
    const generation = await requireDoneGeneration(ctx, req.params.id);

    if (action === 'copy' || action === 'edit') {
      res.json({ action, generation, text: generation.outputText });
      return;
    }

    if (action === 'save-to-library') {
      const prompt = await writePrompt(asString(body.path, 'path'), generation.outputText ?? '', {
        create: true,
        overwrite: body.overwrite === true,
      });
      await ctx.promptGenerations.recordReuseAction(generation.id, 'save-to-library', { path: prompt.path });
      res.status(201).json({ action, generation: await ctx.promptGenerations.get(generation.id), prompt });
      return;
    }

    if (action === 'enqueue') {
      const job = await ctx.queueService.enqueue({
        prompt: generation.outputText ?? '',
        workspacePath: optionalString(body.workspacePath) ?? generation.projectId ?? undefined,
        projectName: optionalString(body.projectName) ?? undefined,
        provider: asQueueProvider(body.provider),
        priority: optionalInteger(body.priority),
        maxAttempts: optionalInteger(body.maxAttempts),
        configSnapshot:
          body.configSnapshot && typeof body.configSnapshot === 'object' ? body.configSnapshot : undefined,
      });
      await ctx.promptGenerations.recordReuseAction(generation.id, 'enqueue', {
        jobId: job.id,
      });
      res.status(202).json({
        action,
        generation: await ctx.promptGenerations.get(generation.id),
        enqueue: { accepted: true, job },
      });
      return;
    }

    throw badRequest('unknown reuse action');
  });

  router.get('/file', async (req, res) => {
    res.json(await readPrompt(String(req.query.path ?? '')));
  });

  router.post('/', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.path !== 'string' || typeof b.content !== 'string') {
      throw badRequest('path and content must be strings');
    }
    const out = await writePrompt(b.path, b.content, { create: true, overwrite: b.overwrite === true });
    res.status(201).json(out);
  });

  router.put('/file', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.path !== 'string' || typeof b.content !== 'string') {
      throw badRequest('path and content must be strings');
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

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw httpErr(400, `${field} must be a string`);
  return value;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw httpErr(400, 'optional fields must be strings');
  return value;
}

function queryStringValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return queryStringValue(value[0]);
  if (typeof value !== 'string') throw httpErr(400, 'history filters must be strings');
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function queryIntegerValue(value: unknown, field: string): number | undefined {
  const text = queryStringValue(value);
  if (text === undefined) return undefined;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 1) throw httpErr(400, `${field} must be a positive integer`);
  return parsed;
}

function cleanHistoryFilters(filters: PromptHistoryFilters): PromptHistoryFilters {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)) as PromptHistoryFilters;
}

function asAgentType(value: unknown): AgentType | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'claude' || value === 'codex' || value === 'antigravity') return value;
  throw httpErr(400, 'agentType must be claude, codex, or antigravity');
}

function asQueueProvider(value: unknown): QueueProvider | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'claude' || value === 'codex' || value === 'antigravity' || value === 'mixed') return value;
  throw httpErr(400, 'provider must be claude, codex, antigravity, or mixed');
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw httpErr(400, 'numeric queue fields must be integers');
  return value;
}

async function requireDoneGeneration(ctx: AppCtx, id: string): Promise<PromptGenerationRecord> {
  const generation = await ctx.promptGenerations.get(id);
  if (!generation) throw httpErr(404, 'prompt generation not found');
  if (!isDoneWithOutput(generation)) throw httpErr(409, `prompt generation is ${generation.status}`);
  return generation;
}

function isDoneWithOutput(
  generation: PromptGenerationRecord,
): generation is PromptGenerationRecord & { status: Extract<PromptGenerationStatus, 'done'>; outputText: string } {
  return (
    generation.status === 'done' && typeof generation.outputText === 'string' && generation.outputText.trim().length > 0
  );
}

/** Map the legacy (status, message) shape to the shared HttpError so responses carry a stable code. */
function httpErr(status: number, message: string): Error {
  if (status === 404) return notFound(message);
  if (status === 409) return conflict(message);
  return badRequest(message);
}
