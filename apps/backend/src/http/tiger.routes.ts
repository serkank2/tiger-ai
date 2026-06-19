import { Router } from 'express';
import type { AppCtx } from '../context.js';
import { resolveExistingDir } from '../util/paths.js';
import { STAGE_ORDER, type StageId, type StageRunConfig } from '../orchestrator/types.js';
import {
  TIGER_PROJECT_PROMPT_MAX_CHARS,
} from '../orchestrator/config.js';
import {
  buildStageConfig as buildStageRunConfig,
  configInputError,
  isStage,
} from '../orchestrator/stage-config.js';

/** Record a project workspace in app state (dedup) and mark it as the most recent. */
function rememberProject(ctx: AppCtx, dir: string): void {
  const tiger = (ctx.state.tiger ??= {});
  tiger.projects ??= [];
  if (!tiger.projects.includes(dir)) tiger.projects.push(dir);
  tiger.lastWorkspace = dir;
}

/** Build a StageRunConfig from request body, defaulting from config; validate permission keys. */
function buildStageConfig(ctx: AppCtx, body: Record<string, unknown>): StageRunConfig {
  return buildStageRunConfig(ctx.orchestrator.getConfig(), body);
}

/** REST control-plane for the Tiger orchestrator. */
export function createTigerRouter(ctx: AppCtx): Router {
  const router = Router();
  const orch = ctx.orchestrator;

  router.get('/state', (_req, res) => {
    res.json(orch.getState());
  });

  router.get('/config', (_req, res) => {
    res.json(orch.getConfig());
  });

  router.put('/config', async (req, res) => {
    const updated = await orch.updateConfig(req.body ?? {});
    res.json(updated);
  });

  // Select a workspace and initialize the tiger/ tree with the project prompt.
  router.post('/workspace', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const dirCheck = await resolveExistingDir(body.path);
    if (!dirCheck.ok) {
      res.status(400).json({ error: { message: `invalid workspace directory: ${dirCheck.reason}` } });
      return;
    }
    const prompt = typeof body.projectPrompt === 'string' ? body.projectPrompt : '';
    if (!prompt.trim()) {
      res.status(400).json({ error: { message: 'projectPrompt is required' } });
      return;
    }
    if (prompt.length > TIGER_PROJECT_PROMPT_MAX_CHARS) {
      res.status(400).json({
        error: { message: `projectPrompt must be ${TIGER_PROJECT_PROMPT_MAX_CHARS} characters or fewer` },
      });
      return;
    }
    await orch.initialize(dirCheck.path, prompt);
    rememberProject(ctx, dirCheck.path);
    await ctx.save();
    res.json(orch.getState());
  });

  router.put('/project-prompt', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prompt = typeof body.projectPrompt === 'string' ? body.projectPrompt : '';
    if (!prompt.trim()) {
      res.status(400).json({ error: { message: 'projectPrompt is required' } });
      return;
    }
    if (prompt.length > TIGER_PROJECT_PROMPT_MAX_CHARS) {
      res.status(400).json({
        error: { message: `projectPrompt must be ${TIGER_PROJECT_PROMPT_MAX_CHARS} characters or fewer` },
      });
      return;
    }
    res.json(await orch.replaceProjectPrompt(prompt));
  });

  // List known projects for the launcher.
  router.get('/projects', async (_req, res) => {
    res.json(await orch.listProjects(ctx.state.tiger?.projects ?? []));
  });

  // Open (continue) an existing project.
  router.post('/projects/open', async (req, res) => {
    const dirCheck = await resolveExistingDir((req.body as { path?: unknown })?.path);
    if (!dirCheck.ok) {
      res.status(400).json({ error: { message: `invalid project directory: ${dirCheck.reason}` } });
      return;
    }
    await orch.attachWorkspace(dirCheck.path);
    rememberProject(ctx, dirCheck.path);
    await ctx.save();
    res.json(orch.getState());
  });

  // Close the active project and return to the launcher.
  router.post('/projects/close', async (_req, res) => {
    await orch.closeProject();
    res.json(orch.getState());
  });

  // Forget a project (remove from the list; does NOT delete files).
  router.delete('/projects', async (req, res) => {
    const dir = (req.body as { path?: unknown })?.path;
    if (typeof dir !== 'string' || !dir.trim()) {
      res.status(400).json({ error: { message: 'path is required' } });
      return;
    }
    if (ctx.state.tiger?.projects) {
      ctx.state.tiger.projects = ctx.state.tiger.projects.filter((p) => p !== dir);
      await ctx.save();
    }
    res.json(await orch.listProjects(ctx.state.tiger?.projects ?? []));
  });

  router.post('/stages/:stage/run', async (req, res) => {
    const stage = req.params.stage;
    if (!isStage(stage)) {
      res.status(404).json({ error: { message: 'unknown stage' } });
      return;
    }
    const cfg = buildStageConfig(ctx, (req.body ?? {}) as Record<string, unknown>);
    const auto = (req.body as { auto?: unknown })?.auto === true;
    await orch.startStage(stage, cfg, auto);
    res.status(202).json(orch.getState());
  });

  // Configure every stage, then auto-run them all using each stage's own config.
  router.post('/run-all', async (req, res) => {
    const body = (req.body ?? {}) as { configs?: Record<string, unknown>; fromStage?: unknown };
    const raw = body.configs && typeof body.configs === 'object' ? (body.configs as Record<string, unknown>) : {};
    const configs: Partial<Record<StageId, StageRunConfig>> = {};
    for (const stage of STAGE_ORDER) {
      const entry = raw[stage];
      if (entry && typeof entry === 'object') configs[stage] = buildStageConfig(ctx, entry as Record<string, unknown>);
    }
    const fromStage = typeof body.fromStage === 'string' && isStage(body.fromStage) ? body.fromStage : undefined;
    await orch.startAll(configs, fromStage);
    res.status(202).json(orch.getState());
  });

  // --- Run All templates (global DB-backed built-ins + custom templates) ---
  router.get('/templates', async (_req, res) => {
    res.json(await ctx.runTemplates.list());
  });

  // Compatibility save endpoint used by the current Run All modal: create or update by name.
  router.post('/templates', async (req, res) => {
    await ctx.runTemplates.save(req.body ?? {});
    res.json(await ctx.runTemplates.list());
  });

  router.put('/templates/:id', async (req, res) => {
    res.json(await ctx.runTemplates.update(req.params.id, req.body ?? {}));
  });

  router.post('/templates/:id/duplicate', async (req, res) => {
    res.json(await ctx.runTemplates.duplicate(req.params.id, req.body ?? {}));
  });

  router.post('/templates/:id/apply', async (req, res) => {
    res.json(await ctx.runTemplates.apply(req.params.id));
  });

  router.delete('/templates', async (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    if (!name) throw configInputError('template name is required');
    await ctx.runTemplates.archive(name);
    res.json(await ctx.runTemplates.list());
  });

  router.delete('/templates/:id', async (req, res) => {
    await ctx.runTemplates.archive(req.params.id);
    res.json(await ctx.runTemplates.list());
  });

  router.post('/stages/:stage/retry', async (req, res) => {
    const stage = req.params.stage;
    if (!isStage(stage)) {
      res.status(404).json({ error: { message: 'unknown stage' } });
      return;
    }
    await orch.retryStage(stage);
    res.status(202).json(orch.getState());
  });

  router.post('/stop', (_req, res) => {
    orch.stopStage();
    res.json(orch.getState());
  });

  // Explicitly accept a stage's failures and allow the workflow to proceed.
  router.post('/stages/:stage/continue', (req, res) => {
    const stage = req.params.stage;
    if (!isStage(stage)) {
      res.status(404).json({ error: { message: 'unknown stage' } });
      return;
    }
    orch.continueStage(stage);
    res.json(orch.getState());
  });

  // Route unresolved final-review issues back to Stage 5 (executing-plan) or 6A (task-review).
  router.post('/route', (req, res) => {
    const target = (req.body ?? {}) as { target?: unknown };
    if (target.target !== 'executing-plan' && target.target !== 'task-review') {
      res.status(400).json({ error: { message: 'target must be "executing-plan" or "task-review"' } });
      return;
    }
    orch.routeCorrection(target.target);
    res.status(202).json(orch.getState());
  });

  router.get('/tasks', (_req, res) => {
    res.json(orch.getState().tasks ?? { total: 0, items: [] });
  });

  // Read any artifact within the tiger root (run-log.md, tasks.md, agent outputs, ...).
  router.get('/file', async (req, res) => {
    const result = await orch.readArtifact(String(req.query.path ?? ''));
    res.json(result);
  });

  // Probe each provider's usage panel (best-effort interactive scrape; Antigravity is an explicit
  // unsupported probe). Used by the limit widget.
  router.get('/usage', async (_req, res) => {
    const status = await ctx.limits.refresh('legacy');
    res.json(ctx.limits.toLegacyUsage(status));
  });

  return router;
}
