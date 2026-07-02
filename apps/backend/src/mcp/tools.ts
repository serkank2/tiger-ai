import { z } from 'zod';
import type { AppCtx } from '../context.js';
import { config } from '../config.js';
import { isWorkspaceAllowed } from '../security/workspace.js';

/**
 * MCP tool definitions over Kaplan's task/run board. Kept transport-agnostic and
 * pure: each tool takes the shared {@link AppCtx} plus validated args and returns a
 * plain JSON-serializable result. `server.ts` adapts these into MCP `registerTool`
 * calls and `tools.test.ts` exercises them directly against a stub ctx — so the
 * actual board logic is testable without spinning up a transport or a real DB.
 *
 * The toolset is deliberately READ-heavy with a few SAFE additive writes
 * (`enqueue_prompt`, `steer_run`). Destructive board operations
 * (cancel/pause/delete) are intentionally excluded from the initial surface.
 */

/** A single MCP tool: schema + a handler that runs against the live ctx. */
export interface McpToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  /** Zod raw shape passed to `registerTool({ inputSchema })`. Empty object = no args. */
  inputShape: Shape;
  /** Whether the tool only reads board state (advertised via MCP annotations). */
  readOnly: boolean;
  /** Run the tool. Returns any JSON-serializable value; server wraps it as MCP content. */
  run(ctx: AppCtx, args: z.infer<z.ZodObject<Shape>>): Promise<unknown>;
}

// Small helper so every def keeps strong arg typing without repeating the cast.
function defineTool<Shape extends z.ZodRawShape>(def: McpToolDef<Shape>): McpToolDef<Shape> {
  return def;
}

const QUEUE_PROVIDERS = ['claude', 'codex', 'antigravity', 'mixed'] as const;

const QUEUE_STATUSES = [
  'queued',
  'running',
  'blocked_by_limit',
  'paused',
  'completed',
  'failed',
  'canceled',
  'retrying',
] as const;

/**
 * Build the full ordered tool list. Pure function of `z` only — the ctx is bound at
 * call time so the same defs serve both the live server and the test harness.
 */
export function buildTools(): McpToolDef[] {
  const tools: McpToolDef<z.ZodRawShape>[] = [
    // ---------------------------------------------------------------- queue (read)
    defineTool({
      name: 'list_queue_jobs',
      title: 'List queue jobs',
      description:
        'List the autonomous prompt-queue jobs (id, status, priority, provider, project, prompt preview). Optionally filter by status.',
      inputShape: {
        status: z
          .enum(QUEUE_STATUSES)
          .optional()
          .describe('Optional exact status filter, e.g. "queued", "running", "completed", "failed".'),
      },
      readOnly: true,
      async run(ctx, args) {
        const state = await ctx.queueService.getState();
        let jobs = state.jobs;
        if (args.status) jobs = jobs.filter((j) => j.status === args.status);
        return {
          count: jobs.length,
          jobs: jobs.map((j) => ({
            id: j.id,
            status: j.status,
            priority: j.priority,
            provider: j.provider,
            projectName: j.projectName,
            workspacePath: j.workspacePath,
            attempts: j.attempts,
            maxAttempts: j.maxAttempts,
            currentStep: j.currentStep,
            promptPreview: j.prompt.slice(0, 200),
            createdAt: j.createdAt,
            updatedAt: j.updatedAt,
          })),
        };
      },
    }),
    defineTool({
      name: 'get_queue_job',
      title: 'Get queue job',
      description: 'Fetch one queue job by id, including its full prompt and per-stage steps.',
      inputShape: { id: z.string().min(1).describe('Queue job id.') },
      readOnly: true,
      async run(ctx, args) {
        const job = await ctx.queueService.getJob(args.id);
        if (!job) return { found: false, id: args.id };
        const steps = await ctx.queueService.listSteps(args.id);
        return {
          found: true,
          job: {
            ...job,
            steps: steps
              .slice()
              .sort((a, b) => a.position - b.position)
              .map((s) => ({ stepKey: s.stepKey, status: s.status, attempts: s.attempts, error: s.error })),
          },
        };
      },
    }),
    // -------------------------------------------------------------- queue (write)
    defineTool({
      name: 'enqueue_prompt',
      title: 'Enqueue a prompt',
      description:
        'Create a new autonomous queue job from a prompt. The scheduler picks it up and drives it through the standard run stages. Returns the created job id.',
      inputShape: {
        prompt: z.string().min(1).describe('The task prompt for the autonomous run.'),
        projectName: z.string().optional().describe('Optional human-readable project name for the job.'),
        workspacePath: z.string().optional().describe('Optional absolute workspace path; one is generated if omitted.'),
        provider: z
          .enum(QUEUE_PROVIDERS)
          .optional()
          .describe('Optional provider hint; inferred from config when omitted.'),
        priority: z.number().int().optional().describe('Optional integer priority (higher runs sooner).'),
        maxAttempts: z.number().int().positive().optional().describe('Optional max attempts before terminal failure.'),
      },
      readOnly: false,
      async run(ctx, args) {
        // An external MCP client could otherwise point an autonomous run at any host path.
        // When a workspacePath is supplied, it MUST pass the same boundary check the HTTP
        // layer enforces; reject anything outside the allowlist/data dir. When omitted, the
        // queue service generates a safe path under the data dir, so we leave it unset.
        let workspacePath = args.workspacePath;
        if (workspacePath !== undefined) {
          const check = isWorkspaceAllowed(
            workspacePath,
            config.security.workspaceAllowlist,
            config.dataDir,
            config.security.enforceWorkspaceBoundary,
          );
          if (!check.ok) {
            return { ok: false, error: 'workspace_not_allowed', reason: check.reason };
          }
          workspacePath = check.path;
        }
        const job = await ctx.queueService.enqueue({
          prompt: args.prompt,
          projectName: args.projectName,
          workspacePath,
          provider: args.provider,
          priority: args.priority,
          maxAttempts: args.maxAttempts,
        });
        return {
          id: job.id,
          status: job.status,
          position: job.position,
          provider: job.provider,
          projectName: job.projectName,
        };
      },
    }),
    // ------------------------------------------------------------- v2 runs (read)
    defineTool({
      name: 'get_run',
      title: 'Get the active v2 run',
      description:
        'Snapshot of the active v2 run: status, work-graph items with statuses, usage totals, latest verification records, steering.',
      inputShape: {},
      readOnly: true,
      async run(ctx) {
        const snapshot = ctx.runEngine.getSnapshot();
        return snapshot ? { active: true, run: snapshot } : { active: false };
      },
    }),
    defineTool({
      name: 'list_run_events',
      title: 'List v2 run events',
      description:
        'List the active v2 run’s event log (item/agent/verification/steering/note), optionally only events after a sequence number — the delta, so callers never re-read history.',
      inputShape: {
        afterSeq: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Return only events with seq greater than this value.'),
      },
      readOnly: true,
      async run(ctx, args) {
        if (!ctx.runEngine.getSnapshot()) return { active: false, events: [] };
        const events = await ctx.runEngine.listEvents(args.afterSeq ?? 0);
        return { active: true, count: events.length, events };
      },
    }),
    // ------------------------------------------------------------ v2 runs (write)
    defineTool({
      name: 'steer_run',
      title: 'Steer the active v2 run',
      description:
        'Send steering to the active v2 run. Applied at the next graph boundary as a re-plan (code inserts the plan item — no Lead chat turn). Fails when no run is active.',
      inputShape: { body: z.string().min(1).describe('The steering text.') },
      readOnly: false,
      async run(ctx, args) {
        if (!ctx.runEngine.getSnapshot()) return { ok: false, error: 'no_active_run' };
        const run = await ctx.runEngine.steer(args.body);
        return { ok: true, runId: run.runId, seq: run.seq };
      },
    }),
  ];
  return tools as McpToolDef[];
}
