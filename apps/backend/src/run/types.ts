import type { AgentType } from '../orchestrator/types.js';
import type { AgentEvent } from '../agents/events.js';
import type { VerificationCommand, VerificationRecord } from '../verify/service.js';
import type { RunGraph, WorkItemUsage } from './graph.js';

// ---------------------------------------------------------------------------
// Run-domain types: the v2 run state machine and its event log. One RUN =
// one goal against one workspace, executed as a WorkGraph (docs/REDESIGN.md).
// ---------------------------------------------------------------------------

export type RunStatus =
  | 'created'
  | 'running'
  /** Drained but with blocked items, or waiting on user input to proceed. */
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'stopped';

export type RunProfile =
  /** Single strong builder + planner + reviewer (default). */
  | 'mission'
  /** Tiger-style staged preset: plan → build* → review, stricter phase order. */
  | 'pipeline';

export type ReviewPolicy = 'final' | 'per-task' | 'none';
export type VerifyPolicy = 'per-build' | 'final' | 'both' | 'none';

/**
 * How much this run matters — scales the COUNCIL (multi-perspective ensemble)
 * at the read-only phases. The evidence (docs/REDESIGN.md §3) is precise about
 * where parallel agents help: independent THINKING (plan) and JUDGING (review)
 * benefit from diverse perspectives; the WRITE path stays single-agent.
 */
export type RunImportance = 'low' | 'normal' | 'high' | 'critical';

/** One user-selected council seat group: N candidates from a provider, optionally pinned to a model/effort. */
export interface CouncilMember {
  provider: AgentType;
  model?: string;
  effort?: string;
  count: number;
}

export interface RunCouncilConfig {
  /** Independent plan candidates synthesized into the final graph (1 = no council). */
  plan: number;
  /** Independent review lenses whose findings are merged (1 = single reviewer). */
  review: number;
  /** Provider rotation for council candidates (defaults to the builder's provider). */
  providers: AgentType[];
  /**
   * Explicit roster (user-chosen provider × count × model). When present it IS
   * the council: it sizes plan/review and wins over the importance preset.
   */
  members?: CouncilMember[];
}

export interface RunAgentConfig {
  provider: AgentType;
  model?: string;
  effort?: string;
  /** Provider permission-mode key (see config.ts built-ins). */
  permission?: string;
}

export interface RunConfig {
  profile: RunProfile;
  /** The slot agents. `builder` executes build items; planner/reviewer default to builder's provider. */
  builder: RunAgentConfig;
  planner?: RunAgentConfig;
  reviewer?: RunAgentConfig;
  /**
   * Build lanes: 1 = sequential in the shared workspace; >1 = each batch item
   * runs in an isolated git worktree and merges back as a patch (requires a
   * git repo; degrades to 1 with a note otherwise).
   */
  maxParallelBuilds: number;
  /** Attempts per item before it is blocked (retries resume the SAME session with the failure evidence). */
  maxAttemptsPerItem: number;
  hardTurnTimeoutMs: number;
  reviewPolicy: ReviewPolicy;
  verifyPolicy: VerifyPolicy;
  /** Explicit checks; empty = auto-discover from package.json scripts. */
  verifyCommands: VerificationCommand[];
  /**
   * Per-build checks (cheap static gates). Empty = auto-discover the quick set
   * (typecheck/lint). The FULL set (verifyCommands / full discovery, incl.
   * tests) runs only at finalize — running the whole suite after every build
   * dominated wall-clock on large graphs.
   */
  quickVerifyCommands: VerificationCommand[];
  /** Cap on engine-generated fix rounds after the final verification (guards loops). */
  maxFixRounds: number;
  /** Honor a role's dangerous permission choice (mirrors v1 honorDangerousPermissions). */
  allowDangerous: boolean;
  /** Mount the Kaplan MCP coordination bus into agent sessions. */
  mcp: boolean;
  /** Importance preset that sized the council (kept for display/history). */
  importance: RunImportance;
  /** Ensemble sizes for plan/review phases. */
  council: RunCouncilConfig;
  /**
   * Staged planning: the planner is told to plan at most this many tasks per
   * plan turn and flag `remainingScope`; the engine re-plans when the batch
   * drains. Keeps mega-goals from exploding into one giant brittle plan.
   */
  planBatchSize: number;
  /** Hard cap on staged plan batches (guards a planner that never finishes). */
  maxPlanBatches: number;
  /**
   * Rotate an agent slot to a FRESH provider session (with a recap brief)
   * after this many turns — long-lived sessions accumulate stale assumptions.
   * 0 disables rotation.
   */
  sessionRotateTurns: number;
  /**
   * Interactive mode: run each agent turn as a REAL interactive CLI in a PTY
   * the user watches and types into (context managed with `/compact`), instead
   * of a headless one-shot. Turn completion is user/result-file driven — never
   * idle-guessed. Default false (headless is the efficient default).
   */
  interactive: boolean;
  /**
   * Skip the planning phase entirely: no planner turn, no task breakdown — the
   * goal is seeded as a single build task the builder executes directly (it may
   * still emit follow-up build tasks). For "just do the work" runs.
   */
  skipPlanning: boolean;
  /** Backoff (ms) before retrying a turn that hit a provider rate/quota limit. */
  rateLimitBackoffMs: number;
}

export interface RunSteering {
  id: string;
  body: string;
  createdAt: string;
  status: 'pending' | 'applied';
}

export interface RunUsageTotals extends WorkItemUsage {
  turns: number;
}

export interface RunState {
  runId: string;
  workspace: string;
  goal: string;
  status: RunStatus;
  config: RunConfig;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  /** Human-readable status detail (why blocked/failed/stopped). */
  message?: string;
  graph: RunGraph;
  /** Monotonic event sequence (the delta cursor for briefs and the UI). */
  seq: number;
  usage: RunUsageTotals;
  /** Most recent verification batch (full history lives in the event log). */
  verifications: VerificationRecord[];
  steering: RunSteering[];
  /** Set once the run-level review item has completed (reviewPolicy=final). */
  reviewDone?: boolean;
  /** Engine-generated fix rounds consumed (vs config.maxFixRounds). */
  fixRounds: number;
  /** Staged planning: what the planner said remains after the current batch. */
  pendingScope?: string;
  /** Plan batches consumed (vs config.maxPlanBatches). */
  planBatches: number;
}

// --- Event log ---------------------------------------------------------------

export type RunEventType =
  | 'run-status'
  | 'item-status'
  | 'agent'
  | 'verification'
  | 'steering'
  /** Short engine narration (planning applied, fix task created, …). */
  | 'note';

/** Identity of the agent stream an `agent` event belongs to (one UI terminal pane). */
export interface RunAgentSource {
  agentId: string;
  provider: AgentType;
  model?: string;
}

export interface RunEvent {
  seq: number;
  at: string;
  type: RunEventType;
  runId: string;
  /** Present for item-status / agent / most notes. */
  itemId?: string;
  /** Agent-stream identity for `agent` events — groups events into per-agent terminals. */
  agentId?: string;
  provider?: AgentType;
  model?: string;
  /** run-status payload. */
  status?: RunStatus;
  /** item-status payload. */
  itemStatus?: string;
  /** agent payload (already normalized; heavy fields trimmed before persist). */
  agent?: AgentEvent;
  /** verification payload. */
  verification?: VerificationRecord;
  /** note / steering payload. */
  text?: string;
}

/** Compact DTO the WS layer pushes and the frontend store consumes. */
export interface RunSnapshot {
  runId: string;
  workspace: string;
  goal: string;
  status: RunStatus;
  message?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  profile: RunProfile;
  importance: RunImportance;
  council: RunCouncilConfig;
  /** Interactive-mode flag so the UI shows input controls per agent. */
  interactive: boolean;
  seq: number;
  usage: RunUsageTotals;
  graph: RunGraph;
  verifications: VerificationRecord[];
  steering: RunSteering[];
}

export function toRunSnapshot(state: RunState): RunSnapshot {
  return {
    runId: state.runId,
    workspace: state.workspace,
    goal: state.goal,
    status: state.status,
    message: state.message,
    createdAt: state.createdAt,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    profile: state.config.profile,
    importance: state.config.importance,
    council: state.config.council,
    interactive: state.config.interactive,
    seq: state.seq,
    usage: state.usage,
    graph: state.graph,
    verifications: state.verifications,
    steering: state.steering,
  };
}
