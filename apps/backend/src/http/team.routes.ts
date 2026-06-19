// ---------------------------------------------------------------------------
// REST control-plane for the AI Team orchestrator. Exposes the engine
// (`TeamOrchestrator`) and the team-template catalog to the frontend over the
// exact contract the team store / `useApi` already expect:
//
//   GET  /api/team/templates                     → { teams, roles }
//   GET  /api/team/state                         → { state | null }
//   POST /api/team/runs                          → { state }   (create + start)
//   POST /api/team/runs/:id/stop|pause|resume    → { state }
//   POST /api/team/runs/:id/steer                → { state }
//   GET  /api/team/runs/:id/messages             → { items, nextCursor, hasMore }
//   GET  /api/team/runs/:id/artifacts            → TeamArtifact[]
//
// A team run operates on the workspace of the currently-selected Tiger project,
// so the user picks a project (and writes its project prompt) in the Projects
// view, then runs a Team against it. The engine keeps a single active run; the
// `:id` in control routes is validated against it.
// ---------------------------------------------------------------------------

import { Router } from 'express';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AppCtx } from '../context.js';
import { BUILTIN_ROLE_TEMPLATES, type RoleTemplate } from '../team/templates.js';
import { toTeamRunStateDto } from '../team/snapshot.js';
import { TigerPaths } from '../orchestrator/paths.js';
import { ensureScaffold } from '../orchestrator/scaffold.js';
import { resolveExistingDir } from '../util/paths.js';
import { TeamTemplateServiceError } from '../services/team-templates.js';
import { artifactsFile } from '../team/message-bus.js';
import { computeTeamChanges } from '../team/changes.js';
import { commit as gitCommit, createPullRequest, stageAll } from '../git/write.js';
import { assertWorkspaceAllowed } from '../security/workspace.js';
import { notFound } from './errors.js';
import type { TeamRunState as EngineTeamRunState, TeamRoleInstance } from '../team/TeamOrchestrator.js';
import type { TeamMessage } from '../team/types.js';
import type { AgentType } from '../orchestrator/types.js';
import { toAgentTypeOr } from '../orchestrator/types.js';

/** Number of conversation messages seeded into a `/state` snapshot. */
const RECENT_MESSAGES = 50;
const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

type EngineRoleSeed = Omit<Partial<TeamRoleInstance>, 'status'>;

function httpError(res: import('express').Response, status: number, message: string): void {
  res.status(status).json({ error: { message } });
}

/** Map a team-template service / validation error to a clean HTTP response. */
function sendTemplateError(res: import('express').Response, err: unknown): void {
  const e = err as { status?: number; statusCode?: number; message?: string };
  const status =
    err instanceof TeamTemplateServiceError
      ? err.status
      : typeof e.status === 'number'
        ? e.status
        : typeof e.statusCode === 'number'
          ? e.statusCode
          : 400;
  httpError(res, status, e.message ?? 'team template request failed');
}

/** Map an orchestrator error (it throws `Error & { status }`) to a clean HTTP response. */
function sendOrchError(res: import('express').Response, err: unknown): void {
  const e = err as { status?: number; message?: string };
  const status = typeof e.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 500;
  httpError(res, status, status >= 500 ? 'internal error' : e.message ?? 'team request failed');
}

/**
 * The workspace to use for read endpoints (state/messages/artifacts): the active
 * in-memory run's workspace, else the last Team workspace, else the active Tiger
 * project. A new run instead takes its workspace from the request body.
 */
function knownWorkspace(ctx: AppCtx): string | null {
  const active = ctx.teamOrchestrator.activeWorkspace();
  if (active) return active;
  if (ctx.state.team?.lastWorkspace) return ctx.state.team.lastWorkspace;
  const tiger = ctx.orchestrator.getState();
  return tiger.initialized && tiger.workspace ? tiger.workspace : null;
}

/** Record a Team project workspace (dedup) and mark it as the most recent. */
function rememberTeamProject(ctx: AppCtx, dir: string): void {
  const team = (ctx.state.team ??= {});
  team.projects ??= [];
  if (!team.projects.includes(dir)) team.projects.push(dir);
  team.lastWorkspace = dir;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/** Map a stored role template into the engine's role-seed shape. */
function roleFromTemplate(role: RoleTemplate, templateId?: string): EngineRoleSeed {
  return {
    id: role.id,
    templateId,
    name: role.name,
    tool: role.agent.tool,
    model: role.agent.model || undefined,
    effort: role.agent.effort || undefined,
    permission: role.agent.permission || undefined,
    persona: role.persona,
    responsibilities: role.responsibilities,
    canWriteCode: role.canWriteCode,
    requiredForSignoff: role.requiredForSignoff,
  };
}

/** Map a client-supplied role config (custom team) into the engine's role-seed shape. */
function roleFromInput(raw: unknown, index: number): EngineRoleSeed {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = asString(r.name).trim() || `Role ${index + 1}`;
  const tool: AgentType = toAgentTypeOr(r.tool, 'codex');
  return {
    id: slug(asString(r.id)) || slug(name) || `role-${index + 1}`,
    templateId: asString(r.templateId) || undefined,
    name,
    tool,
    model: asString(r.model) || undefined,
    effort: asString(r.effort) || undefined,
    permission: asString(r.permission) || undefined,
    persona: asString(r.persona) || undefined,
    responsibilities: Array.isArray(r.responsibilities)
      ? (r.responsibilities as unknown[]).map(String).filter(Boolean)
      : undefined,
    canWriteCode: r.canWriteCode === true,
    requiredForSignoff: r.requiredForSignoff !== false,
  };
}

/** Resolve the roles for a new run from an explicit `roles[]` or a `templateId`. */
async function resolveRoles(ctx: AppCtx, body: Record<string, unknown>): Promise<EngineRoleSeed[]> {
  if (Array.isArray(body.roles) && body.roles.length > 0) {
    return body.roles.map((role, index) => roleFromInput(role, index));
  }
  const templateId = asString(body.templateId).trim();
  if (templateId) {
    const template = await ctx.teamTemplates.get(templateId);
    return template.roles.map((role) => roleFromTemplate(role, template.id));
  }
  throw Object.assign(new Error('provide a templateId or a non-empty roles list'), { status: 400 });
}

/** Read and project the conversation tail for a `/state` snapshot. */
async function recentTail(ctx: AppCtx): Promise<TeamMessage[]> {
  const all = await ctx.teamOrchestrator.listMessages(0);
  return all.slice(-RECENT_MESSAGES);
}

/** Ensure there is an active run and that the path id matches it. */
function requireActiveRun(ctx: AppCtx, id: string): EngineTeamRunState {
  const state = ctx.teamOrchestrator.tryGetState();
  if (!state) throw Object.assign(new Error('no active team run'), { status: 404 });
  if (id && state.runId !== id) {
    throw Object.assign(new Error(`team run ${id} is not the active run`), { status: 409 });
  }
  return state;
}

interface ArtifactLine {
  runId?: string;
  turnId?: string;
  roleId?: string;
  kind?: string;
  absPath?: string;
  relPath?: string;
  sizeBytes?: number | null;
  recordedAt?: string;
}

/** Read `artifacts.ndjson` for a run and project it onto the UI `TeamArtifact` shape (deduped). */
async function readArtifacts(workspace: string, runId: string): Promise<unknown[]> {
  const file = artifactsFile(new TigerPaths(workspace), runId);
  const body = await fs.readFile(file, 'utf8').catch(() => '');
  const byPath = new Map<string, unknown>();
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: ArtifactLine;
    try {
      parsed = JSON.parse(line) as ArtifactLine;
    } catch {
      continue;
    }
    const rel = parsed.relPath ?? parsed.absPath;
    if (!rel) continue;
    byPath.set(rel, {
      id: `${parsed.turnId ?? ''}:${rel}`,
      runId,
      path: rel,
      name: rel.split('/').pop() ?? rel,
      kind: parsed.kind,
      size: parsed.sizeBytes ?? null,
      createdAt: parsed.recordedAt,
    });
  }
  return [...byPath.values()];
}

/** REST control-plane for the AI Team orchestrator. */
export function createTeamRouter(ctx: AppCtx): Router {
  const router = Router();
  const orch = ctx.teamOrchestrator;

  router.get('/templates', async (_req, res) => {
    const teams = await ctx.teamTemplates.list();
    res.json({ teams, roles: BUILTIN_ROLE_TEMPLATES });
  });

  router.post('/templates', async (req, res) => {
    try {
      const template = await ctx.teamTemplates.create(req.body ?? {});
      res.status(201).json({ template });
    } catch (err) {
      sendTemplateError(res, err);
    }
  });

  router.put('/templates/:id', async (req, res) => {
    try {
      const template = await ctx.teamTemplates.update(req.params.id, req.body ?? {});
      res.json({ template });
    } catch (err) {
      sendTemplateError(res, err);
    }
  });

  router.post('/templates/:id/duplicate', async (req, res) => {
    try {
      const template = await ctx.teamTemplates.duplicate(req.params.id, req.body ?? {});
      res.status(201).json({ template });
    } catch (err) {
      sendTemplateError(res, err);
    }
  });

  router.delete('/templates/:id', async (req, res) => {
    try {
      await ctx.teamTemplates.archive(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      sendTemplateError(res, err);
    }
  });

  router.get('/projects', (_req, res) => {
    const team = ctx.state.team?.projects ?? [];
    const tiger = ctx.state.tiger?.projects ?? [];
    const projects = [...new Set([...team, ...tiger])];
    res.json({ projects, lastWorkspace: ctx.state.team?.lastWorkspace ?? null });
  });

  router.get('/state', async (_req, res) => {
    let state = orch.tryGetState();
    if (!state) {
      const ws = knownWorkspace(ctx);
      if (ws) state = await orch.loadLatestRun(ws);
    }
    if (!state) {
      res.json({ state: null });
      return;
    }
    const tail = await recentTail(ctx);
    res.json({ state: toTeamRunStateDto(state, tail) });
  });

  router.post('/runs', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const goal = asString(body.goal).trim();
    if (!goal) {
      httpError(res, 400, 'team goal is required');
      return;
    }
    // The Team is self-contained: it works on the folder the user picks. Fall back to
    // the last Team workspace (or the active Tiger project) when none is supplied.
    const requested = asString(body.path) || asString(body.workspace);
    let workspace: string;
    if (requested) {
      const dirCheck = await resolveExistingDir(requested);
      if (!dirCheck.ok) {
        httpError(res, 400, `invalid project directory: ${dirCheck.reason}`);
        return;
      }
      workspace = dirCheck.path;
    } else {
      const known = knownWorkspace(ctx);
      if (!known) {
        httpError(res, 400, 'pick a project folder for the team to work on');
        return;
      }
      workspace = known;
    }
    // Enforce the workspace boundary for the resolved workspace (whether client-supplied
    // or derived from the active/last project). Throws HttpError(403, 'workspace_not_allowed'),
    // forwarded by Express 5 to the central error middleware for a stable error code.
    assertWorkspaceAllowed(workspace);
    const roles = await resolveRoles(ctx, body);
    // Scaffold the .tiger root and seed the goal as the project prompt (idempotent;
    // never clobbers an existing prompt), so role turns always have project context.
    await ensureScaffold(workspace, goal);
    rememberTeamProject(ctx, workspace);
    await ctx.save();
    await orch.createTeamRun({ workspace, goal, roles });
    await orch.start();
    res.json({ state: toTeamRunStateDto(orch.getState()) });
  });

  router.post('/runs/:id/stop', async (req, res) => {
    requireActiveRun(ctx, req.params.id);
    await orch.stop();
    res.json({ state: toTeamRunStateDto(orch.getState()) });
  });

  router.post('/runs/:id/pause', async (req, res) => {
    requireActiveRun(ctx, req.params.id);
    await orch.pause();
    res.json({ state: toTeamRunStateDto(orch.getState()) });
  });

  router.post('/runs/:id/resume', async (req, res) => {
    requireActiveRun(ctx, req.params.id);
    await orch.resume();
    res.json({ state: toTeamRunStateDto(orch.getState()) });
  });

  // Close: stop the flow AND kill the persistent CLI terminals (Stop only pauses them).
  router.post('/runs/:id/close', async (req, res) => {
    requireActiveRun(ctx, req.params.id);
    await orch.close();
    res.json({ state: toTeamRunStateDto(orch.getState()) });
  });

  // Every Team prompt is routed to the Lead (the orchestrator queues it for the Lead, not
  // for whichever role would run next). When the run had idled to a resumable waiting state,
  // `steer` also resumes the loop so the Lead picks up the prompt without a manual resume —
  // so the returned state may flip from 'blocked' back to 'running'.
  router.post('/runs/:id/steer', async (req, res) => {
    requireActiveRun(ctx, req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = asString(body.body).trim();
    if (!text) {
      httpError(res, 400, 'message body is required');
      return;
    }
    await orch.steer(text);
    res.json({ state: toTeamRunStateDto(orch.getState()) });
  });

  router.get('/runs/:id/messages', async (req, res) => {
    const id = req.params.id;
    const state = orch.tryGetState();
    const workspace = state?.workspace ?? knownWorkspace(ctx);
    if (!workspace) {
      res.json({ items: [], nextCursor: null, hasMore: false });
      return;
    }
    const all =
      state && state.runId === id
        ? await orch.listMessages(0)
        : await orch.listMessages(0, { workspace, runId: id });

    const limit = Math.min(MAX_PAGE, Math.max(1, Number(req.query.limit) || DEFAULT_PAGE));
    const afterSeqRaw = Number(req.query.afterSeq);
    if (Number.isFinite(afterSeqRaw) && afterSeqRaw > 0) {
      const items = all.filter((m) => m.seq > afterSeqRaw);
      res.json({ items, nextCursor: null, hasMore: false });
      return;
    }
    const cursorRaw = Number(req.query.cursor);
    const cursorSeq = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : null;
    const pool = cursorSeq != null ? all.filter((m) => m.seq < cursorSeq) : all;
    const items = pool.slice(-limit);
    const oldestSeq = items.length ? items[0]!.seq : null;
    const hasMore = oldestSeq != null && pool.some((m) => m.seq < oldestSeq);
    res.json({ items, nextCursor: hasMore ? String(oldestSeq) : null, hasMore });
  });

  router.get('/runs/:id/artifacts', async (req, res) => {
    const state = orch.tryGetState();
    const workspace = state?.workspace ?? knownWorkspace(ctx);
    if (!workspace) {
      res.json([]);
      return;
    }
    res.json(await readArtifacts(workspace, req.params.id));
  });

  // The real product changes the team made in its workspace (git working-tree diff vs HEAD).
  // This is the "what did the agents actually change?" view — distinct from `/artifacts`,
  // which lists the run's .tiger bookkeeping files.
  router.get('/runs/:id/changes', async (_req, res) => {
    const state = orch.tryGetState();
    const workspace = state?.workspace ?? knownWorkspace(ctx);
    if (!workspace) {
      res.json({
        isGitRepo: false,
        head: null,
        branch: null,
        files: [],
        diff: '',
        diffTruncated: false,
        summary: { files: 0, insertions: 0, deletions: 0 },
        generatedAt: new Date().toISOString(),
        note: 'No team workspace is known yet.',
      });
      return;
    }
    res.json(await computeTeamChanges(workspace, new Date().toISOString()));
  });

  // ----------------------------------------------------------------------------
  // Git WRITE actions (Stage / Commit / Create-PR). These are sensitive, outward
  // operations on the run's workspace, so each resolves the workspace exactly like
  // `/changes` and 404s when no workspace is known. Helpers throw `HttpError`, which
  // Express 5 forwards to the central error middleware for a stable `{ code }`.
  // ----------------------------------------------------------------------------

  /** Resolve the workspace dir for a git-write action, or 404 when none is known. */
  function requireGitWorkspace(): string {
    const state = orch.tryGetState();
    const workspace = state?.workspace ?? knownWorkspace(ctx);
    if (!workspace) throw notFound('no team workspace is known yet');
    return workspace;
  }

  // POST /api/team/runs/:id/git/stage → `git add -A`; return the updated changeset.
  router.post('/runs/:id/git/stage', async (_req, res) => {
    const workspace = requireGitWorkspace();
    await stageAll(workspace);
    res.json(await computeTeamChanges(workspace, new Date().toISOString()));
  });

  // POST /api/team/runs/:id/git/commit { message } → commit; 422 on empty message;
  // returns { committed, sha, summary } (committed:false for "nothing to commit").
  router.post('/runs/:id/git/commit', async (req, res) => {
    const workspace = requireGitWorkspace();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await gitCommit(workspace, asString(body.message));
    res.json({ ...result, changes: await computeTeamChanges(workspace, new Date().toISOString()) });
  });

  // POST /api/team/runs/:id/git/pr { title, body?, base? } → open a PR via `gh`;
  // returns { url } or an actionable HttpError (missing/unauth gh, no branch, …).
  router.post('/runs/:id/git/pr', async (req, res) => {
    const workspace = requireGitWorkspace();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await createPullRequest(workspace, {
      title: asString(body.title),
      body: asString(body.body) || undefined,
      base: asString(body.base) || undefined,
    });
    res.json(result);
  });

  // ----------------------------------------------------------------------------
  // Run history (Epic-4 item 4): list past runs for the workspace, and re-open a
  // past run read-only (rehydrate its snapshot without disturbing the live run).
  // ----------------------------------------------------------------------------

  // GET /api/team/runs → { runs: TeamRunSummary[] } (newest first) for the known workspace.
  router.get('/runs', async (_req, res) => {
    const workspace = knownWorkspace(ctx);
    if (!workspace) {
      res.json({ runs: [] });
      return;
    }
    res.json({ runs: await orch.listRuns(workspace) });
  });

  // GET /api/team/runs/:id → { state } read-only rehydrate of a past run's snapshot. Returns
  // the active run's live snapshot when :id is the active run; otherwise reads it from disk.
  router.get('/runs/:id', async (req, res) => {
    const id = req.params.id;
    const active = orch.tryGetState();
    if (active && active.runId === id) {
      const tail = await recentTail(ctx);
      res.json({ state: toTeamRunStateDto(active, tail) });
      return;
    }
    const workspace = active?.workspace ?? knownWorkspace(ctx);
    if (!workspace) {
      httpError(res, 404, 'no team workspace is known');
      return;
    }
    try {
      const state = await orch.readRun(workspace, id);
      const tail = (await orch.listMessages(0, { workspace, runId: id })).slice(-RECENT_MESSAGES);
      res.json({ state: toTeamRunStateDto(state, tail) });
    } catch (err) {
      sendOrchError(res, err);
    }
  });

  // GET /api/team/runs/:id/export?format=json|markdown → a downloadable transcript + artifacts.
  router.get('/runs/:id/export', async (req, res) => {
    const active = orch.tryGetState();
    const workspace = active?.workspace ?? knownWorkspace(ctx);
    if (!workspace) {
      httpError(res, 404, 'no team workspace is known');
      return;
    }
    const format = asString(req.query.format).toLowerCase() === 'markdown' ? 'markdown' : 'json';
    try {
      const out = await orch.exportRun(workspace, req.params.id, format);
      res.setHeader('Content-Type', format === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
      res.send(out.content);
    } catch (err) {
      sendOrchError(res, err);
    }
  });

  // ----------------------------------------------------------------------------
  // Single-role control + mid-run role management (Epic-4 item 8). All act on the
  // active run; `:roleId` is validated by the orchestrator.
  // ----------------------------------------------------------------------------

  // Pause a single role (it takes no further turns until resumed) without halting the run.
  router.post('/runs/:id/roles/:roleId/pause', async (req, res) => {
    requireActiveRun(ctx, req.params.id);
    try {
      await orch.pauseRole(req.params.roleId);
      res.json({ state: toTeamRunStateDto(orch.getState()) });
    } catch (err) {
      sendOrchError(res, err);
    }
  });

  router.post('/runs/:id/roles/:roleId/resume', async (req, res) => {
    requireActiveRun(ctx, req.params.id);
    try {
      await orch.resumeRole(req.params.roleId);
      res.json({ state: toTeamRunStateDto(orch.getState()) });
    } catch (err) {
      sendOrchError(res, err);
    }
  });

  // Steer a single role: queue a directive addressed to that role (not the Lead).
  router.post('/runs/:id/roles/:roleId/steer', async (req, res) => {
    requireActiveRun(ctx, req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = asString(body.body).trim();
    if (!text) {
      httpError(res, 400, 'message body is required');
      return;
    }
    try {
      await orch.steerRole(req.params.roleId, text);
      res.json({ state: toTeamRunStateDto(orch.getState()) });
    } catch (err) {
      sendOrchError(res, err);
    }
  });

  // Add a role to the run mid-flight.
  router.post('/runs/:id/roles', async (req, res) => {
    requireActiveRun(ctx, req.params.id);
    try {
      await orch.addRole(roleFromInput(req.body ?? {}, orch.getState().roles.length));
      res.json({ state: toTeamRunStateDto(orch.getState()) });
    } catch (err) {
      sendOrchError(res, err);
    }
  });

  // Reconfigure an existing role's settings/persona/capabilities mid-run.
  router.patch('/runs/:id/roles/:roleId', async (req, res) => {
    requireActiveRun(ctx, req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      await orch.reconfigureRole(req.params.roleId, {
        name: typeof body.name === 'string' ? body.name : undefined,
        persona: typeof body.persona === 'string' ? body.persona : undefined,
        tool: typeof body.tool === 'string' ? body.tool : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        effort: typeof body.effort === 'string' ? body.effort : undefined,
        permission: typeof body.permission === 'string' ? body.permission : undefined,
        responsibilities: Array.isArray(body.responsibilities)
          ? (body.responsibilities as unknown[]).map(String).filter(Boolean)
          : undefined,
        canWriteCode: typeof body.canWriteCode === 'boolean' ? body.canWriteCode : undefined,
        requiredForSignoff: typeof body.requiredForSignoff === 'boolean' ? body.requiredForSignoff : undefined,
      });
      res.json({ state: toTeamRunStateDto(orch.getState()) });
    } catch (err) {
      sendOrchError(res, err);
    }
  });

  // Remove a role from the run mid-flight (the Lead cannot be removed).
  router.delete('/runs/:id/roles/:roleId', async (req, res) => {
    requireActiveRun(ctx, req.params.id);
    try {
      await orch.removeRole(req.params.roleId);
      res.json({ state: toTeamRunStateDto(orch.getState()) });
    } catch (err) {
      sendOrchError(res, err);
    }
  });

  // ----------------------------------------------------------------------------
  // Attempt model (vibe-kanban). A run's work can be tried multiple times; each
  // attempt has its own branch + diff + outcome, attempts are comparable, and the
  // best one can be PROMOTED (merged into the workspace base). These act on the
  // active run (the orchestrator validates `:id` and 404s an unknown attempt).
  // ----------------------------------------------------------------------------

  // GET /api/team/runs/:id/attempts → { attempts } from the run snapshot.
  router.get('/runs/:id/attempts', async (req, res) => {
    const id = req.params.id;
    const active = orch.tryGetState();
    try {
      if (active && active.runId === id) {
        const dto = toTeamRunStateDto(active);
        res.json({ attempts: dto.attempts ?? [], currentAttemptId: dto.currentAttemptId ?? null, promotedAttemptId: dto.promotedAttemptId ?? null });
        return;
      }
      const workspace = active?.workspace ?? knownWorkspace(ctx);
      if (!workspace) {
        httpError(res, 404, 'no team workspace is known');
        return;
      }
      const state = await orch.readRun(workspace, id);
      const dto = toTeamRunStateDto(state);
      res.json({ attempts: dto.attempts ?? [], currentAttemptId: dto.currentAttemptId ?? null, promotedAttemptId: dto.promotedAttemptId ?? null });
    } catch (err) {
      sendOrchError(res, err);
    }
  });

  // POST /api/team/runs/:id/attempts → start a NEW attempt re-running the same goal.
  router.post('/runs/:id/attempts', async (req, res) => {
    try {
      await orch.createAttempt(req.params.id);
      res.json({ state: toTeamRunStateDto(orch.getState()) });
    } catch (err) {
      sendOrchError(res, err);
    }
  });

  // POST /api/team/runs/:id/attempts/:attemptId/promote → merge the attempt into base.
  router.post('/runs/:id/attempts/:attemptId/promote', async (req, res) => {
    try {
      await orch.promoteAttempt(req.params.id, req.params.attemptId);
      res.json({ state: toTeamRunStateDto(orch.getState()) });
    } catch (err) {
      sendOrchError(res, err);
    }
  });

  // ----------------------------------------------------------------------------
  // Team worktree-per-task (Part B): merge-back / cleanup affordance for a KEPT
  // per-task worktree branch (one left un-merged by a merge conflict). Re-attempts
  // the merge into the workspace base (conflict-safe), or discards it on ?cleanup.
  // ----------------------------------------------------------------------------

  // POST /api/team/runs/:id/worktrees/:taskId/merge { cleanup? } → merge or discard a kept worktree.
  router.post('/runs/:id/worktrees/:taskId/merge', async (req, res) => {
    requireActiveRun(ctx, req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      await orch.mergeTaskWorktree(req.params.id, req.params.taskId, { cleanup: body.cleanup === true });
      res.json({ state: toTeamRunStateDto(orch.getState()) });
    } catch (err) {
      sendOrchError(res, err);
    }
  });

  // GET /api/team/runs/:id/attempts/:attemptId/diff → the attempt's changeset (reuses the
  // diff machinery). Same shape as /changes so the colorized diff component can render it.
  router.get('/runs/:id/attempts/:attemptId/diff', async (req, res) => {
    try {
      res.json(await orch.attemptDiff(req.params.id, req.params.attemptId));
    } catch (err) {
      sendOrchError(res, err);
    }
  });

  return router;
}
