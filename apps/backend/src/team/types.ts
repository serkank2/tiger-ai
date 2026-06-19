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

/** A single open completion gate, with a stable machine code and a human reason. */
export interface DoneGateBlocker {
  /**
   * Machine-readable gate identifier (mirrors `completion.ts`'s `CompletionBlockerCode`
   * plus the synthetic `board_pending` for the team's per-role file task board). The UI
   * may switch on this; the prose is in `message`.
   */
  code: string;
  /** Clear English explanation of why this gate holds the run open. */
  message: string;
}

/**
 * The done-gate: a run completes only when EVERY completion condition is met —
 * every required role has signed off, verification passed, no steering is pending,
 * the task/finding queues are clear, and no blocker is open. This snapshot tracks
 * progress toward that gate and lists exactly what is still open.
 */
export interface DoneGateState {
  /**
   * Whether the FULL completion gate is satisfied (not merely the sign-off sub-gate):
   * true iff `openBlockers` is empty. The run can complete only when this is true.
   */
  satisfied: boolean;
  /** Role ids whose sign-off is required. */
  requiredRoleIds: string[];
  /** Role ids that have signed off as done. */
  signedOffRoleIds: string[];
  /** Required roles still pending sign-off. */
  pendingRoleIds: string[];
  /**
   * Every gate still holding the run open (tasks, findings, verification, steering,
   * sign-offs, board), in a stable evaluation order. Empty iff `satisfied`. The UI
   * renders this so the user can see exactly WHY a run is not done.
   */
  openBlockers: DoneGateBlocker[];
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
// Attempts: a run's work can be tried multiple times. Each attempt is recorded
// with its own git branch + diff summary + outcome (vibe-kanban "Attempt model").
// Attempts reframe a run as SOLUTION SAMPLING: try N times, compare side-by-side,
// then PROMOTE the best one (merge/checkout its branch into the workspace base).
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a single attempt:
 *  - `running`   — the attempt is the run's currently-active try.
 *  - `completed` — the attempt finished its work (its diff summary is captured).
 *  - `failed`    — the attempt ended without producing a usable result.
 *  - `promoted`  — this attempt's branch was merged/checked out into the base.
 *  - `superseded`— a newer attempt was started, so this one is no longer current
 *                  (its branch/diff are preserved for comparison).
 */
export type TeamAttemptStatus = 'running' | 'completed' | 'failed' | 'promoted' | 'superseded';

export const TEAM_ATTEMPT_STATUSES: TeamAttemptStatus[] = [
  'running',
  'completed',
  'failed',
  'promoted',
  'superseded',
];

/** The diff summary captured for an attempt (mirrors the changeset summary shape). */
export interface TeamAttemptSummary {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * One recorded attempt at a run's work. When the workspace is a git repo the
 * attempt is isolated on its own branch/worktree so concurrent or sequential
 * attempts never collide; the captured `summary` is its diff vs `baseRef`.
 */
export interface TeamAttempt {
  id: string;
  runId: string;
  /** 1-based ordinal within the run (attempt #1, #2, …). */
  attemptNumber: number;
  status: TeamAttemptStatus;
  /** The isolated branch this attempt's work lives on (null when not a git repo). */
  branch: string | null;
  /** The commit-ish the attempt branched from (null when not a git repo). */
  baseRef: string | null;
  /** Absolute path to the attempt's worktree (null when run in-place / non-git). */
  workspacePath: string | null;
  /** Captured diff summary (files/insertions/deletions) vs `baseRef`. */
  summary: TeamAttemptSummary | null;
  startedAt: string;
  completedAt?: string;
  promotedAt?: string;
  createdAt: string;
}

/** A compact per-attempt record for the UI snapshot. */
export interface TeamAttemptSnapshot {
  id: string;
  attemptNumber: number;
  status: TeamAttemptStatus;
  branch: string | null;
  baseRef: string | null;
  summary: TeamAttemptSummary | null;
  startedAt: string;
  completedAt?: string;
  promotedAt?: string;
  /** True for the run's currently-active attempt (the latest non-terminal one). */
  current: boolean;
  /** True once this attempt has been promoted into the base branch. */
  promoted: boolean;
}

// ---------------------------------------------------------------------------
// Team git-worktree-per-task isolation (opt-in; config.team.worktreePerTask).
// When ON and the workspace is a git repo, each role's claimed task runs in its
// own throwaway worktree on branch `kaplan/<runId>-<taskId>`, whose diff is
// captured and merged back to the workspace base on completion. A merge CONFLICT
// aborts the merge, marks the task blocked, and KEEPS the worktree intact for
// manual resolution (never auto-resolved). The records below are surfaced to the
// UI so the user can see + act on un-merged per-task branches.
// ---------------------------------------------------------------------------

/** Lifecycle of a per-task worktree. */
export type TeamTaskWorktreeStatus = 'active' | 'merged' | 'conflict' | 'failed';

/** A per-task git worktree the team created (or kept on a conflict). */
export interface TeamTaskWorktree {
  /** The role+turn task this worktree isolates. */
  taskId: string;
  /** Role that worked the task in this worktree. */
  roleId: string;
  /** Absolute path to the worktree working directory. */
  path: string;
  /** Branch checked out in the worktree (`kaplan/<runId>-<taskId>`). */
  branch: string;
  /** The base commit the worktree branched from (the merge-back target anchor). */
  baseRef: string;
  status: TeamTaskWorktreeStatus;
  /** Captured diff summary vs `baseRef` (when known). */
  summary?: TeamAttemptSummary | null;
  /** A human note (e.g. the conflicting files / merge error) when status is conflict/failed. */
  note?: string;
  createdAt: string;
  mergedAt?: string;
}

/** A compact per-task-worktree record for the UI snapshot. */
export interface TeamTaskWorktreeSnapshot {
  taskId: string;
  roleId: string;
  branch: string;
  status: TeamTaskWorktreeStatus;
  summary?: TeamAttemptSummary | null;
  note?: string;
  createdAt: string;
  mergedAt?: string;
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
  /** Terminal id of this role's most recent turn — open it to watch the live CLI. */
  terminalId?: string;
  /** How many turns this role has taken so far (UI loop counter). */
  turnCount?: number;
  /** This role's task-board counts (todo/in-progress/done). */
  tasks?: { todo: number; inProgress: number; done: number };
  /**
   * Messages waiting in this role's inbox (delivered via a `sendMessage` coordination verb)
   * that it has not yet seen at a turn. Surfaced so the UI can show a per-role inbox badge.
   */
  inbox?: number;
}

// ---------------------------------------------------------------------------
// Coordination verbs (CAO: handoff / assign / sendMessage). First-class
// directives an agent (typically the Lead) emits to delegate scoped work or
// deliver a message to another role. Parsed by `message-bus.ts` (with the same
// roleId trust boundary as sign-offs/verification) and applied by the
// orchestrator on top of the existing task-board + scheduler. See
// `compose-turn.ts` for how the verbs are documented to agents.
// ---------------------------------------------------------------------------

/** The three explicit coordination verbs an agent can emit. */
export type CoordinationVerb = 'handoff' | 'assign' | 'sendMessage';

/**
 * A handoff/assign/sendMessage directive a turn emitted.
 *  - `handoff`     — synchronous delegation: a scoped task to `to`, treated as a BLOCKING
 *                    dependency on the delegator until the target completes it.
 *  - `assign`      — asynchronous delegation: a scoped task to `to`, fire-and-forget (the
 *                    target reports back via a normal message; the delegator is not blocked).
 *  - `sendMessage` — deliver a message to `to`'s inbox, surfaced at its next turn.
 * `from` is forced to the executing role (trust boundary); `to` is agent-controlled.
 */
export interface CoordinationDirective {
  kind: 'coordination';
  verb: CoordinationVerb;
  /** Forced to the executing role id — never read from agent output. */
  fromRoleId: string;
  /** Target role id (agent-supplied; validated against the run's roles by the orchestrator). */
  toRoleId: string;
  /** Short title for the delegated task (handoff/assign) or a label for the message. */
  title?: string;
  /** The task description / acceptance criteria (handoff/assign) or message body (sendMessage). */
  body: string;
}

/** A pending blocking dependency created by a `handoff` (delegator waits on a target's task). */
export interface HandoffDependency {
  /** Unique id. */
  id: string;
  /** Role that handed the work off (and is blocked until the target completes it). */
  fromRoleId: string;
  /** Role the handed-off task is assigned to. */
  toRoleId: string;
  /** The target role's board task id this handoff is waiting on. */
  taskId: string;
  /** Short title of the handed-off task. */
  title: string;
  createdAt: string;
  /** Set once the target's task completed and the dependency cleared. */
  resolvedAt?: string;
}

/** One message sitting in a role's inbox (delivered by a `sendMessage` coordination verb). */
export interface InboxMessage {
  id: string;
  /** Role that sent the message. */
  fromRoleId: string;
  /** Optional short label/subject. */
  title?: string;
  body: string;
  createdAt: string;
  /** Set once the message has been surfaced to the recipient at a turn (then it is dropped). */
  deliveredAt?: string;
}

/** A compact handoff-dependency record for the UI snapshot. */
export interface HandoffDependencySnapshot {
  id: string;
  fromRoleId: string;
  toRoleId: string;
  taskId: string;
  title: string;
  /** True while the dependency is still blocking (target task not yet completed). */
  pending: boolean;
  createdAt: string;
  resolvedAt?: string;
}

/**
 * Full turn-lifecycle status the engine tracks (wider than {@link TeamTurnStatus}, which is the
 * pipeline turn vocabulary): a team turn may also end blocked/stopped/interrupted.
 */
export type TeamTurnSnapshotStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'stopped'
  | 'interrupted';

/** A compact per-turn record for the UI snapshot (the run's turn history). */
export interface TeamTurnSnapshot {
  id: string;
  roleId: string;
  roleName: string;
  status: TeamTurnSnapshotStatus;
  round: number;
  startedAt: string;
  endedAt?: string;
  reason?: string;
  /** Terminal id this turn ran on (open it to review the CLI scrollback). */
  terminalId?: string;
  /** Provider/CLI tool this turn ran on (for cost/duration attribution). */
  provider?: AgentType;
  /** Wall-clock duration of this turn in ms (when both start/end are known). */
  durationMs?: number;
}

/** A compact verification record for the UI snapshot. */
export interface TeamVerificationSnapshot {
  id: string;
  roleId?: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  command?: string;
  exitCode?: number;
  summary?: string;
  createdAt: string;
  completedAt?: string;
}

/** A compact sign-off record for the UI snapshot. */
export interface TeamSignoffSnapshot {
  id: string;
  roleId: string;
  roleName: string;
  createdAt: string;
  stale: boolean;
  staleReason?: string;
}

/** Per-role and per-run cost/duration metrics for the UI snapshot. */
export interface TeamMetrics {
  /** Total wall-clock duration of the run so far, in ms. */
  durationMs: number;
  /** Total role turns executed. */
  turnCount: number;
  /** Per-role rollup of turns, duration, and provider. */
  perRole: {
    roleId: string;
    roleName: string;
    provider?: AgentType;
    turnCount: number;
    durationMs: number;
  }[];
  /**
   * Token/cost totals when the execution model exposes them; null today (the CLIs
   * are driven as interactive PTYs and do not self-report usage). Extension point.
   */
  tokens?: number | null;
  cost?: number | null;
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
  /** The run's turn history (compact). */
  turns?: TeamTurnSnapshot[];
  /** The run's verification records (compact). */
  verifications?: TeamVerificationSnapshot[];
  /** The run's sign-off records (compact). */
  signoffs?: TeamSignoffSnapshot[];
  /** Per-role and per-run duration/provider (and token/cost when available) metrics. */
  metrics?: TeamMetrics;
  /**
   * The run's recorded attempts (vibe-kanban Attempt model), newest last. Empty for an
   * ordinary run that has never been (re)tried as an explicit attempt — such a run is
   * fully backward-compatible (it behaves as an implicit single attempt).
   */
  attempts?: TeamAttemptSnapshot[];
  /** The currently-active attempt id (the latest non-terminal attempt), if any. */
  currentAttemptId?: string | null;
  /** The promoted attempt id, if one has been promoted into the base branch. */
  promotedAttemptId?: string | null;
  /**
   * Open handoff dependencies (synchronous delegations still blocking their delegator).
   * Empty when no `handoff` verb is in flight — fully backward-compatible.
   */
  handoffs?: HandoffDependencySnapshot[];
  /**
   * Per-task git worktree branches that are still un-merged (kept on a merge conflict, or
   * awaiting a manual merge-back). Empty when team worktree-per-task is OFF or none are open.
   */
  taskWorktrees?: TeamTaskWorktreeSnapshot[];
  /** Total turns executed so far (UI loop counter). */
  turnCount?: number;
  /** Current coordination round (UI loop counter). */
  round?: number;
  /**
   * Human-readable status/intent line for the run (e.g. "Ready to start.", a waiting
   * reason when the Lead has idled, or a steering acknowledgement). Surfaced so the Team
   * screen can explain WHY a run is waiting/blocked without a separate question/reply model.
   */
  message?: string;
  /**
   * True once the run was Closed: its persistent CLI sessions were killed, so it cannot
   * resume (Stop is the resumable halt). The UI hides Resume/Close once this is set.
   */
  closed?: boolean;
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

/** Payload of the `changes`/`artifact` event: the run's git changeset summary. */
export interface TeamChangesEvent {
  isGitRepo: boolean;
  head: string | null;
  branch: string | null;
  summary: { files: number; insertions: number; deletions: number };
  generatedAt: string;
}

/**
 * WS server→client events for a live team run. The orchestrator emits each of these
 * via its EventEmitter; the WS layer fans them out as `team.<type>` frames. Payload
 * shapes here are the contract the frontend binds to.
 */
export type TeamEvent =
  | { type: 'message'; runId: string; message: TeamMessage }
  | { type: 'state'; runId: string; state: TeamRunState }
  | { type: 'role'; runId: string; role: RoleSnapshot }
  | { type: 'steering'; runId: string; directive: SteeringDirective }
  | { type: 'done'; runId: string; gate: DoneGateState }
  | { type: 'changes'; runId: string; changes: TeamChangesEvent };
