import { z } from 'zod';
import type { AppCtx } from '../context.js';

/**
 * MCP tool definitions over Kaplan's task/run board. Kept transport-agnostic and
 * pure: each tool takes the shared {@link AppCtx} plus validated args and returns a
 * plain JSON-serializable result. `server.ts` adapts these into MCP `registerTool`
 * calls and `tools.test.ts` exercises them directly against a stub ctx — so the
 * actual board logic is testable without spinning up a transport or a real DB.
 *
 * The toolset is deliberately READ-heavy with a few SAFE additive writes
 * (`enqueue_prompt`, `post_team_steering`). Destructive board operations
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
          .string()
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
        const job = await ctx.queueService.enqueue({
          prompt: args.prompt,
          projectName: args.projectName,
          workspacePath: args.workspacePath,
          provider: args.provider,
          priority: args.priority,
          maxAttempts: args.maxAttempts,
        });
        return { id: job.id, status: job.status, position: job.position, provider: job.provider, projectName: job.projectName };
      },
    }),
    // ----------------------------------------------------------------- tiger (read)
    defineTool({
      name: 'get_tiger_state',
      title: 'Get Tiger orchestrator state',
      description:
        'Snapshot of the Tiger multi-agent orchestrator: active workspace, current stage, busy flag, stage list, task/findings summaries.',
      inputShape: {},
      readOnly: true,
      async run(ctx) {
        return ctx.orchestrator.getState();
      },
    }),
    // ------------------------------------------------------------------ team (read)
    defineTool({
      name: 'get_team_run',
      title: 'Get active team run',
      description:
        'Snapshot of the AI-team run currently held in memory (status, roles, directives, sign-offs). Returns active=false when no run is loaded.',
      inputShape: {},
      readOnly: true,
      async run(ctx) {
        const state = ctx.teamOrchestrator.tryGetState();
        if (!state) return { active: false };
        return { active: true, run: state };
      },
    }),
    defineTool({
      name: 'list_team_messages',
      title: 'List team messages',
      description:
        'List messages from the active team run conversation, optionally only those after a given sequence number (for polling).',
      inputShape: {
        afterSeq: z.number().int().nonnegative().optional().describe('Return only messages with seq greater than this value.'),
      },
      readOnly: true,
      async run(ctx, args) {
        if (!ctx.teamOrchestrator.tryGetState()) return { active: false, messages: [] };
        const messages = await ctx.teamOrchestrator.listMessages(args.afterSeq ?? 0);
        return { active: true, count: messages.length, messages };
      },
    }),
    // ------------------------------------------------------------------ team (write)
    defineTool({
      name: 'post_team_steering',
      title: 'Post a team steering directive',
      description:
        'Send a steering directive to the Lead of the active team run. Queued FIFO and picked up on the Lead\'s next turn. Fails if no steerable run is active.',
      inputShape: { body: z.string().min(1).describe('The steering directive text.') },
      readOnly: false,
      async run(ctx, args) {
        if (!ctx.teamOrchestrator.tryGetState()) {
          return { ok: false, error: 'no_active_team_run' };
        }
        const message = await ctx.teamOrchestrator.steer(args.body);
        return { ok: true, messageId: message.id, createdAt: message.createdAt };
      },
    }),
  ];
  return tools as McpToolDef[];
}
