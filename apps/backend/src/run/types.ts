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
  /** >1 requires git worktree isolation; clamped to 1 otherwise. */
  maxParallelBuilds: number;
  /** Attempts per item before it is blocked (retries resume the SAME session with the failure evidence). */
  maxAttemptsPerItem: number;
  hardTurnTimeoutMs: number;
  reviewPolicy: ReviewPolicy;
  verifyPolicy: VerifyPolicy;
  /** Explicit checks; empty = auto-discover from package.json scripts. */
  verifyCommands: VerificationCommand[];
  /** Cap on engine-generated fix rounds after the final verification (guards loops). */
  maxFixRounds: number;
  /** Honor a role's dangerous permission choice (mirrors v1 honorDangerousPermissions). */
  allowDangerous: boolean;
  /** Mount the Kaplan MCP coordination bus into agent sessions. */
  mcp: boolean;
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

export interface RunEvent {
  seq: number;
  at: string;
  type: RunEventType;
  runId: string;
  /** Present for item-status / agent / most notes. */
  itemId?: string;
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
    seq: state.seq,
    usage: state.usage,
    graph: state.graph,
    verifications: state.verifications,
    steering: state.steering,
  };
}
