import { Router } from 'express';
import type { AppCtx } from '../context.js';
import { resolveExistingDir } from '../util/paths.js';
import { STAGE_ORDER, type AgentType, type StageId, type StageRunConfig } from '../orchestrator/types.js';

function badRequest(message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = 400;
  return e;
}

function toInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
}
function toStr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}
function toAgentType(v: unknown): AgentType | undefined {
  return v === 'claude' || v === 'codex' ? v : undefined;
}

function isStage(v: string): v is StageId {
  return (STAGE_ORDER as string[]).includes(v);
}

/** Build a StageRunConfig from request body, defaulting from config; validate permission keys. */
function buildStageConfig(ctx: AppCtx, body: Record<string, unknown>): StageRunConfig {
  const d = ctx.orchestrator.getConfig().defaults;
  const cli = ctx.orchestrator.getConfig().cli;
  const cfg: StageRunConfig = {
    claudeAgents: toInt(body.claudeAgents, d.claudeAgents),
    codexAgents: toInt(body.codexAgents, d.codexAgents),
    claudeModel: toStr(body.claudeModel, d.claudeModel),
    codexModel: toStr(body.codexModel, d.codexModel),
    claudeEffort: toStr(body.claudeEffort, d.claudeEffort),
    codexEffort: toStr(body.codexEffort, d.codexEffort),
    claudePermission: toStr(body.claudePermission, d.claudePermission),
    codexPermission: toStr(body.codexPermission, d.codexPermission),
    parallel: typeof body.parallel === 'boolean' ? body.parallel : d.parallel,
    mergeAgent: toAgentType(body.mergeAgent),
  };
  if (!cli.claude.permissionModes[cfg.claudePermission]) {
    throw badRequest(`unknown claude permission mode: ${cfg.claudePermission}`);
  }
  if (!cli.codex.permissionModes[cfg.codexPermission]) {
    throw badRequest(`unknown codex permission mode: ${cfg.codexPermission}`);
  }
  return cfg;
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
    await orch.initialize(dirCheck.path, prompt);
    ctx.state.tiger = { lastWorkspace: dirCheck.path };
    await ctx.save();
    res.json(orch.getState());
  });

  router.post('/stages/:stage/run', (req, res) => {
    const stage = req.params.stage;
    if (!isStage(stage)) {
      res.status(404).json({ error: { message: 'unknown stage' } });
      return;
    }
    const cfg = buildStageConfig(ctx, (req.body ?? {}) as Record<string, unknown>);
    orch.startStage(stage, cfg);
    res.status(202).json(orch.getState());
  });

  router.post('/stages/:stage/retry', (req, res) => {
    const stage = req.params.stage;
    if (!isStage(stage)) {
      res.status(404).json({ error: { message: 'unknown stage' } });
      return;
    }
    orch.retryStage(stage);
    res.status(202).json(orch.getState());
  });

  router.post('/stop', (_req, res) => {
    orch.stopStage();
    res.json(orch.getState());
  });

  router.get('/tasks', (_req, res) => {
    res.json(orch.getState().tasks ?? { total: 0, items: [] });
  });

  // Read any artifact within the tiger root (run-log.md, tasks.md, agent outputs, ...).
  router.get('/file', async (req, res) => {
    const result = await orch.readArtifact(String(req.query.path ?? ''));
    res.json(result);
  });

  return router;
}
