// ---------------------------------------------------------------------------
// AI Team domain model. A "team" is a set of role-playing CLI agents (business
// analyst, developer, tester, …) that converse, steer one another, write code,
// and only stop once every required role has signed off that the work is done.
//
// This module is the single authoritative, serializable contract that every
// later layer (persistence, routing, prompt composition, routes, UI) depends on.
// It defines TYPES ONLY — no persistence, parsing, composition, or execution.
// All generated content is English. Existing orchestrator types are reused where
// they already fit so the team feature does not duplicate the pipeline model.
// ---------------------------------------------------------------------------

import type { AgentType, FindingsSummary, TaskSummary } from '../orchestrator/types.js';

// Re-export so team consumers can depend on a single module for the CLI tool union.
export type { AgentType, FindingsSummary, TaskSummary };

// ---------------------------------------------------------------------------
// Roles: reusable templates and the live instances placed into a run.
// ---------------------------------------------------------------------------

/**
 * The CLI-execution settings a role uses for each of its turns. `model` and
 * `effort` may be the empty string to mean "use the CLI default"; `permission`
 * is a key into the matching `TigerConfig.cli[tool].permissionModes`.
 */
export interface RoleAgentConfig {
  /** Which CLI tool drives this role. */
  tool: AgentType;
  /** Model identifier; must be one of the configured models for `tool` ('' = CLI default). */
  model: string;
  /** Reasoning effort key; must be valid for `tool` ('' = CLI default). */
  effort: string;
  /** Permission-mode key; must exist in `TigerConfig.cli[tool].permissionModes`. */
  permission: string;
}

/**
 * A reusable, pre-defined role the user can add to a team (e.g. Business Analyst,
 * Tester, Developer). Ships as a template; instances copy these fields.
 */
export interface RoleTemplate {
  /** Stable identifier, e.g. "business-analyst". */
  id: string;
  /** Human-readable role name shown in the UI, e.g. "Business Analyst". */
  name: string;
  /** One-line English description of the role's responsibility. */
  description?: string;
  /** System-prompt persona text that defines how this role behaves. */
  persona: string;
  /** Bullet responsibilities that frame what this role is accountable for. */
  responsibilities: string[];
  /** Default CLI execution settings for instances created from this template. */
  agent: RoleAgentConfig;
  /** Whether this role may write/modify project source code. */
  canWriteCode: boolean;
  /** Whether this role's sign-off is required before the run may complete. */
  requiredForSignoff: boolean;
}

/** Live status of a role inside a running team. */
export type RoleStatus =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'waiting'
  | 'blocked'
  | 'done'
  | 'failed';

export const ROLE_STATUSES: RoleStatus[] = [
  'idle',
  'thinking',
  'working',
  'waiting',
  'blocked',
  'done',
  'failed',
];

/** A role as instantiated inside a specific run: template fields plus live state. */
export interface RoleInstance {
  /** Unique id within the run. */
  id: string;
  /** Source template id this instance was created from (if any). */
  templateId?: string;
  /** Display name (defaults from the template; the user may rename). */
  name: string;
  description: string;
  persona: string;
  agent: RoleAgentConfig;
  canWriteCode: boolean;
  requiredForSignoff: boolean;
  status: RoleStatus;
  /** Whether this role has declared its work done for the current completion gate. */
  signedOff: boolean;
  /** Free-form English note about the current status (e.g. a blocker reason). */
  statusNote?: string;
  createdAt: string;
  updatedAt?: string;
}

/** A reusable team preset: a named set of role templates that work together. */
export interface TeamTemplate {
  /** Stable database id. Built-ins use deterministic ids; unsaved drafts may omit it. */
  id?: string;
  name: string;
  description?: string;
  /** Role templates that make up this team. */
  roles: RoleTemplate[];
  /** Built-in teams ship with the app and cannot be edited or deleted. */
  builtin?: boolean;
  /** Monotonic metadata version, bumped on each custom-template edit. */
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
}

// ---------------------------------------------------------------------------
// Conversation: the message envelope exchanged inside a run.
// ---------------------------------------------------------------------------

/**
 * The semantic category of a conversation message. Drives how the UI renders the
 * message and how the orchestrator routes it. "system" and "blocker" cover the
 * orchestrator's own notices and blocking conditions.
 */
export type TeamMessageKind =
  | 'chat'
  | 'decision'
  | 'task'
  | 'handoff'
  | 'tool'
  | 'verification'
  | 'finding'
  | 'steering'
  | 'signoff'
  | 'system'
  | 'blocker';

export const TEAM_MESSAGE_KINDS: TeamMessageKind[] = [
  'chat',
  'decision',
  'task',
  'handoff',
  'tool',
  'verification',
  'finding',
  'steering',
  'signoff',
  'system',
  'blocker',
];

/** The non-role senders. A message `from` is a role id, or one of these. */
export const USER_SENDER = 'user';
export const SYSTEM_SENDER = 'system';

/** Author of a message: a role id, or `USER_SENDER` / `SYSTEM_SENDER`. */
export type MessageSender = string;

/** A typed pointer from a message to another artifact. */
export interface MessageRef {
  kind: 'message' | 'file' | 'task' | 'finding' | 'url';
  /** Target identifier (message id, file path, task id, finding id, or URL). */
  value: string;
  /** Optional human label. */
  label?: string;
}

/**
 * One message in a run's append-only conversation. Persisted as a single JSON
 * line in `conversation.jsonl`. `seq` orders messages within the run; `turnId`
 * ties a message to the role turn that produced it.
 */
export interface TeamMessage {
  /** Unique message id. */
  id: string;
  /** Run this message belongs to. */
  runId: string;
  /** Turn that produced this message. */
  turnId: string;
  /** Monotonic sequence number within the run. */
  seq: number;
  /** Author: a role id, `USER_SENDER`, or `SYSTEM_SENDER`. */
  from: MessageSender;
  /** Optional direct recipient (a role id, `USER_SENDER`, or 'all'). */
  to?: string;
  /** Optional channel/topic this message was posted to. */
  channel?: string;
  /** Semantic category. */
  kind: TeamMessageKind;
  /** The message text (English). */
  body: string;
  /** Optional references to other messages, files, tasks, or findings. */
  refs?: MessageRef[];
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Steering, sign-offs, verification, and the completion gate.
// ---------------------------------------------------------------------------

/** A user instruction injected mid-run to redirect the team's focus. */
export interface SteeringDirective {
  id: string;
  runId: string;
  /** The steering text (English). */
  body: string;
  /** Optional target ('all' or a role id); default applies to the whole team. */
  target?: string;
  createdAt: string;
  /** Whether the team has acknowledged/applied the directive. */
  acknowledged: boolean;
}

/** A role's declaration that, from its perspective, all assigned work is complete. */
export interface SignOff {
  runId: string;
  /** Role that signed off. */
  roleId: string;
  /** Whether the role considers the work done. */
  done: boolean;
  /** English justification for the sign-off (or for withholding it). */
  rationale: string;
  createdAt: string;
}

export type VerificationOutcome = 'passed' | 'failed' | 'inconclusive';

/** The result of a role verifying that a piece of work meets its acceptance criteria. */
export interface VerificationRecord {
  id: string;
  runId: string;
  /** Role that performed the verification. */
  roleId: string;
  /** What was verified (free-form English subject, e.g. a task id or feature). */
  subject: string;
  outcome: VerificationOutcome;
  /** English details of what was checked and the result. */
  details: string;
  /** Optional references (e.g. the task or finding verified). */
  refs?: MessageRef[];
  createdAt: string;
}

/**
 * The done-gate: a run completes only when every role required for sign-off has
 * declared its work done. This snapshot tracks progress toward that gate.
 */
export interface DoneGateState {
  /** Whether the gate is currently satisfied (all required roles signed off). */
  satisfied: boolean;
  /** Role ids whose sign-off is required. */
  requiredRoleIds: string[];
  /** Role ids that have signed off as done. */
  signedOffRoleIds: string[];
  /** Required roles still pending sign-off. */
  pendingRoleIds: string[];
  /** ISO-8601 timestamp of the last evaluation. */
  evaluatedAt?: string;
}

// ---------------------------------------------------------------------------
// Turns and the full persisted run record.
// ---------------------------------------------------------------------------

export type TeamTurnStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** One role's execution slot within the run. */
export interface TeamTurn {
  id: string;
  runId: string;
  seq: number;
  /** Role that owns this turn. */
  roleId: string;
  status: TeamTurnStatus;
  startedAt?: string;
  endedAt?: string;
}

/** Lifecycle of a team run. */
export type TeamRunStatus =
  | 'running'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted';

export const TEAM_RUN_STATUSES: TeamRunStatus[] = [
  'running',
  'paused',
  'blocked',
  'completed',
  'failed',
  'stopped',
  'interrupted',
];

/** The full persisted record of a team run (serialized to `team.json`). */
export interface TeamRun {
  id: string;
  /** Display name for the run. */
  name: string;
  /** The originating goal/prompt for this team. */
  goal: string;
  status: TeamRunStatus;
  /** Roles participating in this run. */
  roles: RoleInstance[];
  /** Optional source team-template id this run was created from. */
  templateId?: string;
  /** Next turn sequence number to assign. */
  turnSeq: number;
  /** Next message sequence number to assign. */
  messageSeq: number;
  /** Latest done-gate evaluation. */
  doneGate: DoneGateState;
  createdAt: string;
  updatedAt?: string;
  startedAt?: string;
  endedAt?: string;
  /** Human-readable English summary of the latest outcome. */
  message?: string;
}

// ---------------------------------------------------------------------------
// Compact UI snapshot (the conversation is streamed separately).
// ---------------------------------------------------------------------------

/** A compact per-role view for the UI snapshot. */
export interface RoleSnapshot {
  id: string;
  name: string;
  tool: AgentType;
  status: RoleStatus;
  canWriteCode: boolean;
  requiredForSignoff: boolean;
  signedOff: boolean;
  statusNote?: string;
}

/**
 * Compact, serializable snapshot of a run for the UI. Excludes the full
 * conversation (streamed over WS) and heavy fields; reuses the orchestrator's
 * `TaskSummary`/`FindingsSummary` so task and review progress render consistently.
 */
export interface TeamRunState {
  id: string;
  name: string;
  goal: string;
  status: TeamRunStatus;
  roles: RoleSnapshot[];
  doneGate: DoneGateState;
  /** Number of messages in the conversation so far. */
  messageCount: number;
  /** Most recent messages (tail) for quick display. */
  recentMessages: TeamMessage[];
  /** Pending steering directives not yet acknowledged. */
  pendingSteering: SteeringDirective[];
  /** Optional task progress (reused from the orchestrator). */
  tasks?: TaskSummary | null;
  /** Optional review findings summary (reused from the orchestrator). */
  findings?: FindingsSummary | null;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// REST/WS request/response DTOs.
// ---------------------------------------------------------------------------

/** A role definition supplied by the client when creating or editing a run. */
export interface RoleConfigInput {
  /** Optional source template id (for traceability). */
  templateId?: string;
  name: string;
  description?: string;
  persona?: string;
  tool: AgentType;
  model: string;
  effort: string;
  permission: string;
  canWriteCode: boolean;
  requiredForSignoff: boolean;
}

/** POST body to create a new team run. Provide a `templateId` or explicit `roles`. */
export interface CreateTeamRunRequest {
  name?: string;
  goal: string;
  templateId?: string;
  roles?: RoleConfigInput[];
}

export interface CreateTeamRunResponse {
  run: TeamRun;
}

/** POST body to inject a steering directive into a running team. */
export interface SteerRequest {
  body: string;
  /** Optional target ('all' or a role id). */
  target?: string;
}

export interface SteerResponse {
  directive: SteeringDirective;
}

/** GET response for a run snapshot. */
export interface TeamRunStateResponse {
  state: TeamRunState;
}

/** GET response listing the available templates. */
export interface TeamTemplatesResponse {
  teams: TeamTemplate[];
  roles: RoleTemplate[];
}

/** WS server→client events for a live team run. */
export type TeamEvent =
  | { type: 'message'; runId: string; message: TeamMessage }
  | { type: 'state'; runId: string; state: TeamRunState }
  | { type: 'role'; runId: string; role: RoleSnapshot }
  | { type: 'steering'; runId: string; directive: SteeringDirective }
  | { type: 'done'; runId: string; gate: DoneGateState };
