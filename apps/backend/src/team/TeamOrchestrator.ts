import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { AgentType, FindingsSummary, TaskSummary, TigerConfig } from '../orchestrator/types.js';
import { toAgentTypeOr } from '../orchestrator/types.js';
import {
  SYSTEM_SENDER,
  USER_SENDER,
  type MessageRef,
  type MessageSender,
  type RoleInstance as TeamModelRole,
  type SignOff as TeamModelSignOff,
  type SteeringDirective as TeamModelSteering,
  type TeamMessage,
  type TeamMessageKind,
  type VerificationRecord as TeamModelVerification,
} from './types.js';
import { TigerPaths } from '../orchestrator/paths.js';
import {
  NoopExecutionPersistence,
  leaseExpiresAt,
  ownerKey,
  type ExecutionOwner,
  type ExecutionPersistence,
  type ExecutionRunStatus,
} from '../orchestrator/persistence.js';
import { listTaskRecords, reclaimStaleTaskClaims, summarizeTasks } from '../orchestrator/tasks.js';
import { listFindings, reclaimStaleFindings, summarizeFindings } from '../orchestrator/findings.js';
import type { LimitGate } from '../limits/gate.js';
import type { LimitRuleDecision, LimitStatus } from '../limits/types.js';
import type { LimitService } from '../services/LimitService.js';
import type { TerminalManager } from '../terminal/TerminalManager.js';
// The dedicated AI-team modules this engine is scoped to compose: the pure
// done-gate + runaway guards (TASK-005), the phase-aware scheduler (TASK-007),
// and the one-turn CLI runner (TASK-006). The engine drives turn selection,
// completion, and real CLI turns through these instead of shipping reduced
// reimplementations under parallel interfaces.
import {
  evaluateCompletion,
  evaluateRunGate,
  type CompletionInput,
  type CompletionResult,
  type GuardCounters,
} from './completion.js';
import { logger } from '../obs/logger.js';
import { computeTeamChanges, type TeamChanges } from './changes.js';
import { notifyRunOutcome } from './notify.js';
import type { DoneGateState, DoneGateBlocker } from './types.js';
import { toRoleSnapshot } from './snapshot.js';
import {
  selectNextTurns,
  type TeamSchedulerState as PureSchedulerState,
  type TeamRole as PureSchedulerRole,
  type TeamRoleKind as PureRoleKind,
  type TeamTaskState as PureTaskState,
  type TeamFindingState as PureFindingState,
} from './scheduler.js';
import { runRoleTurn, teamRoleTerminalId, type RunRoleTurnResult } from './runner.js';
import { RoleCliSession } from './role-session.js';
import { TaskBoard, type AgentTask } from './task-board.js';

// Re-export the canonical conversation contract from `team/types.ts` so existing
// importers of this module keep working while binding to the authoritative shape
// (a string `from`, optional string `to`, required `turnId`, and `MessageRef` refs)
// that the message bus, routes, and UI all read.
export type { MessageRef, MessageSender, TeamMessage, TeamMessageKind } from './types.js';

const nowIso = (): string => new Date().toISOString();

export type TeamRunStatus = 'running' | 'paused' | 'blocked' | 'completed' | 'failed' | 'stopped' | 'interrupted';

export type TeamRoleStatus = 'idle' | 'running' | 'paused' | 'blocked' | 'done' | 'interrupted';
export type TeamTurnStatus = 'pending' | 'running' | 'completed' | 'blocked' | 'failed' | 'stopped' | 'interrupted';
export type TeamDirectiveStatus = 'pending' | 'acknowledged' | 'applied';
export type TeamVerificationStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

/**
 * Input shape for appending a conversation message. The message bus stamps the
 * run id and sequence number and fills in the turn id and timestamp when absent,
 * producing a {@link TeamMessage} that is byte-compatible with the `team/types.ts`
 * contract (`from` is a role id / `'user'` / `'system'`, `to` is a single id,
 * `refs` use the `MessageRef` shape).
 */
export interface TeamMessageDraft {
  id?: string;
  turnId?: string;
  from: MessageSender;
  to?: string;
  channel?: string;
  kind: TeamMessageKind;
  body: string;
  refs?: MessageRef[];
  createdAt?: string;
}

export interface TeamRoleInstance {
  id: string;
  name: string;
  templateId?: string;
  tool: AgentType;
  model?: string;
  effort?: string;
  permission?: string;
  persona?: string;
  responsibilities: string[];
  canWriteCode: boolean;
  requiredForSignoff: boolean;
  status: TeamRoleStatus;
  /** Free-form note about the current status (e.g. a single-role pause reason). */
  statusNote?: string;
  lastTurnAt?: string;
  /** Terminal id of this role's most recent turn (so the UI can open its live CLI). */
  activeTerminalId?: string;
  /** Task-board counts for this role (todo/in-progress/done). */
  taskCounts?: { todo: number; inProgress: number; done: number };
}

export interface TeamDirective {
  id: string;
  messageId: string;
  body: string;
  createdAt: string;
  acknowledgedAt?: string;
  appliedAt?: string;
  status: TeamDirectiveStatus;
}

export interface TeamSignoff {
  id: string;
  roleId: string;
  roleName: string;
  messageId?: string;
  createdAt: string;
  stale: boolean;
  staleReason?: string;
}

export interface TeamVerificationRecord {
  id: string;
  status: TeamVerificationStatus;
  /** Role that performed and self-reported the verification (when known). */
  roleId?: string;
  command?: string;
  /** Exit code of the verification command, when the role reported one. */
  exitCode?: number;
  summary?: string;
  createdAt: string;
  completedAt?: string;
}

export interface TeamTurnRecord {
  id: string;
  runId: string;
  roleId: string;
  roleName: string;
  status: TeamTurnStatus;
  round: number;
  startedAt: string;
  endedAt?: string;
  reason?: string;
  messageSeqs: number[];
  appliedDirectiveIds: string[];
  /** Terminal id this turn's CLI ran on (for live viewing / scrollback review). */
  terminalId?: string;
}

export interface TeamRunState {
  runId: string;
  workspace: string;
  tigerRoot: string;
  status: TeamRunStatus;
  goal: string;
  roles: TeamRoleInstance[];
  round: number;
  turnCount: number;
  currentTurn: TeamTurnRecord | null;
  turns: TeamTurnRecord[];
  directives: TeamDirective[];
  signoffs: TeamSignoff[];
  verifications: TeamVerificationRecord[];
  tasks: TaskSummary | null;
  findings: FindingsSummary | null;
  messageCount: number;
  pendingSteeringCount: number;
  /**
   * Token/cost consumed so far (same unit as the budget guard). The interactive-PTY CLIs do
   * not self-report usage today, so this stays 0; it is the extension point a future
   * usage-reporting runner would feed, after which the dormant budget guard can trip.
   */
  budgetSpent?: number;
  /**
   * Lead-owned sequencing: true when a non-Lead role has just finished (completed,
   * blocked, failed, verified, signed off, or reported findings) and the Lead must
   * review the result before any further role task is claimed. Guarantees the run
   * never auto-advances from one worker role to another without a Lead turn between.
   */
  leadReviewPending?: boolean;
  /**
   * Consecutive Lead turns that drove no progress (no task assigned, no sign-off, no
   * material decision/verification, and no pending prompt/review to act on). When this
   * reaches the idle ceiling the run waits instead of looping the Lead to the round cap.
   */
  consecutiveIdleLeadTurns?: number;
  materialChangeAt: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  message?: string;
  pauseRequested?: boolean;
  /**
   * True once the run has been Closed: its persistent CLI sessions were killed, so its
   * context is gone and it can never resume. Distinct from a Stopped run (sessions left
   * alive, resumable). Set only by {@link TeamOrchestrator.close}.
   */
  closed?: boolean;
  lease?: {
    executionRunId: string;
    owner: string;
    expiresAt: string | null;
  };
}

export interface CreateTeamRunInput {
  workspace: string;
  goal: string;
  roles: Omit<Partial<TeamRoleInstance>, 'status'>[];
  runId?: string;
}

/** A lightweight summary of a persisted run, for the run-history list. */
export interface TeamRunSummary {
  runId: string;
  name: string;
  goal: string;
  status: TeamRunStatus;
  roleCount: number;
  turnCount: number;
  messageCount: number;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  closed: boolean;
}

/** Fields a mid-run role reconfigure may change (all optional; id/status are preserved). */
export interface RoleReconfigurePatch {
  name?: string;
  persona?: string;
  tool?: string;
  model?: string;
  effort?: string;
  permission?: string;
  responsibilities?: string[];
  canWriteCode?: boolean;
  requiredForSignoff?: boolean;
}

/** The structured (JSON) body of a run export. */
export interface TeamRunExportJson {
  runId: string;
  name: string;
  goal: string;
  status: TeamRunStatus;
  workspace: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  roles: { id: string; name: string; tool: AgentType; canWriteCode: boolean; requiredForSignoff: boolean }[];
  doneGate: DoneGateState;
  metrics: import('./types.js').TeamMetrics;
  turns: TeamTurnRecord[];
  verifications: TeamVerificationRecord[];
  signoffs: TeamSignoff[];
  directives: TeamDirective[];
  messages: TeamMessage[];
}

/** A rendered export ready to stream as a download. */
export interface TeamRunExport {
  format: 'json' | 'markdown';
  filename: string;
  content: string;
}

export interface TeamRunTarget {
  workspace: string;
  runId: string;
}

export interface TeamScheduledTurn {
  roleId: string;
  reason?: string;
  taskId?: string;
  findingId?: string;
  /** A board task claimed for this turn (Lead-assigned work); filed done/requeued on completion. */
  task?: AgentTask;
}

export interface TeamSchedulerDecision {
  turns: TeamScheduledTurn[];
  reason?: string;
  terminal?: {
    status: Exclude<TeamRunStatus, 'running' | 'paused'>;
    reason: string;
  };
}

export interface TeamSchedulerContext {
  messages: TeamMessage[];
  pendingDirectives: TeamDirective[];
  latestVerification: TeamVerificationRecord | null;
  maxTurns: number;
  maxRounds: number;
}

export interface TeamScheduler {
  selectNextTurns(state: TeamRunState, context: TeamSchedulerContext): Promise<TeamSchedulerDecision> | TeamSchedulerDecision;
}

export interface TeamCompletionDecision {
  complete: boolean;
  reasons: string[];
  terminalStatus?: Exclude<TeamRunStatus, 'running' | 'paused' | 'completed'>;
}

export interface TeamCompletionContext {
  messages: TeamMessage[];
  latestVerification: TeamVerificationRecord | null;
}

export interface TeamCompletionGate {
  evaluate(state: TeamRunState, context: TeamCompletionContext): Promise<TeamCompletionDecision> | TeamCompletionDecision;
}

export interface TeamRoleTurnInput {
  workspace: string;
  paths: TeamPaths;
  runId: string;
  role: TeamRoleInstance;
  turn: TeamTurnRecord;
  state: TeamRunState;
  messages: TeamMessage[];
  appliedSteering: TeamDirective[];
  signal: AbortSignal;
  taskId?: string;
  findingId?: string;
  /** The gates still keeping the run open, injected into the role's prompt. */
  completionHints?: string[];
  /** The full board task assigned to this turn (its content goes into the prompt). */
  assignedTask?: { id: string; title?: string; content: string };
}

/** A task-board directive a turn emitted (claim/complete/block/needs_work/request_review). */
export interface TeamTaskDirective {
  taskId: string;
  action: 'claim' | 'complete' | 'block' | 'request_review' | 'needs_work';
  summary?: string;
}

export interface TeamRoleTurnResult {
  status: TeamTurnStatus;
  messages?: TeamMessageDraft[];
  signoffs?: { roleId?: string; messageId?: string; createdAt?: string }[];
  verification?: Omit<TeamVerificationRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: string };
  /** Structured verification self-reports the turn emitted (explicit command/exitCode/outcome). */
  verifications?: {
    roleId?: string;
    command?: string;
    exitCode?: number;
    outcome: 'passed' | 'failed' | 'inconclusive';
    summary?: string;
  }[];
  /** Task-board directives the turn emitted; the orchestrator applies them to the board + state. */
  taskDirectives?: TeamTaskDirective[];
  materialChange?: boolean;
  reason?: string;
}

export interface TeamTurnRunner {
  runRoleTurn(input: TeamRoleTurnInput): Promise<TeamRoleTurnResult>;
  /**
   * Release a run's persistent CLI sessions. `kill: true` (Close / run finished) tears
   * the terminals down; `kill: false` (Stop / pause) leaves them alive and pooled so the
   * run can resume into the same context. No-op for one-shot runners.
   */
  disposeRun?(runId: string, opts: { kill: boolean }): Promise<void>;
}

export interface TeamMessageBus {
  append(paths: TeamPaths, draft: TeamMessageDraft): Promise<TeamMessage>;
  list(paths: TeamPaths, afterSeq?: number): Promise<TeamMessage[]>;
}

export interface TeamReconcileResult {
  interruptedTurns: number;
  reclaimedTasks: number;
  reclaimedFindings: number;
}

export interface TeamPersistence {
  init?(): Promise<void>;
  saveRun(state: TeamRunState): Promise<void>;
  loadRun(workspace: string, runId: string): Promise<TeamRunState | null>;
  reconcileTeamOnBoot?(workspace: string, runId: string): Promise<TeamReconcileResult>;
}

export interface TeamLimitService {
  refresh(source?: 'manual' | 'cadence' | 'legacy'): Promise<LimitStatus>;
}

export interface TeamOrchestratorOptions {
  executionPersistence?: ExecutionPersistence;
  teamPersistence?: TeamPersistence;
  messageBus?: TeamMessageBus;
  scheduler?: TeamScheduler;
  runner?: TeamTurnRunner;
  completionGate?: TeamCompletionGate;
  limitGate?: LimitGate;
  limitService?: Pick<LimitService, 'refresh'> | TeamLimitService;
  owner?: ExecutionOwner;
  lockTtlMs?: number;
  maxTurns?: number;
  maxRounds?: number;
  /**
   * How many consecutive *failed* role turns (with no successful turn between them)
   * are tolerated before the run is given up as `failed`. A single failure no longer
   * kills the run — another role or a retry can recover — but a broken setup that
   * fails every turn must not loop to the round cap. Default 3.
   */
  maxConsecutiveFailures?: number;
  /**
   * How many consecutive *unproductive* Lead turns (no task assigned, no sign-off, no
   * material decision/verification, and nothing pending to act on) are tolerated before
   * the run idles/waits rather than spinning the Lead to the round cap. Default 2.
   */
  maxIdleLeadTurns?: number;
  /**
   * Wall-clock ceiling for a whole run, in milliseconds. When set (> 0), the dormant time
   * guard in completion.ts trips and the run ends as `failed` once elapsed since start
   * exceeds it. Disabled when omitted or <= 0.
   */
  maxDurationMs?: number;
  /**
   * Token/cost budget ceiling. When set (> 0) and the execution model reports usage, the
   * dormant budget guard trips and the run ends as `blocked` (limit). The interactive-PTY
   * CLIs do not currently self-report usage, so `budgetSpent` stays 0 and this never trips
   * unless a future runner supplies it — it is wired through as an extension point.
   */
  maxBudget?: number;
}

export class TeamPaths {
  readonly workspace: string;
  readonly runId: string;
  readonly tigerRoot: string;
  readonly runDir: string;
  readonly runtimeDir: string;
  readonly teamFile: string;
  readonly conversationFile: string;

  constructor(workspace: string, runId: string) {
    this.workspace = workspace;
    this.runId = runId;
    const tiger = new TigerPaths(workspace);
    this.tigerRoot = tiger.root;
    this.runDir = path.join(tiger.root, 'team', runId);
    this.runtimeDir = path.join(this.runDir, '.runtime');
    this.teamFile = path.join(this.runDir, 'team.json');
    this.conversationFile = path.join(this.runDir, 'conversation.jsonl');
  }

  promptFile(turnId: string): string {
    return path.join(this.runtimeDir, `${turnId}.prompt.md`);
  }

  outputFile(turnId: string): string {
    return path.join(this.runtimeDir, `${turnId}.output.md`);
  }

  markerFile(turnId: string): string {
    return path.join(this.runtimeDir, `${turnId}.done`);
  }

  rel(abs: string): string {
    return path.relative(this.tigerRoot, abs).replace(/\\/g, '/');
  }
}

export class FileTeamMessageBus implements TeamMessageBus {
  private readonly gates = new Map<string, Promise<unknown>>();
  // In-memory transcript per conversation file (keyed by absolute path). A cached
  // entry means this bus is the file's authoritative writer (it has appended to
  // it), so the next sequence number and the full transcript are served from
  // memory instead of re-reading and re-parsing the whole JSONL on every append
  // and every turn — which would otherwise make a long run's message I/O O(N^2).
  // Conversation files are single-writer per run (execution-lease guarded), so the
  // cache cannot drift from disk.
  private readonly cache = new Map<string, TeamMessage[]>();

  async append(paths: TeamPaths, draft: TeamMessageDraft): Promise<TeamMessage> {
    return this.serialize(paths.conversationFile, async () => {
      await fs.mkdir(path.dirname(paths.conversationFile), { recursive: true });
      const messages = await this.ensureCache(paths);
      const seq = (messages.length ? messages[messages.length - 1]!.seq : 0) + 1;
      const message: TeamMessage = {
        id: draft.id ?? nanoid(),
        runId: paths.runId,
        turnId: draft.turnId ?? '',
        seq,
        from: draft.from,
        to: draft.to,
        channel: draft.channel,
        kind: draft.kind,
        body: draft.body,
        refs: draft.refs,
        createdAt: draft.createdAt ?? nowIso(),
      };
      await fs.appendFile(paths.conversationFile, `${JSON.stringify(message)}\n`, 'utf8');
      messages.push(message);
      return message;
    });
  }

  async list(paths: TeamPaths, afterSeq = 0): Promise<TeamMessage[]> {
    const messages = this.cache.get(paths.conversationFile) ?? (await this.readConversation(paths));
    // Return a fresh array (callers may keep or reorder it) over the shared,
    // immutable message records.
    return afterSeq > 0 ? messages.filter((message) => message.seq > afterSeq) : messages.slice();
  }

  // Seed the transcript from disk the first time this bus writes a conversation
  // file, then keep it current via `append`. Only writer-owned files are cached,
  // so a `list` for a run this process does not write (e.g. inspecting another
  // run) always reads disk and can never serve stale data.
  private async ensureCache(paths: TeamPaths): Promise<TeamMessage[]> {
    let messages = this.cache.get(paths.conversationFile);
    if (!messages) {
      messages = await this.readConversation(paths);
      this.cache.set(paths.conversationFile, messages);
    }
    return messages;
  }

  private async readConversation(paths: TeamPaths): Promise<TeamMessage[]> {
    const body = await fs.readFile(paths.conversationFile, 'utf8').catch(() => '');
    const out: TeamMessage[] = [];
    for (const line of body.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = parseJson<TeamMessage>(line);
      if (!parsed || parsed.runId !== paths.runId || typeof parsed.seq !== 'number') continue;
      out.push(parsed);
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.gates.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.gates.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}

export class FileTeamPersistence implements TeamPersistence {
  async init(): Promise<void> {}

  async saveRun(state: TeamRunState): Promise<void> {
    const paths = new TeamPaths(state.workspace, state.runId);
    await fs.mkdir(paths.runtimeDir, { recursive: true });
    await atomicWrite(paths.teamFile, JSON.stringify(state, null, 2));
  }

  async loadRun(workspace: string, runId: string): Promise<TeamRunState | null> {
    const paths = new TeamPaths(workspace, runId);
    const raw = await fs.readFile(paths.teamFile, 'utf8').catch(() => null);
    if (!raw) return null;
    return normalizeLoadedState(parseJson<TeamRunState>(raw));
  }

  async reconcileTeamOnBoot(workspace: string, runId: string): Promise<TeamReconcileResult> {
    const state = await this.loadRun(workspace, runId);
    const result: TeamReconcileResult = { interruptedTurns: 0, reclaimedTasks: 0, reclaimedFindings: 0 };
    if (!state) return result;

    let changed = false;
    const interruptTurn = (turn: TeamTurnRecord): void => {
      if (turn.status !== 'pending' && turn.status !== 'running') return;
      turn.status = 'interrupted';
      turn.endedAt = nowIso();
      turn.reason ??= 'Interrupted by backend restart before completion.';
      result.interruptedTurns++;
      changed = true;
    };
    for (const turn of state.turns) interruptTurn(turn);
    if (state.currentTurn) interruptTurn(state.currentTurn);
    if (state.status === 'running') {
      state.status = 'interrupted';
      state.message = 'Interrupted by backend restart before completion.';
      state.endedAt = nowIso();
      state.currentTurn = null;
      state.roles = state.roles.map((role) => (role.status === 'running' ? { ...role, status: 'interrupted' } : role));
      changed = true;
    }
    if (changed) await this.saveRun(state);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Default compositions of the dedicated team modules. Out of the box the engine
// drives turn selection through the pure phase-aware scheduler (TASK-007) and
// evaluates the code-enforced done-gate plus runaway guards through the
// completion module (TASK-005). Real CLI turns run through the one-turn runner
// (TASK-006) via `createTeamTurnRunner`, which needs a TerminalManager + config
// the orchestrator does not own and so is injected as a thin adapter.
// ---------------------------------------------------------------------------

/** Correction cycles are a stage-pipeline concept; that guard is disabled for team runs. */
const DISABLED_GUARD = -1;

/**
 * Default scheduler: Lead-owned sequencing. The Lead is the single decision-maker and
 * executor of the run — round/round-robin progression no longer drives work. The engine
 * claims a Lead-approved worker task from the per-role board only when NO Lead work is
 * pending; otherwise it consults this scheduler, which always gives the Lead the turn so
 * the Lead handles it first (process the next user prompt, review the latest role result,
 * assign the next task, or sign off) — never a blind rotation over the other roles. Pending
 * Lead work therefore takes strict priority over claiming the next queued worker task.
 *
 * Idle, not busy-loop: a Lead that stops advancing the run (no task assigned, no
 * sign-off, no material decision/verification, and nothing pending to act on) idles after
 * {@link maxIdleLeadTurns} turns. The engine then waits for a user prompt or new
 * Lead-assigned work instead of spinning the Lead to the round cap. Completion stays
 * code-gated (every required role must hold a fresh sign-off), so idling never falsely
 * completes the run.
 */
class LeadOwnedScheduler implements TeamScheduler {
  constructor(private readonly maxIdleLeadTurns: number) {}

  selectNextTurns(state: TeamRunState): TeamSchedulerDecision {
    if (state.status !== 'running') return { turns: [] };
    if (state.roles.length === 0) {
      return { turns: [], terminal: { status: 'blocked', reason: 'No team roles are configured.' } };
    }
    const leadId = resolveLeadRoleId(state.roles);
    if (!leadId) {
      return { turns: [], terminal: { status: 'blocked', reason: 'No Lead role could be resolved for this team.' } };
    }
    // Pending Lead work ALWAYS schedules the Lead and overrides the idle guard: a queued
    // user prompt or a just-finished role result the Lead must review takes priority so it
    // is never starved — even if the Lead had previously idled (e.g. a prompt arrives after
    // the run idled and is resumed). The run loop also blocks worker-task claiming whenever
    // this is true, so the Lead is reached before any further non-Lead work starts.
    const hasPendingPrompt = state.directives.some((directive) => directive.status === 'pending');
    if (hasPendingPrompt || state.leadReviewPending === true) {
      return {
        turns: [
          {
            roleId: leadId,
            reason: hasPendingPrompt
              ? 'Processing the latest user prompt and planning the next step.'
              : 'Reviewing the latest role result and deciding the next unit of work.',
          },
        ],
      };
    }
    // No pending Lead work: the Lead keeps driving (assign the next task / sign off) until it
    // stops advancing the run, then it idles/waits instead of looping to the round cap.
    if ((state.consecutiveIdleLeadTurns ?? 0) >= this.maxIdleLeadTurns) {
      return {
        turns: [],
        reason:
          'The Lead has no further action that advances the run; waiting for a user prompt or new Lead-assigned work.',
      };
    }
    return { turns: [{ roleId: leadId, reason: 'Coordinating the team and assigning the next unit of work.' }] };
  }
}

/**
 * Resolve which role acts as the Lead/coordinator: prefer a role whose kind is `lead`,
 * then `coordinator`, else fall back to the first configured role. The Lead owns the
 * flow — user prompts route to it, it sequences all work, and only it may delegate.
 */
function resolveLeadRoleId(roles: TeamRoleInstance[]): string | null {
  const firstOfKind = (kind: PureRoleKind): string | undefined =>
    roles.find((role) => deriveRoleKind(role) === kind)?.id;
  return firstOfKind('lead') ?? firstOfKind('coordinator') ?? roles[0]?.id ?? null;
}

/**
 * Default completion gate: assembles a `CompletionInput` from run state and
 * delegates to `evaluateRunGate` (TASK-005), which enforces the user's
 * "stop only when 100% sure every required role agrees the work is done" rule
 * (tasks, findings, verification, steering, per-role sign-off freshness) plus the
 * turn/round runaway guards — replacing the reduced built-in gate this engine
 * used to ship.
 */
class DefaultCompletionGate implements TeamCompletionGate {
  constructor(
    private readonly limits: { maxTurns: number; maxRounds: number; maxDurationMs?: number; maxBudget?: number },
  ) {}

  evaluate(state: TeamRunState): TeamCompletionDecision {
    const evaluation = evaluateRunGate(buildCompletionInput(state), buildGuardCounters(state), {
      maxTurns: this.limits.maxTurns,
      maxRounds: this.limits.maxRounds,
      maxCorrectionCycles: DISABLED_GUARD,
      maxDurationMs: this.limits.maxDurationMs,
      maxBudget: this.limits.maxBudget,
    });
    // The pure done-gate reads the shared Tiger task summary, which does NOT include the
    // team's per-role file task board. Lead-assigned work that is still queued (todo) or in
    // progress must also block completion — otherwise a Lead turn that assigns a task and
    // then signs off (with a passed verification present) could complete the run while a
    // worker task it just queued is still unstarted. Account for the board here.
    const boardPending = teamBoardPending(state);
    const boardReason = `${boardPending} Lead-assigned task(s) are still queued or in progress on the team task board.`;
    if (evaluation.complete) {
      return boardPending === 0 ? { complete: true, reasons: [] } : { complete: false, reasons: [boardReason] };
    }
    const reasons = boardPending > 0 ? [...evaluation.reasons, boardReason] : evaluation.reasons;
    if (evaluation.status === 'running') return { complete: false, reasons };
    return {
      complete: false,
      reasons,
      terminalStatus: evaluation.status === 'failed' ? 'failed' : 'blocked',
    };
  }
}

/** Count Lead-assigned tasks still queued (todo) or in progress across every role's board. */
function teamBoardPending(state: TeamRunState): number {
  let pending = 0;
  for (const role of state.roles) {
    const counts = role.taskCounts;
    if (counts) pending += (counts.todo ?? 0) + (counts.inProgress ?? 0);
  }
  return pending;
}

class MissingTeamTurnRunner implements TeamTurnRunner {
  async runRoleTurn(): Promise<TeamRoleTurnResult> {
    return {
      status: 'failed',
      reason: 'No team turn runner is configured.',
      messages: [
        {
          from: SYSTEM_SENDER,
          kind: 'blocker',
          body: 'No team turn runner is configured.',
        },
      ],
    };
  }
}

export interface TeamTurnRunnerAdapterOptions {
  manager: TerminalManager;
  config: TigerConfig;
  /** Optional cap on transcript messages injected into each turn prompt. */
  transcriptMaxMessages?: number;
}

/**
 * Bridge the dedicated one-turn runner (`team/runner.ts`, TASK-006) onto the
 * engine's {@link TeamTurnRunner} contract. The runner needs a TerminalManager +
 * TigerConfig the orchestrator does not own, so it is wired here as a thin
 * adapter: this maps the engine's {@link TeamRoleTurnInput} to the runner's
 * `RunRoleTurnOptions` and its `RunRoleTurnResult` back to a
 * {@link TeamRoleTurnResult} the engine can apply.
 */
/** Approx characters fed to a role's CLI before it is asked to compact its context. */
const COMPACT_THRESHOLD_CHARS = 160_000;

export function createTeamTurnRunner(options: TeamTurnRunnerAdapterOptions): TeamTurnRunner {
  // One long-lived CLI session per (run, role). Reusing the running REPL across turns
  // preserves the agent's context and avoids relaunching the CLI every turn.
  const sessions = new Map<string, RoleCliSession>();
  const keyOf = (runId: string, roleId: string): string => `${runId}::${roleId}`;

  return {
    async runRoleTurn(input: TeamRoleTurnInput): Promise<TeamRoleTurnResult> {
      const termId = teamRoleTerminalId(input.runId, input.role.id);
      const key = keyOf(input.runId, input.role.id);
      let session = sessions.get(key);
      if (!session) {
        session = new RoleCliSession({
          manager: options.manager,
          termId,
          tool: input.role.tool,
          timing: options.config.timing,
        });
        sessions.set(key, session);
      }

      const result = await runRoleTurn({
        manager: options.manager,
        paths: new TigerPaths(input.workspace),
        config: options.config,
        runId: input.runId,
        turnId: input.turn.id,
        // Stable per-role terminal id + the live session: the role keeps one terminal the
        // UI can watch across turns, and the REPL retains its context between turns.
        terminalId: termId,
        session,
        role: {
          id: input.role.id,
          name: input.role.name,
          persona: input.role.persona,
          responsibilities: input.role.responsibilities,
          agent: { tool: input.role.tool },
        },
        assignedTask: input.assignedTask
          ? { id: input.assignedTask.id, title: input.assignedTask.title, content: input.assignedTask.content }
          : input.taskId
            ? {
                id: input.taskId,
                content: `You are assigned ${input.taskId}. Consult the task board under the .tiger root for its full definition and acceptance criteria.`,
              }
            : undefined,
        finding: input.findingId
          ? {
              id: input.findingId,
              content: `You are assigned ${input.findingId}. Consult the review findings under the .tiger root for its details.`,
            }
          : undefined,
        steering: input.appliedSteering.map((directive) => directive.body),
        completionStatus: input.completionHints,
        transcriptMaxMessages: options.transcriptMaxMessages,
        model: input.role.model,
        effort: input.role.effort,
        permission: input.role.permission,
        signal: input.signal,
        // The orchestrator is the single authoritative writer of conversation.jsonl
        // (it assigns seq and emits the WS message event); the runner must not also
        // persist, or every message would be duplicated with a conflicting seq.
        persistTranscript: false,
      });

      // A session that died this turn (CLI exited, or a hard timeout poisoned it) must not be
      // reused — evict it so the next turn for this role spawns a fresh CLI instead of writing
      // into an unknown live state.
      if (!session.isAlive) {
        sessions.delete(key);
        return mapRunnerResult(result);
      }
      // When this role has fed its CLI a lot of context, ask it to compact before the
      // next turn so the live session stays efficient instead of growing unbounded.
      if (session.shouldCompact(COMPACT_THRESHOLD_CHARS)) {
        await session.compact(input.signal).catch(() => undefined);
      }
      return mapRunnerResult(result);
    },

    async disposeRun(runId: string, opts: { kill: boolean }): Promise<void> {
      for (const [key, session] of [...sessions.entries()]) {
        if (!key.startsWith(`${runId}::`)) continue;
        if (opts.kill) {
          await session.dispose().catch(() => undefined);
          sessions.delete(key);
        }
        // Stop (kill === false): leave the session alive and pooled so a resume can
        // continue in the same context.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pure adapters between the engine's run state and the dedicated team modules.
// ---------------------------------------------------------------------------

/** Assemble the pure scheduler's input from the engine's richer run state. */
function buildSchedulerState(state: TeamRunState, context: TeamSchedulerContext): PureSchedulerState {
  const readyForSignoff = workQueuesClear(state);
  const requiredRoleIds = state.roles.filter((role) => role.requiredForSignoff).map((role) => role.id);
  return {
    roles: state.roles.map(toSchedulerRole),
    status: 'running',
    activeTurns: [],
    pendingDirectives: context.pendingDirectives.map((directive) => ({ id: directive.id, status: 'pending' as const })),
    // When every tracked work item is done, steer the scheduler into the sign-off
    // phase and target exactly the roles whose sign-off the completion gate still
    // needs, so those accountable roles actually get turns to sign off.
    coordinatorDecision:
      readyForSignoff && requiredRoleIds.length > 0
        ? { phase: 'signoff', roleIds: requiredRoleIds, reason: 'All tracked work is done; collecting required sign-offs.' }
        : undefined,
    tasks: toSchedulerTasks(state.tasks),
    findings: toSchedulerFindings(state.findings),
    doneGate: { ready: readyForSignoff },
    currentRound: state.round,
    maxRounds: context.maxRounds,
  };
}

function toSchedulerRole(role: TeamRoleInstance, index: number): PureSchedulerRole {
  return { id: role.id, kind: deriveRoleKind(role), label: role.name, writeCapable: role.canWriteCode, order: index };
}

/** Map a role's id/name (and capabilities) onto the scheduler's role-kind taxonomy. */
function deriveRoleKind(role: TeamRoleInstance): PureRoleKind {
  const text = `${role.id} ${role.name}`.toLowerCase();
  if (/\blead\b|tech ?lead|team ?lead/.test(text)) return 'lead';
  if (/coordinat|manager|product owner|\bpm\b/.test(text)) return 'coordinator';
  if (/analy|requirement|business/.test(text)) return 'analyst';
  if (/develop|engineer|programmer|coder|implement/.test(text)) return 'developer';
  if (/test|\bqa\b|quality/.test(text)) return 'tester';
  if (/review/.test(text)) return 'reviewer';
  if (role.canWriteCode) return 'developer';
  if (role.requiredForSignoff) return 'signoff';
  return 'coordinator';
}

function toSchedulerTasks(tasks: TaskSummary | null): PureTaskState | undefined {
  if (!tasks || tasks.total === 0) return undefined;
  const exec = tasks.byExecution;
  const review = tasks.byReview;
  return {
    needsImplementation: exec.not_started + exec.in_progress,
    needsReview: review.pending + review.reviewing,
    readyForSignoff: exec.done === tasks.total ? review.approved + review.fixed : 0,
  };
}

function toSchedulerFindings(findings: FindingsSummary | null): PureFindingState | undefined {
  if (!findings || findings.total === 0) return undefined;
  return { open: findings.open, needsFix: findings.fixing };
}

/** True only when a task board exists, every task is done, and no finding is open/in-flight. */
function workQueuesClear(state: TeamRunState): boolean {
  const tasks = state.tasks;
  const tasksDone = !!tasks && tasks.total > 0 && tasks.byExecution.done === tasks.total;
  const findings = state.findings;
  const findingsClear = !findings || findings.open + findings.fixing === 0;
  return tasksDone && findingsClear;
}

/** Assemble the completion module's input snapshot from the engine's run state. */
function buildCompletionInput(state: TeamRunState): CompletionInput {
  return {
    tasks: state.tasks,
    findings: state.findings,
    verifications: state.verifications.map((record) => toModelVerification(record, state.runId)),
    steering: state.directives.map((directive) => toModelSteering(directive, state.runId)),
    roles: state.roles.map(toModelRole),
    signoffs: state.signoffs.map((signoff) => toModelSignOff(signoff, state.runId)),
    tasksUpdatedAt: state.materialChangeAt,
    findingsUpdatedAt: state.materialChangeAt,
  };
}

function buildGuardCounters(state: TeamRunState): GuardCounters {
  // Wall-clock elapsed since the run started, so the dormant time guard can trip. The
  // budget guard reads `state.metricsBudgetSpent` when a future runner reports usage; today
  // the interactive-PTY CLIs do not, so it stays 0 (the guard is then inert).
  const startedMs = state.startedAt ? Date.parse(state.startedAt) : NaN;
  const elapsedMs = Number.isNaN(startedMs) ? 0 : Math.max(0, Date.now() - startedMs);
  return {
    turns: state.turnCount,
    rounds: state.round,
    noProgressRounds: 0,
    correctionCycles: 0,
    elapsedMs,
    budgetSpent: state.budgetSpent ?? 0,
  };
}

function toModelVerification(record: TeamVerificationRecord, runId: string): TeamModelVerification {
  return {
    id: record.id,
    runId,
    roleId: record.roleId ?? '',
    subject: record.summary ?? record.command ?? record.id,
    outcome: record.status === 'passed' ? 'passed' : record.status === 'failed' ? 'failed' : 'inconclusive',
    details: record.summary ?? '',
    createdAt: record.completedAt ?? record.createdAt,
  };
}

function toModelSteering(directive: TeamDirective, runId: string): TeamModelSteering {
  return {
    id: directive.id,
    runId,
    body: directive.body,
    createdAt: directive.createdAt,
    acknowledged: directive.status !== 'pending',
  };
}

function toModelRole(role: TeamRoleInstance): TeamModelRole {
  return {
    id: role.id,
    templateId: role.templateId,
    name: role.name,
    description: '',
    persona: role.persona ?? '',
    agent: { tool: role.tool, model: role.model ?? '', effort: role.effort ?? '', permission: role.permission ?? '' },
    canWriteCode: role.canWriteCode,
    requiredForSignoff: role.requiredForSignoff,
    status: 'idle',
    signedOff: false,
    createdAt: role.lastTurnAt ?? '',
  };
}

function toModelSignOff(signoff: TeamSignoff, runId: string): TeamModelSignOff {
  return {
    runId,
    roleId: signoff.roleId,
    done: !signoff.stale,
    rationale: signoff.staleReason ?? '',
    createdAt: signoff.createdAt,
  };
}

/** Map the runner's result onto the engine's turn-lifecycle result. */
function mapRunnerResult(result: RunRoleTurnResult): TeamRoleTurnResult {
  const signoffs = result.parsed.signOffDirectives
    .filter((directive) => directive.status === 'done')
    .map((directive) => ({ roleId: directive.roleId }));
  const taskDirectives = result.parsed.taskDirectives.map((directive) => ({
    taskId: directive.taskId,
    action: directive.action,
    summary: directive.summary,
  }));
  const verifications = result.parsed.verificationDirectives.map((directive) => ({
    roleId: directive.roleId,
    command: directive.command,
    exitCode: directive.exitCode,
    outcome: directive.outcome,
    summary: directive.summary,
  }));
  return {
    status: runnerStateToTurnStatus(result.outcome.state),
    messages: result.parsed.messages.map(toEngineDraft),
    signoffs: signoffs.length ? signoffs : undefined,
    taskDirectives: taskDirectives.length ? taskDirectives : undefined,
    verifications: verifications.length ? verifications : undefined,
    reason: result.outcome.error,
  };
}

function runnerStateToTurnStatus(state: RunRoleTurnResult['outcome']['state']): TeamTurnStatus {
  if (state === 'completed') return 'completed';
  if (state === 'stopped') return 'stopped';
  return 'failed';
}

function toEngineDraft(message: TeamMessage): TeamMessageDraft {
  return {
    id: message.id,
    turnId: message.turnId,
    from: message.from,
    to: message.to,
    channel: message.channel,
    kind: message.kind,
    body: message.body,
    refs: message.refs,
    createdAt: message.createdAt,
  };
}

/**
 * Autonomous AI team run engine. It composes the pure scheduler, one-turn runner,
 * message bus, completion gate, limit checks, file queues, and shared execution
 * lease into a restart-safe, steerable run loop.
 */
export class TeamOrchestrator extends EventEmitter {
  private state: TeamRunState | null = null;
  private paths: TeamPaths | null = null;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  /** In-flight start/resume, so concurrent start()/resume() calls cannot launch two loops. */
  private starting: Promise<TeamRunState> | null = null;
  private activeExecutionRunId: string | null = null;
  private runLeaseHeartbeat: NodeJS.Timeout | null = null;
  private runLeaseRefresh: Promise<void> | null = null;
  private persistGate: Promise<unknown> = Promise.resolve();
  private lastBoundarySteering: TeamDirective[] = [];
  /** File-based per-agent task board for the active run (Lead-driven assignment). */
  private taskBoard: TaskBoard | null = null;
  /** Tasks claimed for the current in-flight turns, keyed by turn id, so completion can file them. */
  private turnTasks = new Map<string, AgentTask>();

  private readonly executionPersistence: ExecutionPersistence;
  private readonly teamPersistence: TeamPersistence;
  private readonly messageBus: TeamMessageBus;
  private readonly scheduler: TeamScheduler;
  private readonly runner: TeamTurnRunner;
  private readonly completionGate: TeamCompletionGate;
  private readonly owner: ExecutionOwner;
  private readonly lockTtlMs: number;
  private readonly maxTurns: number;
  private readonly maxRounds: number;
  private readonly maxConsecutiveFailures: number;
  private readonly maxIdleLeadTurns: number;
  private readonly maxDurationMs?: number;
  private readonly maxBudget?: number;
  /** Consecutive failed turns since the last successful turn (recovery guard). */
  private consecutiveTurnFailures = 0;
  /** Last emitted done-gate snapshot (JSON), so the `done` event fires only on change. */
  private lastDoneGateJson: string | null = null;
  /** Last emitted changes summary (JSON), so the `changes` event fires only on change. */
  private lastChangesJson: string | null = null;

  constructor(private readonly options: TeamOrchestratorOptions = {}) {
    super();
    this.executionPersistence = options.executionPersistence ?? new NoopExecutionPersistence();
    this.teamPersistence = options.teamPersistence ?? new FileTeamPersistence();
    this.messageBus = options.messageBus ?? new FileTeamMessageBus();
    this.owner = options.owner ?? { type: 'manual', id: `${process.pid}:team:${nanoid(6)}` };
    this.lockTtlMs = options.lockTtlMs ?? 30 * 60_000;
    this.maxTurns = options.maxTurns ?? 200;
    this.maxRounds = options.maxRounds ?? 200;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.maxIdleLeadTurns = options.maxIdleLeadTurns ?? 2;
    this.maxDurationMs = options.maxDurationMs;
    this.maxBudget = options.maxBudget;
    this.scheduler = options.scheduler ?? new LeadOwnedScheduler(this.maxIdleLeadTurns);
    this.runner = options.runner ?? new MissingTeamTurnRunner();
    this.completionGate =
      options.completionGate ??
      new DefaultCompletionGate({
        maxTurns: this.maxTurns,
        maxRounds: this.maxRounds,
        maxDurationMs: this.maxDurationMs,
        maxBudget: this.maxBudget,
      });
  }

  async createTeamRun(input: CreateTeamRunInput): Promise<TeamRunState> {
    // Guard against replacing the in-memory run while a previous run's loop is still alive:
    // createTeamRun reassigns `this.state`, and a live loop would then drive against the new
    // run's state — mixing two runs and corrupting persistence/messages, and making
    // stop/close target the wrong execution. Require the active run to be halted first.
    if (this.loop) {
      throw httpError(
        409,
        `a team run (${this.state?.status ?? 'active'}) is still running; stop or close it before starting a new one`,
      );
    }
    const workspace = path.resolve(input.workspace);
    const goal = input.goal.trim();
    if (!goal) throw httpError(400, 'team goal is required');
    const runId = input.runId ?? nanoid();
    const paths = new TeamPaths(workspace, runId);
    await this.teamPersistence.init?.();
    await this.executionPersistence.init();
    await fs.mkdir(paths.runtimeDir, { recursive: true });

    const createdAt = nowIso();
    const roles = normalizeRoles(input.roles);
    this.state = {
      runId,
      workspace,
      tigerRoot: paths.tigerRoot,
      status: 'paused',
      goal,
      roles,
      round: 0,
      turnCount: 0,
      currentTurn: null,
      turns: [],
      directives: [],
      signoffs: [],
      verifications: [],
      tasks: null,
      findings: null,
      messageCount: 0,
      pendingSteeringCount: 0,
      leadReviewPending: false,
      consecutiveIdleLeadTurns: 0,
      materialChangeAt: createdAt,
      createdAt,
      message: 'Ready to start.',
    };
    this.paths = paths;
    this.taskBoard = new TaskBoard(paths.runDir);
    await this.taskBoard.init(roles.map((role) => role.id));
    await this.refreshWorkQueues();
    // The goal is the Lead's first piece of work: seed it as a user prompt addressed to
    // the Lead so the first executable turn is the Lead, with the goal in its context.
    // It is queued as a pending steering directive (it stays a completion blocker until
    // the Lead has processed it, and never routes to a non-Lead role).
    const leadId = resolveLeadRoleId(roles);
    const seed = await this.appendMessage({
      from: USER_SENDER,
      to: leadId ?? undefined,
      kind: 'steering',
      channel: 'directives',
      body: goal,
      createdAt,
    });
    this.state.directives.push({
      id: nanoid(),
      messageId: seed.id,
      body: goal,
      createdAt: seed.createdAt,
      status: 'pending',
    });
    this.state.pendingSteeringCount = this.countPendingSteering();
    await this.persistState();
    this.emitState();
    return this.getState();
  }

  async start(target?: string | TeamRunTarget): Promise<TeamRunState> {
    await this.ensureLoaded(target);
    const state = this.requireState();
    if (state.status === 'running' && this.loop) return this.getState();
    if (isTerminalStatus(state.status)) throw httpError(409, `team run is already ${state.status}`);
    return this.startLoop('running');
  }

  async stop(reason = 'Stopped by user.'): Promise<TeamRunState> {
    const state = this.requireState();
    if (state.status === 'stopped') return this.getState();
    this.abort?.abort();
    if (state.currentTurn && (state.currentTurn.status === 'pending' || state.currentTurn.status === 'running')) {
      state.currentTurn.status = 'interrupted';
      state.currentTurn.endedAt = nowIso();
      state.currentTurn.reason = reason;
      const matching = state.turns.find((turn) => turn.id === state.currentTurn?.id);
      if (matching) Object.assign(matching, state.currentTurn);
    }
    await this.finishRun('stopped', reason);
    return this.getState();
  }

  /**
   * Close the run: stop the prompt flow AND tear down the persistent CLI terminals.
   * Unlike {@link stop} (which leaves the sessions alive so the run can resume into the
   * same context), close kills them — "Stop pauses, Close ends".
   */
  async close(reason = 'Closed by user.'): Promise<TeamRunState> {
    const state = this.requireState();
    this.abort?.abort();
    if (!isTerminalStatus(state.status)) {
      if (state.currentTurn && (state.currentTurn.status === 'pending' || state.currentTurn.status === 'running')) {
        state.currentTurn.status = 'interrupted';
        state.currentTurn.endedAt = nowIso();
        state.currentTurn.reason = reason;
        const matching = state.turns.find((turn) => turn.id === state.currentTurn?.id);
        if (matching) Object.assign(matching, state.currentTurn);
      }
      await this.finishRun('stopped', reason);
    }
    await this.runner.disposeRun?.(state.runId, { kill: true }).catch(() => undefined);
    // Mark the run permanently closed: its sessions are gone, so it must not resume into a
    // dead context. `resume()` rejects a closed run; the UI surfaces this via the DTO.
    state.closed = true;
    state.message = reason;
    await this.persistState();
    this.emitState();
    return this.getState();
  }

  async pause(reason = 'Paused by user.'): Promise<TeamRunState> {
    const state = this.requireState();
    if (state.status === 'paused') return this.getState();
    if (state.status !== 'running') throw httpError(409, `cannot pause a ${state.status} team run`);
    state.pauseRequested = true;
    state.message = reason;
    await this.persistState();
    this.emitState();
    return this.getState();
  }

  async resume(target?: string | TeamRunTarget): Promise<TeamRunState> {
    await this.ensureLoaded(target);
    const state = this.requireState();
    if (state.status === 'running' && this.loop) return this.getState();
    // Only a genuinely ended run cannot resume. 'completed'/'failed' disposed their role
    // sessions, so there is no context to re-enter. A 'stopped' run is a resumable halt:
    // Stop leaves the persistent role sessions ALIVE (Close is what kills them), so Resume
    // re-enters the same run context. 'paused'/'interrupted'/'blocked' also remain resumable.
    if (state.status === 'completed' || state.status === 'failed') {
      throw httpError(409, `cannot resume a ${state.status} team run`);
    }
    // A Closed run killed its persistent sessions — there is no context to re-enter, so it
    // cannot resume (Stop is the resumable halt; Close ends the run).
    if (state.closed) {
      throw httpError(409, 'cannot resume a closed team run; start a new run instead');
    }
    return this.startLoop('running');
  }

  async steer(body: string, from: MessageSender = USER_SENDER): Promise<TeamMessage> {
    const state = this.requireState();
    if (state.status !== 'running' && state.status !== 'paused' && state.status !== 'interrupted' && state.status !== 'blocked') {
      throw httpError(409, `cannot steer a ${state.status} team run`);
    }
    const text = body.trim();
    if (!text) throw httpError(400, 'steering directive is required');
    const createdAt = nowIso();
    // Every user prompt goes to the Lead, never to whichever role would run next. It is
    // queued (FIFO) as a pending directive the Lead picks up on its next turn; the Lead
    // owns decomposition and sequencing. A user scope change stales existing sign-offs.
    const message = await this.appendMessage({
      from,
      to: this.leadRoleId() ?? undefined,
      kind: 'steering',
      channel: 'directives',
      body: text,
      createdAt,
    });
    const directive: TeamDirective = {
      id: nanoid(),
      messageId: message.id,
      body: text,
      createdAt: message.createdAt,
      status: 'pending',
    };
    state.directives.push(directive);
    this.emitSteering(directive);
    state.materialChangeAt = message.createdAt;
    this.staleSignoffs('Steering changed the run scope.');
    state.pendingSteeringCount = this.countPendingSteering();
    const idledWaiting = state.status === 'blocked' && !this.loop;
    state.message = idledWaiting
      ? 'Your prompt was queued for the Lead; resuming the run so the Lead picks it up.'
      : 'Your prompt was queued for the Lead and will be picked up on the Lead\'s next turn.';
    await this.persistState();
    this.emitState();
    // If the run had idled to a resumable waiting state (status 'blocked' with the loop
    // stopped), a new Lead prompt should make it continue WITHOUT a separate manual resume:
    // restart the loop so the Lead picks up the queued prompt. (A user-initiated 'paused'
    // run is intentionally NOT auto-resumed.) Best-effort: if resume fails, the prompt is
    // still queued and the user can resume manually.
    if (idledWaiting) {
      await this.resume().catch(() => undefined);
    }
    return message;
  }

  getState(): TeamRunState {
    return clone(this.requireState());
  }

  /** Like {@link getState} but returns null instead of throwing when no run is loaded. */
  tryGetState(): TeamRunState | null {
    return this.state ? clone(this.state) : null;
  }

  /** The workspace of the run currently held in memory, if any. */
  activeWorkspace(): string | null {
    return this.state?.workspace ?? null;
  }

  /**
   * Load the most recently persisted run for a workspace into memory. Used by
   * `GET /state` so a page reload (or a backend restart) re-surfaces the run the
   * user was watching instead of showing an empty Team view. Returns null when the
   * workspace has no persisted team run.
   */
  async loadLatestRun(workspace: string): Promise<TeamRunState | null> {
    const resolved = path.resolve(workspace);
    const teamsDir = path.join(new TigerPaths(resolved).root, 'team');
    let entries: string[];
    try {
      entries = await fs.readdir(teamsDir);
    } catch {
      return null;
    }
    let newest: { runId: string; mtimeMs: number } | null = null;
    for (const runId of entries) {
      const stat = await fs.stat(path.join(teamsDir, runId, 'team.json')).catch(() => null);
      if (stat?.isFile() && (!newest || stat.mtimeMs > newest.mtimeMs)) newest = { runId, mtimeMs: stat.mtimeMs };
    }
    if (!newest) return null;
    await this.loadRun(resolved, newest.runId);
    return this.getState();
  }

  /**
   * List the persisted runs for a workspace (newest first), as lightweight summaries for a
   * run-history view. Reads each run's `team.json` without making it the active run, so the
   * UI can browse past runs while a different run is live. Generalizes `loadLatestRun`.
   */
  async listRuns(workspace: string): Promise<TeamRunSummary[]> {
    const resolved = path.resolve(workspace);
    const teamsDir = path.join(new TigerPaths(resolved).root, 'team');
    let entries: string[];
    try {
      entries = await fs.readdir(teamsDir);
    } catch {
      return [];
    }
    const summaries: (TeamRunSummary & { mtimeMs: number })[] = [];
    for (const runId of entries) {
      const file = path.join(teamsDir, runId, 'team.json');
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) continue;
      const loaded = await this.teamPersistence.loadRun(resolved, runId).catch(() => null);
      if (!loaded) continue;
      summaries.push({
        runId: loaded.runId,
        name: deriveRunNameFromGoal(loaded.goal),
        goal: loaded.goal,
        status: loaded.status,
        roleCount: loaded.roles.length,
        turnCount: loaded.turnCount,
        messageCount: loaded.messageCount,
        createdAt: loaded.createdAt,
        startedAt: loaded.startedAt,
        endedAt: loaded.endedAt,
        closed: loaded.closed === true,
        mtimeMs: stat.mtimeMs,
      });
    }
    summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return summaries.map(({ mtimeMs: _omit, ...rest }) => rest);
  }

  /**
   * Read-only rehydrate of a past run's state (its snapshot) WITHOUT making it the active
   * run or touching the live loop. Used to re-open a past run from history. The live run (if
   * any) is left untouched. Returns the loaded state; throws 404 when the run is unknown.
   */
  async readRun(workspace: string, runId: string): Promise<TeamRunState> {
    const resolved = path.resolve(workspace);
    const loaded = await this.teamPersistence.loadRun(resolved, runId);
    if (!loaded) throw httpError(404, `team run ${runId} was not found`);
    return loaded;
  }

  /**
   * Build a downloadable export of a run: its full conversation transcript, turn history,
   * verifications, sign-offs, directives, the done-gate, and metrics. `format: 'markdown'`
   * renders a human-readable document; `'json'` (default) returns the structured payload.
   * Read-only; works for any run (active or historical) in a workspace.
   */
  async exportRun(workspace: string, runId: string, format: 'json' | 'markdown' = 'json'): Promise<TeamRunExport> {
    const resolved = path.resolve(workspace);
    const state = await this.teamPersistence.loadRun(resolved, runId);
    if (!state) throw httpError(404, `team run ${runId} was not found`);
    const messages = await this.messageBus.list(new TeamPaths(resolved, runId));
    const doneGate = TeamOrchestrator.computeDoneGate(state);
    const metrics = computeRunMetrics(state);
    const payload: TeamRunExportJson = {
      runId: state.runId,
      name: deriveRunNameFromGoal(state.goal),
      goal: state.goal,
      status: state.status,
      workspace: resolved,
      createdAt: state.createdAt,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      roles: state.roles.map((role) => ({
        id: role.id,
        name: role.name,
        tool: role.tool,
        canWriteCode: role.canWriteCode,
        requiredForSignoff: role.requiredForSignoff,
      })),
      doneGate,
      metrics,
      turns: state.turns,
      verifications: state.verifications,
      signoffs: state.signoffs,
      directives: state.directives,
      messages,
    };
    if (format === 'markdown') {
      return { format: 'markdown', filename: `team-run-${runId}.md`, content: renderRunMarkdown(payload) };
    }
    return { format: 'json', filename: `team-run-${runId}.json`, content: JSON.stringify(payload, null, 2) };
  }

  /**
   * Pause a SINGLE role mid-run (it takes no further turns until resumed) without halting the
   * whole run. The scheduler/claim path skips a paused role. Distinct from {@link pause},
   * which halts the entire run at the next boundary.
   */
  async pauseRole(roleId: string, reason = 'Role paused by user.'): Promise<TeamRunState> {
    const state = this.requireState();
    const role = state.roles.find((entry) => entry.id === roleId);
    if (!role) throw httpError(404, `role ${roleId} is not part of this run`);
    if (role.id === this.leadRoleId()) throw httpError(409, 'the Lead role cannot be paused; pause the whole run instead');
    if (role.status !== 'paused') {
      role.status = 'paused';
      role.statusNote = reason;
      await this.persistState();
      this.emitState();
      this.emitRole(role);
    }
    return this.getState();
  }

  /** Resume a single paused role so it can be scheduled/claimed again. */
  async resumeRole(roleId: string): Promise<TeamRunState> {
    const state = this.requireState();
    const role = state.roles.find((entry) => entry.id === roleId);
    if (!role) throw httpError(404, `role ${roleId} is not part of this run`);
    if (role.status === 'paused') {
      role.status = 'idle';
      role.statusNote = undefined;
      await this.persistState();
      this.emitState();
      this.emitRole(role);
    }
    return this.getState();
  }

  /** Steer a SINGLE role: queue a directive addressed to that specific role (not the Lead). */
  async steerRole(roleId: string, body: string, from: MessageSender = USER_SENDER): Promise<TeamMessage> {
    const state = this.requireState();
    const role = state.roles.find((entry) => entry.id === roleId);
    if (!role) throw httpError(404, `role ${roleId} is not part of this run`);
    const text = body.trim();
    if (!text) throw httpError(400, 'steering directive is required');
    const message = await this.appendMessage({
      from,
      to: roleId,
      kind: 'steering',
      channel: 'directives',
      body: text,
      createdAt: nowIso(),
    });
    // A role-targeted steer is delivered via the transcript the role reads (it is addressed
    // `to` that role); it is NOT a Lead-queued completion-blocking directive. It still stales
    // sign-offs because it changes the run scope.
    state.materialChangeAt = message.createdAt;
    this.staleSignoffs(`Steering changed the scope for role ${role.name}.`);
    await this.persistState();
    this.emitState();
    return message;
  }

  /**
   * Add a role to the run mid-flight. The new role starts idle with an initialized task board,
   * and stales existing sign-offs (the team composition changed). Cannot duplicate a role id.
   */
  async addRole(seed: Omit<Partial<TeamRoleInstance>, 'status'>): Promise<TeamRunState> {
    const state = this.requireState();
    const [role] = normalizeRoles([seed]);
    if (!role) throw httpError(400, 'a valid role definition is required');
    if (state.roles.some((entry) => entry.id === role.id)) {
      throw httpError(409, `role ${role.id} already exists in this run`);
    }
    state.roles.push(role);
    if (this.taskBoard) await this.taskBoard.ensureRole(role.id).catch(() => undefined);
    await this.refreshWorkQueues();
    this.staleSignoffs('A role was added to the team.');
    state.materialChangeAt = nowIso();
    await this.persistState();
    this.emitState();
    this.emitRole(role);
    return this.getState();
  }

  /**
   * Remove a role from the run mid-flight. The Lead cannot be removed (it owns sequencing).
   * Any queued board work for the role is left on disk (inspectable) but no longer scheduled;
   * removing a required-for-sign-off role re-evaluates the done-gate. Stales sign-offs.
   */
  async removeRole(roleId: string): Promise<TeamRunState> {
    const state = this.requireState();
    const role = state.roles.find((entry) => entry.id === roleId);
    if (!role) throw httpError(404, `role ${roleId} is not part of this run`);
    if (role.id === this.leadRoleId()) throw httpError(409, 'the Lead role cannot be removed');
    if (state.currentTurn?.roleId === roleId) throw httpError(409, 'cannot remove a role while its turn is running');
    state.roles = state.roles.filter((entry) => entry.id !== roleId);
    // Drop the removed role's sign-offs so it never counts toward (or blocks) completion.
    state.signoffs = state.signoffs.filter((signoff) => signoff.roleId !== roleId);
    this.staleSignoffs('A role was removed from the team.');
    state.materialChangeAt = nowIso();
    await this.persistState();
    this.emitState();
    return this.getState();
  }

  /**
   * Reconfigure an existing role's CLI settings / persona / capabilities mid-run. Only the
   * provided fields change; the role's id and live status are preserved. Changing
   * capabilities or sign-off requirement stales sign-offs (the contract changed).
   */
  async reconfigureRole(roleId: string, patch: RoleReconfigurePatch): Promise<TeamRunState> {
    const state = this.requireState();
    const role = state.roles.find((entry) => entry.id === roleId);
    if (!role) throw httpError(404, `role ${roleId} is not part of this run`);
    if (typeof patch.name === 'string' && patch.name.trim()) role.name = patch.name.trim();
    if (typeof patch.persona === 'string') role.persona = patch.persona;
    if (patch.tool) role.tool = toAgentTypeOr(patch.tool, role.tool);
    if (patch.model !== undefined) role.model = patch.model || undefined;
    if (patch.effort !== undefined) role.effort = patch.effort || undefined;
    if (patch.permission !== undefined) role.permission = patch.permission || undefined;
    if (Array.isArray(patch.responsibilities)) role.responsibilities = patch.responsibilities.filter(Boolean);
    let contractChanged = false;
    if (typeof patch.canWriteCode === 'boolean' && patch.canWriteCode !== role.canWriteCode) {
      role.canWriteCode = patch.canWriteCode;
      contractChanged = true;
    }
    if (typeof patch.requiredForSignoff === 'boolean' && patch.requiredForSignoff !== role.requiredForSignoff) {
      role.requiredForSignoff = patch.requiredForSignoff;
      contractChanged = true;
    }
    if (contractChanged) this.staleSignoffs('A role contract changed.');
    state.materialChangeAt = nowIso();
    await this.persistState();
    this.emitState();
    this.emitRole(role);
    return this.getState();
  }

  async listMessages(afterSeq = 0, target?: TeamRunTarget): Promise<TeamMessage[]> {
    const paths = target ? new TeamPaths(path.resolve(target.workspace), target.runId) : this.requirePaths();
    return this.messageBus.list(paths, afterSeq);
  }

  /**
   * Compute the authoritative done-gate for a run state: the FULL completion gate (every
   * required role signed off AND verification passed AND no pending steering AND task/finding
   * queues clear AND no open blockers AND the per-role board clear), with the exact list of
   * OPEN BLOCKERS. This is the single source of truth used by both the snapshot DTO and the
   * `done` WS event, so the UI can show precisely why a run is not done. Pure over `state`.
   */
  static computeDoneGate(state: TeamRunState): DoneGateState {
    const completion: CompletionResult = evaluateCompletion(buildCompletionInput(state));
    const blockers: DoneGateBlocker[] = completion.blockers.map((b) => ({ code: b.code, message: b.message }));
    // The pure gate does not see the team's per-role file task board; account for it here so a
    // queued/in-progress Lead-assigned task is surfaced as an explicit open blocker too.
    const boardPending = teamBoardPending(state);
    if (boardPending > 0) {
      blockers.push({
        code: 'board_pending',
        message: `${boardPending} Lead-assigned task(s) are still queued or in progress on the team task board.`,
      });
    }
    return {
      satisfied: blockers.length === 0,
      requiredRoleIds: completion.requiredRoleIds,
      signedOffRoleIds: completion.freshSignoffRoleIds,
      pendingRoleIds: completion.pendingRoleIds,
      openBlockers: blockers,
      evaluatedAt: nowIso(),
    };
  }

  private startLoop(status: 'running'): Promise<TeamRunState> {
    // Serialize concurrent start()/resume(): without this, two callers could both pass the
    // `if (!this.loop)` check below before either assigns `this.loop`, launching two runLoop()
    // instances against the same mutable state (duplicate turns, double task claims, racing
    // round/turnCount). One in-flight start wins; the rest await its result.
    if (this.starting) return this.starting;
    this.starting = this.startLoopInner(status).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startLoopInner(status: 'running'): Promise<TeamRunState> {
    const state = this.requireState();
    await this.reconcileCurrentRun();
    await this.acquireRunLease();
    const nextState = this.requireState();
    nextState.status = status;
    nextState.startedAt ??= nowIso();
    nextState.endedAt = undefined;
    nextState.pauseRequested = false;
    nextState.message = undefined;
    nextState.roles = nextState.roles.map((role) =>
      role.status === 'interrupted' || role.status === 'paused' ? { ...role, status: 'idle' } : role,
    );
    this.abort = new AbortController();
    await this.persistState();
    this.emitState();

    if (!this.loop) {
      const signal = this.abort.signal;
      this.loop = this.runLoop(signal)
        .catch((err) => this.failFromError(err))
        .finally(() => {
          this.loop = null;
          if (this.abort?.signal === signal) this.abort = null;
        });
    }
    return this.getState();
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const state = this.requireState();
      if (state.status !== 'running') return;

      await this.refreshActiveRunLease();
      if (await this.completeOrStopFromGate()) return;
      if (await this.pauseIfRequested()) return;

      // Lead-owned sequencing. The Lead owns the queue: it processes user prompts, reviews
      // each role result, assigns the next unit of work, and signs off. A worker role runs
      // ONLY from a Lead-assigned board task. Pending Lead work — a queued user prompt OR a
      // just-finished role result the Lead must review — takes STRICT priority over claiming
      // the next worker task: while any is pending we do not claim, so the scheduler gives
      // the Lead the turn first. This guarantees every user prompt reaches the Lead before
      // any further non-Lead work starts, and that no two role tasks run back-to-back without
      // a Lead turn between them. The Lead's own work is always scheduler-driven, never
      // claimed from its board (Lead-addressed messages are review requests, not work).
      const leadId = this.leadRoleId();
      const hasPendingLeadWork =
        state.leadReviewPending === true || state.directives.some((directive) => directive.status === 'pending');
      let turns: TeamScheduledTurn[];
      const claimed = hasPendingLeadWork ? null : await this.claimNextAgentTask(leadId ?? undefined);
      if (claimed) {
        turns = [
          {
            roleId: claimed.roleId,
            taskId: claimed.task.id,
            task: claimed.task,
            reason: `Working assigned ${claimed.task.id}: ${claimed.task.title}`,
          },
        ];
      } else {
        const messages = await this.listMessages();
        const decision = await this.scheduler.selectNextTurns(state, {
          messages,
          pendingDirectives: state.directives.filter((directive) => directive.status === 'pending'),
          latestVerification: latestVerification(state),
          maxTurns: this.maxTurns,
          maxRounds: this.maxRounds,
        });
        if (decision.terminal) {
          await this.finishRun(decision.terminal.status, decision.terminal.reason);
          return;
        }
        if (decision.turns.length === 0) {
          // No Lead-approved worker task and nothing for the Lead to act on → wait/idle.
          // The run stays resumable (sessions alive); a new user prompt or resume restarts it.
          await this.finishRun('blocked', decision.reason ?? 'No Lead-assigned work or user prompt is pending; the team is waiting.');
          return;
        }
        turns = decision.turns;
      }

      // User prompts are the Lead's to process: drain pending steering ONLY into a turn
      // batch that includes the Lead, so a worker turn never absorbs a user directive
      // meant for the Lead. Worker turns run with no applied steering.
      if (leadId && turns.some((turn) => turn.roleId === leadId)) {
        this.drainSteeringAtBoundary();
      } else {
        this.lastBoundarySteering = [];
      }

      state.round += 1;
      await this.persistState();
      this.emitState();
      turns = this.limitWritableConcurrency(turns);
      await Promise.all(turns.map((turn) => this.runOneTurn(turn, signal)));
      // A turn (or a concurrent stop()) may have already driven the run to a terminal
      // state. Bail before mutating/re-persisting it or re-evaluating the completion gate,
      // so a terminal status is never overwritten with a misleading `completed`.
      // Steering directives are marked applied inside applyTurnResult, but ONLY when the
      // Lead turn that received them completed — so a failed Lead turn re-delivers the
      // prompt next round instead of dropping it.
      if (this.requireState().status !== 'running') return;
      if (await this.completeOrStopFromGate()) return;
    }
    if (this.state?.status === 'running') await this.finishRun('stopped', 'Stopped by user.');
  }

  private async runOneTurn(scheduled: TeamScheduledTurn, signal: AbortSignal): Promise<void> {
    const state = this.requireState();
    const role = state.roles.find((entry) => entry.id === scheduled.roleId);
    if (!role) {
      await this.appendSystemBlocker(`Scheduler selected unknown role ${scheduled.roleId}.`);
      await this.finishRun('failed', `Scheduler selected unknown role ${scheduled.roleId}.`);
      return;
    }

    const limitDecision = await this.checkLimits(role);
    if (!limitDecision.allowed) {
      const reason = `Limit gate blocked ${role.name}: ${limitDecision.reason}`;
      await this.appendSystemBlocker(reason);
      await this.finishRun('blocked', reason);
      return;
    }

    const turnId = nanoid();
    // One stable terminal per role (the persistent session reuses it across turns), so the
    // UI can open this role's live CLI and watch its scrollback grow turn over turn.
    const terminalId = teamRoleTerminalId(state.runId, role.id);
    const turn: TeamTurnRecord = {
      id: turnId,
      runId: state.runId,
      roleId: role.id,
      roleName: role.name,
      status: 'running',
      round: state.round,
      startedAt: nowIso(),
      messageSeqs: [],
      appliedDirectiveIds: this.lastBoundarySteering.map((directive) => directive.id),
      reason: scheduled.reason,
      terminalId,
    };
    state.currentTurn = turn;
    state.turns.push(turn);
    role.status = 'running';
    role.lastTurnAt = turn.startedAt;
    role.activeTerminalId = terminalId;
    if (scheduled.task) this.turnTasks.set(turn.id, scheduled.task);
    await this.persistState();
    this.emitState();
    this.emitRole(role);

    try {
      const messagesForTurn = await this.listMessages();
      // Tell the role exactly what still keeps the run open (the done-gate's open blockers),
      // so it makes decisions that drive toward completion instead of guessing.
      const gate = await this.completionGate.evaluate(state, {
        messages: messagesForTurn,
        latestVerification: latestVerification(state),
      });
      const result = await this.runner.runRoleTurn({
        workspace: state.workspace,
        paths: this.requirePaths(),
        runId: state.runId,
        role: { ...role },
        turn: clone(turn),
        state: this.getState(),
        messages: messagesForTurn,
        appliedSteering: clone(this.lastBoundarySteering),
        signal,
        taskId: scheduled.taskId,
        assignedTask: scheduled.task
          ? { id: scheduled.task.id, title: scheduled.task.title, content: scheduled.task.body }
          : undefined,
        findingId: scheduled.findingId,
        completionHints: gate.complete ? [] : gate.reasons,
      });
      if (signal.aborted || this.state?.status !== 'running') {
        this.interruptTurn(turn, 'Interrupted before the turn result could be applied.');
        return;
      }
      await this.applyTurnResult(turn, role, result);
    } catch (err) {
      if (signal.aborted) {
        this.interruptTurn(turn, 'Stopped by user.');
      } else {
        const message = messageFromUnknown(err);
        await this.appendSystemBlocker(`${role.name} turn failed: ${message}`, turn.id);
        turn.status = 'failed';
        turn.reason = message;
        await this.finishRun('failed', message);
      }
    } finally {
      if (role.status === 'running') role.status = 'idle';
      if (this.state?.currentTurn?.id === turn.id) this.state.currentTurn = null;
      // File this turn's claimed board task (done on success, requeued otherwise).
      await this.fileTurnTask(turn);
      await this.persistState();
      this.emitState();
      this.emitRole(role);
      // The turn may have changed real project files; surface a changeset event when it did.
      await this.emitChangesIfChanged();
    }
  }

  private async applyTurnResult(turn: TeamTurnRecord, role: TeamRoleInstance, result: TeamRoleTurnResult): Promise<void> {
    const state = this.requireState();
    // Lead-owned sequencing inputs, captured before this turn's effects are applied.
    const isLeadTurn = role.id === this.leadRoleId();
    // A Lead turn "had work" if it processed a user prompt (drained directives) or was
    // reviewing a just-finished role result — such a turn is productive even if quiet.
    const leadHadPendingWork = isLeadTurn && (turn.appliedDirectiveIds.length > 0 || state.leadReviewPending === true);
    const materialBefore = state.materialChangeAt;
    const messages = result.messages ?? [];
    const appended: TeamMessage[] = [];
    // Ids of the prose-inferred verification records created by THIS turn, so a structured
    // self-report (below) can supersede exactly them without disturbing earlier records.
    const inferredVerificationIds: string[] = [];
    for (const draft of messages) {
      const message = await this.appendMessage({ ...draft, turnId: draft.turnId ?? turn.id });
      appended.push(message);
      turn.messageSeqs.push(message.seq);
      if (isMaterialMessage(message.kind)) {
        state.materialChangeAt = message.createdAt;
        this.staleSignoffs(`${message.kind} message changed the run state.`);
      }
      // NOTE: a `kind:'signoff'` chat message does NOT mark the role done — only an explicit
      // SignOffDirective with status 'done' (surfaced via result.signoffs) counts, so a role
      // saying "my sign-off is still pending" is not falsely recorded as complete.
      // A role reporting a build/test/check result as a `verification` message becomes a
      // first-class verification record so the done-gate's "objective checks passed"
      // requirement can actually be satisfied by the team (the CLI has no other channel
      // to record one). This is the FALLBACK path: the outcome is inferred from the prose
      // when the role did not emit a structured `VerificationDirective` (item 9). A
      // structured directive for the same turn takes precedence and supersedes this below.
      if (message.kind === 'verification') {
        const id = nanoid();
        inferredVerificationIds.push(id);
        state.verifications.push({
          id,
          roleId: role.id,
          status: inferVerificationOutcome(message.body),
          summary: message.body.slice(0, 280),
          createdAt: message.createdAt,
          completedAt: message.createdAt,
        });
      }
    }
    // Structured verification self-reports (explicit command/exitCode/outcome) are the
    // authoritative path — they replace the regex inference for this turn. When a turn emits
    // a structured directive we drop the prose-inferred record(s) it created above so the
    // explicit evidence is what the done-gate evaluates, not a guessed duplicate.
    const structuredVerifications = result.verifications ?? [];
    if (structuredVerifications.length > 0) {
      if (inferredVerificationIds.length > 0) {
        const drop = new Set(inferredVerificationIds);
        state.verifications = state.verifications.filter((v) => !drop.has(v.id));
      }
      for (const verification of structuredVerifications) {
        const completedAt = nowIso();
        state.verifications.push({
          id: nanoid(),
          roleId: verification.roleId ?? role.id,
          status: verification.outcome === 'passed' ? 'passed' : verification.outcome === 'failed' ? 'failed' : 'skipped',
          command: verification.command,
          exitCode: verification.exitCode,
          summary: verification.summary,
          createdAt: completedAt,
          completedAt,
        });
        state.materialChangeAt = completedAt;
      }
      this.staleSignoffs('A verification self-report changed the run state.');
    }
    if (result.verification) {
      const verification: TeamVerificationRecord = {
        id: result.verification.id ?? nanoid(),
        roleId: result.verification.roleId ?? role.id,
        status: result.verification.status,
        command: result.verification.command,
        exitCode: result.verification.exitCode,
        summary: result.verification.summary,
        createdAt: result.verification.createdAt ?? nowIso(),
        completedAt: result.verification.completedAt,
      };
      state.verifications.push(verification);
      state.materialChangeAt = verification.completedAt ?? verification.createdAt;
      this.staleSignoffs('Verification changed the run state.');
    }
    if (result.materialChange) {
      state.materialChangeAt = nowIso();
      this.staleSignoffs('Turn reported a material change.');
    }
    // Record sign-offs ONLY from explicit "done" directives (mapRunnerResult already
    // filters to status === 'done'), so a role is marked done solely when it genuinely
    // declares completion — never from a chat message alone.
    const signoffsRecorded = (result.signoffs ?? []).length;
    for (const signoff of result.signoffs ?? []) {
      const signoffRole = state.roles.find((entry) => entry.id === (signoff.roleId ?? role.id)) ?? role;
      this.recordSignoff(signoffRole, undefined, signoff.createdAt, signoff.messageId);
    }

    // Apply the structured task-board directives this turn emitted (claim/complete/block/
    // needs_work/request_review). The message-bus parses these; previously the orchestrator
    // dropped them. They mutate the board + run state so a role can drive a task's lifecycle
    // explicitly rather than only via the implicit claim-on-schedule / file-on-complete flow.
    const directiveEffects = await this.applyTaskDirectives(turn, role, result.taskDirectives ?? []);

    // Materialize this turn's Lead-approved `task` assignments into the target role's todo
    // queue. Only the Lead may delegate executable work; lateral non-Lead delegation and
    // Lead-addressed review requests are handled (and re-routed to the Lead) here.
    const tasksEnqueued = await this.enqueueTaskAssignments(appended);

    turn.status = result.status;
    turn.endedAt = nowIso();
    turn.reason = result.reason;
    state.turnCount += 1;
    await this.refreshWorkQueues();

    // Lead-owned sequencing bookkeeping. After any non-Lead turn the Lead must review the
    // result before more work runs. A Lead turn that advances the run (assigned a task,
    // recorded a sign-off, produced a material decision/verification, or had a prompt/review
    // to act on) resets the idle counter; an unproductive Lead turn increments it so a
    // stalled Lead eventually idles instead of looping to the round cap.
    if (isLeadTurn) {
      state.leadReviewPending = false;
      // A user prompt is consumed only when the Lead turn that received it COMPLETES. Mark
      // those directives applied now; on a failed/interrupted Lead turn we leave them pending
      // so they are re-delivered to the Lead next round instead of being silently dropped.
      if (result.status === 'completed' && turn.appliedDirectiveIds.length > 0) {
        const applied = new Set(turn.appliedDirectiveIds);
        const appliedAt = nowIso();
        for (const directive of state.directives) {
          if (!applied.has(directive.id) || directive.status === 'applied') continue;
          directive.status = 'applied';
          directive.acknowledgedAt ??= appliedAt;
          directive.appliedAt = appliedAt;
          this.emitSteering(directive);
        }
        state.pendingSteeringCount = this.countPendingSteering();
      }
      const productive =
        leadHadPendingWork ||
        state.materialChangeAt !== materialBefore ||
        signoffsRecorded > 0 ||
        tasksEnqueued > 0 ||
        directiveEffects > 0;
      state.consecutiveIdleLeadTurns = productive ? 0 : (state.consecutiveIdleLeadTurns ?? 0) + 1;
    } else {
      state.leadReviewPending = true;
      state.consecutiveIdleLeadTurns = 0;
    }

    // Recovery policy. A single role turn failing — or a role reporting itself blocked —
    // must NOT end the whole run: another role (or a retry next round) can recover, and
    // the code-enforced done-gate still prevents a false "complete". Only a user stop /
    // interruption is terminal here. A run of consecutive *failures* with no successful
    // turn between them trips a bounded guard so a broken setup can't loop to the round cap.
    const reason = result.reason ?? `${role.name} turn ended with status ${result.status}.`;
    if (result.status === 'completed') {
      this.consecutiveTurnFailures = 0;
    } else if (result.status === 'stopped' || result.status === 'interrupted') {
      await this.finishRun(turnStatusToRunStatus(result.status), reason);
    } else {
      // failed | blocked — keep the run alive and let the scheduler re-route next round.
      role.status = result.status === 'blocked' ? 'blocked' : 'idle';
      this.consecutiveTurnFailures = result.status === 'failed' ? this.consecutiveTurnFailures + 1 : 0;
      await this.appendMessage({
        turnId: turn.id,
        from: SYSTEM_SENDER,
        kind: 'system',
        body:
          result.status === 'failed'
            ? `${role.name}'s turn failed: ${reason}. The team will continue and re-route or retry this work (failure ${this.consecutiveTurnFailures}/${this.maxConsecutiveFailures}).`
            : `${role.name} reported it is blocked: ${reason}. The team will continue — steer it or let another role unblock the work.`,
      });
      if (this.consecutiveTurnFailures >= this.maxConsecutiveFailures) {
        await this.finishRun(
          'failed',
          `Stopped after ${this.consecutiveTurnFailures} consecutive failed turns without progress. Last failure: ${reason}`,
        );
      }
    }
  }

  private async completeOrStopFromGate(): Promise<boolean> {
    const state = this.requireState();
    if (state.status !== 'running') return false;
    const decision = await this.completionGate.evaluate(state, {
      messages: await this.listMessages(),
      latestVerification: latestVerification(state),
    });
    if (decision.complete) {
      await this.finishRun('completed', 'All completion gates passed.');
      return true;
    }
    if (decision.terminalStatus) {
      await this.finishRun(decision.terminalStatus, decision.reasons.join('; ') || `Run ended as ${decision.terminalStatus}.`);
      return true;
    }
    return false;
  }

  private async pauseIfRequested(): Promise<boolean> {
    const state = this.requireState();
    if (!state.pauseRequested) return false;
    state.pauseRequested = false;
    await this.pauseAtBoundary(state.message ?? 'Paused by user.');
    return true;
  }

  /**
   * Capture the currently-pending user prompts so this turn's Lead sees them in its prompt.
   * The directives are NOT marked acknowledged/applied here: a prompt is "handled" only once
   * the Lead turn that received it COMPLETES (see {@link applyTurnResult}). If that turn fails
   * or is interrupted, the directives stay pending and are re-delivered next round, so a user
   * prompt is never silently dropped on a failed Lead turn.
   */
  private drainSteeringAtBoundary(): void {
    const state = this.requireState();
    this.lastBoundarySteering = state.directives.filter((directive) => directive.status === 'pending');
  }

  private async checkLimits(role: TeamRoleInstance): Promise<LimitRuleDecision> {
    if (this.options.limitGate) return this.options.limitGate.check(role.tool);
    if (this.options.limitService) return (await this.options.limitService.refresh('manual')).decision;
    return {
      allowed: true,
      action: 'allow',
      reason: 'No limit gate configured.',
      resumeAfter: null,
      conservative: false,
      checkedAt: nowIso(),
    };
  }

  private limitWritableConcurrency(turns: TeamScheduledTurn[]): TeamScheduledTurn[] {
    const writeTurns = turns.filter((turn) => this.roleCanWrite(turn.roleId));
    if (writeTurns.length <= 1) return turns;
    const firstWrite = writeTurns[0]!;
    return turns.filter((turn) => !this.roleCanWrite(turn.roleId) || turn.roleId === firstWrite.roleId);
  }

  private roleCanWrite(roleId: string): boolean {
    return this.requireState().roles.find((role) => role.id === roleId)?.canWriteCode ?? false;
  }

  private interruptTurn(turn: TeamTurnRecord, reason: string): void {
    turn.status = 'interrupted';
    turn.endedAt = nowIso();
    turn.reason = reason;
    const state = this.requireState();
    const matching = state.turns.find((entry) => entry.id === turn.id);
    if (matching) Object.assign(matching, turn);
  }

  private recordSignoff(role: TeamRoleInstance, message?: TeamMessage, createdAt = nowIso(), messageId = message?.id): void {
    this.requireState().signoffs.push({
      id: nanoid(),
      roleId: role.id,
      roleName: role.name,
      messageId,
      createdAt: message?.createdAt ?? createdAt,
      stale: false,
    });
  }

  private staleSignoffs(reason: string): void {
    const state = this.requireState();
    for (const signoff of state.signoffs) {
      if (signoff.stale) continue;
      signoff.stale = true;
      signoff.staleReason = reason;
    }
  }

  private async appendSystemBlocker(body: string, turnId?: string): Promise<TeamMessage> {
    return this.appendMessage({
      turnId,
      from: SYSTEM_SENDER,
      kind: 'blocker',
      body,
    });
  }

  private async appendMessage(draft: TeamMessageDraft): Promise<TeamMessage> {
    const message = await this.messageBus.append(this.requirePaths(), draft);
    const state = this.requireState();
    state.messageCount = Math.max(state.messageCount, message.seq);
    this.emit('message', message);
    return message;
  }

  private async refreshWorkQueues(): Promise<void> {
    const state = this.requireState();
    const tiger = new TigerPaths(state.workspace);
    const tasks = await listTaskRecords(tiger.tasksDir);
    state.tasks = tasks.length > 0 ? summarizeTasks(tasks) : null;
    const findings = await listFindings(tiger.findingsDir);
    state.findings = findings.length > 0 ? summarizeFindings(findings) : null;
    // Per-role task-board counts (todo/in-progress/done) for the UI.
    if (this.taskBoard) {
      for (const role of state.roles) {
        role.taskCounts = await this.taskBoard.counts(role.id);
      }
    }
  }

  /** The role acting as Lead/coordinator for this run, or null when no role is configured. */
  private leadRoleId(): string | null {
    return resolveLeadRoleId(this.requireState().roles);
  }

  /**
   * Claim the next queued worker task (role order; FIFO within a role). `excludeRoleId`
   * skips the Lead's own queue: the Lead is scheduler-driven, never claimed as worker work.
   */
  private async claimNextAgentTask(excludeRoleId?: string): Promise<{ roleId: string; task: AgentTask } | null> {
    if (!this.taskBoard) return null;
    const state = this.requireState();
    // Claim the globally OLDEST queued task across all worker roles (true FIFO across the
    // board), not just the first role that happens to have work. Scanning roles in fixed
    // order and taking the first non-empty queue would let a role whose queue is continually
    // replenished starve the others; comparing each role's head task by `createdAt` (with the
    // FIFO task id as a tiebreaker) is fair regardless of role order.
    let best: { roleId: string; head: AgentTask } | null = null;
    for (const role of state.roles) {
      if (excludeRoleId && role.id === excludeRoleId) continue;
      // A single-role pause (item 8) takes the role out of scheduling without halting the run:
      // skip its queued work until it is resumed.
      if (role.status === 'paused') continue;
      const head = (await this.taskBoard.listTodo(role.id))[0];
      if (!head) continue;
      if (
        !best ||
        head.createdAt < best.head.createdAt ||
        (head.createdAt === best.head.createdAt && head.id < best.head.id)
      ) {
        best = { roleId: role.id, head };
      }
    }
    if (!best) return null;
    const task = await this.taskBoard.claimNext(best.roleId, nowIso());
    return task ? { roleId: best.roleId, task } : null;
  }

  /** Derive a concise task title from an assignment message body. */
  private taskTitle(body: string): string {
    const firstLine = body.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? 'Task';
    return firstLine.slice(0, 120);
  }

  /**
   * Materialize Lead-approved `task` messages into the target role's todo queue, enforcing
   * Lead-owned delegation. Returns the number of tasks actually enqueued.
   *
   * Routing rules:
   *  - Lead → worker role: enqueued as executable board work.
   *  - any role → Lead: a review/approval request, NOT executable board work — it just
   *    flags a Lead review (its content is already in the transcript the Lead reads).
   *  - non-Lead → another worker role: lateral delegation that is not Lead-approved; it is
   *    dropped (never executed silently) and re-routed to the Lead with a system notice.
   */
  private async enqueueTaskAssignments(messages: TeamMessage[]): Promise<number> {
    if (!this.taskBoard) return 0;
    const state = this.requireState();
    const roleIds = new Set(state.roles.map((role) => role.id));
    const leadId = this.leadRoleId();
    let enqueued = 0;
    for (const message of messages) {
      const to = message.to;
      if (message.kind !== 'task' || !to || !roleIds.has(to)) continue;

      // A task addressed to the Lead is a review request: don't queue it as worker work,
      // just ensure the Lead takes a turn to inspect it.
      if (to === leadId) {
        state.leadReviewPending = true;
        continue;
      }

      // Only the Lead may assign executable work to a role. A non-Lead role delegating
      // laterally must not silently run as if Lead-approved — drop it, route it to the Lead.
      if (leadId && message.from !== leadId) {
        await this.appendMessage({
          turnId: message.turnId,
          from: SYSTEM_SENDER,
          kind: 'system',
          body: `${message.from} attempted to assign a task to ${to}, but only the Lead assigns work. The request was not queued; it is flagged for Lead review.`,
        });
        state.leadReviewPending = true;
        continue;
      }

      const title = this.taskTitle(message.body);
      const titles = await this.taskBoard.titles(to);
      if (titles.has(title)) continue; // a re-assignment of the same task — skip
      await this.taskBoard.enqueue({
        roleId: to,
        fromRoleId: message.from,
        title,
        body: message.body,
        createdAt: message.createdAt,
      });
      enqueued += 1;
    }
    return enqueued;
  }

  /**
   * Apply the structured task-board directives a turn emitted. The message bus parses
   * `claim/complete/block/needs_work/request_review` blocks but the engine used to drop them;
   * this is that documented-but-lost capability restored. Directives act on the EMITTING role's
   * board task (the `taskId` names a board task in the role's queue), with the implicit
   * claim-on-schedule / file-on-complete flow as the default. Returns how many directives took
   * effect (so a Lead turn that drove the board counts as productive). Best-effort: an unknown
   * task id or a board IO hiccup is reported as a system note, never crashes the loop.
   */
  private async applyTaskDirectives(
    turn: TeamTurnRecord,
    role: TeamRoleInstance,
    directives: TeamTaskDirective[],
  ): Promise<number> {
    if (directives.length === 0 || !this.taskBoard) return 0;
    const board = this.taskBoard;
    const state = this.requireState();
    let applied = 0;
    for (const directive of directives) {
      const located = await board.findTask(role.id, directive.taskId).catch(() => null);
      const note = directive.summary ? ` (${directive.summary})` : '';
      try {
        switch (directive.action) {
          case 'complete': {
            // Mark the named task done. Prefer the claimed turn task (it is the in-flight one);
            // otherwise complete the located board task. Completing a task is forward progress
            // (work being CLEARED, not new work) so it must NOT stale sign-offs — only new work
            // or a scope change does. Otherwise a role completing its task and signing off in the
            // same turn would invalidate its own fresh sign-off.
            const claimed = this.turnTasks.get(turn.id);
            const target = claimed && claimed.id === directive.taskId ? claimed : located?.task;
            if (target) {
              await board.complete(target, nowIso());
              if (claimed && claimed.id === directive.taskId) this.turnTasks.delete(turn.id);
              applied += 1;
            }
            break;
          }
          case 'block':
          case 'needs_work': {
            // Return the task to its role's queue so it is re-worked, and flag a Lead review.
            // `needs_work` (e.g. a reviewer rejecting an implementation) and `block` both reopen
            // the work; the difference is surfaced in the conversation note.
            const target = located?.task ?? this.turnTasks.get(turn.id);
            if (target) {
              if (target.status === 'in-progress') await board.requeue(target);
              if (this.turnTasks.get(turn.id)?.id === target.id) this.turnTasks.delete(turn.id);
            }
            await this.appendMessage({
              turnId: turn.id,
              from: SYSTEM_SENDER,
              kind: 'blocker',
              body:
                directive.action === 'block'
                  ? `${role.name} reported ${directive.taskId} blocked${note}; it was returned to the queue for the Lead to unblock.`
                  : `${role.name} sent ${directive.taskId} back for rework${note}; it was returned to the queue.`,
            });
            state.leadReviewPending = true;
            state.materialChangeAt = nowIso();
            this.staleSignoffs(`${directive.taskId} needs more work.`);
            applied += 1;
            break;
          }
          case 'request_review': {
            // Route a finished unit of work to the Lead for review (the Lead decides who reviews).
            await this.appendMessage({
              turnId: turn.id,
              from: role.id,
              to: this.leadRoleId() ?? undefined,
              kind: 'handoff',
              body: `Requesting review of ${directive.taskId}${note}.`,
            });
            state.leadReviewPending = true;
            applied += 1;
            break;
          }
          case 'claim': {
            // An explicit claim of a queued task: move it to in-progress and attach it to this
            // turn so it is filed on completion. The scheduler usually claims for the role, so
            // this matters when a role self-selects from its own queue.
            if (located && located.task.status === 'todo' && !this.turnTasks.has(turn.id)) {
              const claimed = await board.claimNext(role.id, nowIso());
              if (claimed) {
                this.turnTasks.set(turn.id, claimed);
                applied += 1;
              }
            }
            break;
          }
        }
      } catch {
        // a board IO hiccup must not crash the run loop
      }
    }
    if (applied > 0) await this.refreshWorkQueues();
    return applied;
  }

  /** File a turn's claimed board task: done on success, back to the queue otherwise. */
  private async fileTurnTask(turn: TeamTurnRecord): Promise<void> {
    const task = this.turnTasks.get(turn.id);
    if (!task || !this.taskBoard) return;
    this.turnTasks.delete(turn.id);
    try {
      if (turn.status === 'completed') await this.taskBoard.complete(task, nowIso());
      else await this.taskBoard.requeue(task);
    } catch {
      // a task-board IO hiccup must not crash the run loop
    }
  }

  private async reconcileCurrentRun(): Promise<void> {
    const state = this.requireState();
    await this.teamPersistence.init?.();
    await this.executionPersistence.init();
    await this.teamPersistence.reconcileTeamOnBoot?.(state.workspace, state.runId);
    const loaded = await this.teamPersistence.loadRun(state.workspace, state.runId);
    if (loaded) {
      this.state = loaded;
      this.paths = new TeamPaths(loaded.workspace, loaded.runId);
      this.taskBoard = new TaskBoard(this.paths.runDir);
    }
    const tiger = new TigerPaths(state.workspace);
    const reclaimedTasks = await reclaimStaleTaskClaims(tiger.tasksDir, {
      locksDir: tiger.locksDir,
      ttlMs: this.lockTtlMs,
    });
    const reclaimedFindings = await reclaimStaleFindings(tiger.findingsDir, {
      locksDir: tiger.findingLocksDir,
      ttlMs: this.lockTtlMs,
    });
    await this.executionPersistence.reconcileOnBoot({
      workspace: state.workspace,
      owner: this.owner,
      ttlMs: this.lockTtlMs,
    });
    // A run interrupted mid-turn may have left a board task in `in-progress`. Return those to
    // `todo` so they are re-claimed and re-run; otherwise they could never reach `done` and
    // would block completion forever (the done-gate's board check would never clear).
    if (this.taskBoard) {
      await this.taskBoard.requeueInProgress(this.requireState().roles.map((role) => role.id)).catch(() => 0);
    }
    await this.refreshWorkQueues();
    if (reclaimedTasks.length > 0 || reclaimedFindings.length > 0) {
      this.requireState().message =
        `Reconciled ${reclaimedTasks.length} stale task claim(s) and ${reclaimedFindings.length} stale finding claim(s).`;
    }
    this.requireState().pendingSteeringCount = this.countPendingSteering();
    await this.syncMessageCount();
    await this.persistState();
    this.emitState();
  }

  private async acquireRunLease(): Promise<void> {
    const state = this.requireState();
    if (this.activeExecutionRunId) {
      await this.refreshActiveRunLease();
      this.startRunLeaseHeartbeat();
      return;
    }
    const acquired = await this.executionPersistence.acquireRunLease({
      workspace: state.workspace,
      tigerRoot: state.tigerRoot,
      owner: this.owner,
      ttlMs: this.lockTtlMs,
    });
    if (!acquired.ok) {
      throw httpError(
        409,
        `Tiger execution is leased by ${acquired.conflict.leaseOwner}` +
          `${acquired.conflict.leaseExpiresAt ? ` until ${acquired.conflict.leaseExpiresAt}` : ''}`,
      );
    }
    this.activeExecutionRunId = acquired.runId;
    state.lease = {
      executionRunId: acquired.runId,
      owner: acquired.leaseOwner,
      expiresAt: acquired.leaseExpiresAt,
    };
    this.startRunLeaseHeartbeat();
  }

  private heartbeatIntervalMs(): number {
    return Math.max(100, Math.min(60_000, Math.floor(Math.max(1000, this.lockTtlMs) / 3)));
  }

  private startRunLeaseHeartbeat(): void {
    if (this.runLeaseHeartbeat) return;
    this.runLeaseHeartbeat = setInterval(() => {
      void this.refreshActiveRunLease().catch(() => undefined);
    }, this.heartbeatIntervalMs());
    this.runLeaseHeartbeat.unref();
  }

  private async stopRunLeaseHeartbeat(): Promise<void> {
    if (this.runLeaseHeartbeat) {
      clearInterval(this.runLeaseHeartbeat);
      this.runLeaseHeartbeat = null;
    }
    await this.runLeaseRefresh?.catch(() => undefined);
  }

  private async refreshActiveRunLease(): Promise<void> {
    if (this.runLeaseRefresh) {
      await this.runLeaseRefresh;
      return;
    }
    const runId = this.activeExecutionRunId;
    if (!runId) return;
    const refresh = (async () => {
      await this.executionPersistence.refreshRunLease(runId, this.owner, this.lockTtlMs);
      const state = this.state;
      if (state?.lease?.executionRunId === runId) {
        state.lease.owner = ownerKey(this.owner);
        state.lease.expiresAt = leaseExpiresAt(this.lockTtlMs);
      }
    })();
    this.runLeaseRefresh = refresh;
    try {
      await refresh;
    } finally {
      if (this.runLeaseRefresh === refresh) this.runLeaseRefresh = null;
    }
  }

  private async pauseAtBoundary(reason: string): Promise<void> {
    const state = this.requireState();
    state.status = 'paused';
    state.message = reason;
    state.roles = state.roles.map((role) => (role.status === 'running' ? { ...role, status: 'idle' } : role));
    await this.releaseRunLease('stopped', reason);
    await this.persistState();
    this.emitState();
  }

  private async finishRun(status: TeamRunStatus, reason?: string): Promise<void> {
    const state = this.requireState();
    state.status = status;
    state.message = reason;
    state.endedAt = nowIso();
    state.pauseRequested = false;
    state.currentTurn = null;
    state.roles = state.roles.map((role) => (role.status === 'running' ? { ...role, status: 'idle' } : role));
    await this.releaseRunLease(teamStatusToExecutionStatus(status), reason);
    // Persistent CLI sessions: a completed/failed run is genuinely over → tear its
    // terminals down. A stopped/blocked/interrupted run may resume, so its sessions are
    // left ALIVE (Close, or backend shutdown, kills them) — "Stop pauses, Close ends".
    if (status === 'completed' || status === 'failed') {
      await this.runner.disposeRun?.(state.runId, { kill: true }).catch(() => undefined);
    }
    await this.persistState();
    this.emitState();
    // Per-run observability (item 7) + best-effort completion/blocked/failed notification
    // (item 10). Emitted once, on the terminal transition, for the meaningful outcomes.
    if (status === 'completed' || status === 'blocked' || status === 'failed') {
      const metrics = computeRunMetrics(state);
      const provider = mostCommonProvider(state);
      logger.child({ mod: 'team', runId: state.runId }).info('team run finished', {
        status,
        completionMethod: status === 'completed' ? 'done-gate' : reason ?? status,
        durationMs: metrics.durationMs,
        turns: metrics.turnCount,
        provider,
        tokens: metrics.tokens ?? null,
        cost: metrics.cost ?? null,
      });
      notifyRunOutcome({
        runId: state.runId,
        name: deriveRunNameFromGoal(state.goal),
        outcome: status,
        message: reason,
        workspace: state.workspace,
      });
    }
  }

  private async releaseRunLease(status: ExecutionRunStatus, reason?: string): Promise<void> {
    await this.stopRunLeaseHeartbeat();
    const runId = this.activeExecutionRunId;
    this.activeExecutionRunId = null;
    if (this.state) this.state.lease = undefined;
    if (runId) await this.executionPersistence.finishRun(runId, status, reason);
  }

  private async failFromError(err: unknown): Promise<void> {
    if (!this.state) return;
    const message = messageFromUnknown(err);
    await this.appendSystemBlocker(`Team run failed: ${message}`).catch(() => undefined);
    await this.finishRun('failed', message).catch(() => undefined);
  }

  private async ensureLoaded(target?: string | TeamRunTarget): Promise<void> {
    if (target && typeof target === 'object') {
      await this.loadRun(target.workspace, target.runId);
      return;
    }
    if (typeof target === 'string') {
      const state = this.requireState();
      if (state.runId !== target) await this.loadRun(state.workspace, target);
      return;
    }
    if (!this.state) throw httpError(400, 'create or load a team run first');
  }

  private async loadRun(workspace: string, runId: string): Promise<void> {
    await this.teamPersistence.init?.();
    await this.executionPersistence.init();
    const resolvedWorkspace = path.resolve(workspace);
    const loaded = await this.teamPersistence.loadRun(resolvedWorkspace, runId);
    if (!loaded) throw httpError(404, `team run ${runId} was not found`);
    this.state = loaded;
    this.paths = new TeamPaths(resolvedWorkspace, runId);
    this.taskBoard = new TaskBoard(this.paths.runDir);
    await this.syncMessageCount();
    await this.refreshWorkQueues();
    this.state.pendingSteeringCount = this.countPendingSteering();
    this.emitState();
  }

  private async syncMessageCount(): Promise<void> {
    const messages = await this.listMessages();
    this.requireState().messageCount = messages.length ? messages[messages.length - 1]!.seq : 0;
  }

  private countPendingSteering(): number {
    return this.requireState().directives.filter((directive) => directive.status === 'pending').length;
  }

  private persistState(): Promise<void> {
    const snapshot = clone(this.requireState());
    const run = this.persistGate.then(() => this.teamPersistence.saveRun(snapshot), () =>
      this.teamPersistence.saveRun(snapshot),
    );
    this.persistGate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private emitState(): void {
    if (!this.state) return;
    this.emit('state', this.getState());
    // Fire the done-gate event only when the gate actually changed, so the UI's "why isn't
    // this done yet" panel updates without a flood of identical events.
    const gate = TeamOrchestrator.computeDoneGate(this.state);
    const gateJson = JSON.stringify({ ...gate, evaluatedAt: undefined });
    if (gateJson !== this.lastDoneGateJson) {
      this.lastDoneGateJson = gateJson;
      this.emit('done', { runId: this.state.runId, gate });
    }
  }

  /** Emit a per-role status-change event (the frontend renders per-role status live). */
  private emitRole(role: TeamRoleInstance): void {
    if (!this.state) return;
    this.emit('role', { runId: this.state.runId, role: toRoleSnapshot(this.state, role) });
  }

  /**
   * Emit a steering-directive lifecycle event (acked/applied/queued). The frontend uses this
   * to reflect a directive moving from pending → acknowledged → applied without a full state push.
   */
  private emitSteering(directive: TeamDirective): void {
    if (!this.state) return;
    this.emit('steering', {
      runId: this.state.runId,
      directive: {
        id: directive.id,
        runId: this.state.runId,
        body: directive.body,
        createdAt: directive.createdAt,
        acknowledged: directive.status !== 'pending',
      },
    });
  }

  /**
   * Best-effort: recompute the git changeset for the run's workspace and emit a `changes`
   * event when it changed. The diff itself is fetched lazily over REST (`/changes`); this
   * event carries only the lightweight summary so the UI knows when to refetch.
   */
  private async emitChangesIfChanged(): Promise<void> {
    const state = this.state;
    if (!state) return;
    // Computing the changeset shells out to git in the workspace; skip that cost entirely
    // unless something is actually listening for `changes` (the WS layer subscribes in
    // production; unit tests with fake runners do not, so they never spawn git).
    if (this.listenerCount('changes') === 0) return;
    let changes: TeamChanges;
    try {
      changes = await computeTeamChanges(state.workspace, nowIso());
    } catch {
      return; // never let a git hiccup disturb the run loop
    }
    const summary = {
      isGitRepo: changes.isGitRepo,
      head: changes.head,
      branch: changes.branch,
      summary: changes.summary,
    };
    const json = JSON.stringify(summary);
    if (json === this.lastChangesJson) return;
    this.lastChangesJson = json;
    this.emit('changes', { runId: state.runId, changes: { ...summary, generatedAt: changes.generatedAt } });
  }

  private requireState(): TeamRunState {
    if (!this.state) throw httpError(400, 'create or load a team run first');
    return this.state;
  }

  private requirePaths(): TeamPaths {
    if (!this.paths) throw httpError(400, 'create or load a team run first');
    return this.paths;
  }
}

function normalizeRoles(roles: Omit<Partial<TeamRoleInstance>, 'status'>[]): TeamRoleInstance[] {
  const source = roles.length
    ? roles
    : [
        {
          id: 'lead',
          name: 'Lead',
          tool: 'codex' as const,
          responsibilities: ['Coordinate the team run and decide the next best action.'],
          canWriteCode: false,
          requiredForSignoff: true,
        },
      ];
  return source.map((role, index) => {
    const name = cleanText(role.name) || `Role ${index + 1}`;
    return {
      id: cleanId(role.id) || cleanId(name) || `role-${index + 1}`,
      name,
      templateId: role.templateId,
      tool: toAgentTypeOr(role.tool, 'claude'),
      model: role.model,
      effort: role.effort,
      permission: role.permission,
      persona: role.persona,
      responsibilities: Array.isArray(role.responsibilities) ? role.responsibilities.filter(Boolean) : [],
      canWriteCode: role.canWriteCode === true,
      requiredForSignoff: role.requiredForSignoff === true,
      status: 'idle',
    };
  });
}

function normalizeLoadedState(value: TeamRunState | null): TeamRunState | null {
  if (!value || typeof value !== 'object') return null;
  return {
    ...value,
    roles: Array.isArray(value.roles) ? value.roles : [],
    turns: Array.isArray(value.turns) ? value.turns : [],
    directives: Array.isArray(value.directives) ? value.directives : [],
    signoffs: Array.isArray(value.signoffs) ? value.signoffs : [],
    verifications: Array.isArray(value.verifications) ? value.verifications : [],
    tasks: value.tasks ?? null,
    findings: value.findings ?? null,
    currentTurn: value.currentTurn ?? null,
    closed: value.closed === true,
    leadReviewPending: value.leadReviewPending === true,
    consecutiveIdleLeadTurns:
      typeof value.consecutiveIdleLeadTurns === 'number' ? value.consecutiveIdleLeadTurns : 0,
    pendingSteeringCount: Array.isArray(value.directives)
      ? value.directives.filter((directive) => directive.status === 'pending').length
      : 0,
  };
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanId(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function latestVerification(state: TeamRunState): TeamVerificationRecord | null {
  return state.verifications.length ? state.verifications[state.verifications.length - 1]! : null;
}

/** Wall-clock duration of one turn in ms, when both endpoints are known. */
function turnDurationMs(turn: TeamTurnRecord): number {
  if (!turn.endedAt) return 0;
  const start = Date.parse(turn.startedAt);
  const end = Date.parse(turn.endedAt);
  return Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, end - start);
}

/**
 * Roll up per-role and per-run duration/provider/turn-count metrics from the run's turn
 * history (item 7). Token/cost stay null: the interactive-PTY CLIs do not self-report usage —
 * `tokens`/`cost` are the documented extension point a usage-reporting runner would fill.
 */
export function computeRunMetrics(state: TeamRunState): import('./types.js').TeamMetrics {
  const byRole = new Map<string, { roleName: string; provider?: AgentType; turnCount: number; durationMs: number }>();
  let totalDuration = 0;
  for (const turn of state.turns) {
    const dur = turnDurationMs(turn);
    totalDuration += dur;
    const role = state.roles.find((r) => r.id === turn.roleId);
    const entry = byRole.get(turn.roleId) ?? { roleName: turn.roleName, provider: role?.tool, turnCount: 0, durationMs: 0 };
    entry.turnCount += 1;
    entry.durationMs += dur;
    byRole.set(turn.roleId, entry);
  }
  // Prefer the actual run wall-clock when known; fall back to summed turn durations.
  const runStart = state.startedAt ? Date.parse(state.startedAt) : NaN;
  const runEnd = state.endedAt ? Date.parse(state.endedAt) : Date.now();
  const wallClock = Number.isNaN(runStart) ? totalDuration : Math.max(0, runEnd - runStart);
  return {
    durationMs: wallClock,
    turnCount: state.turnCount,
    perRole: [...byRole.entries()].map(([roleId, e]) => ({
      roleId,
      roleName: e.roleName,
      provider: e.provider,
      turnCount: e.turnCount,
      durationMs: e.durationMs,
    })),
    tokens: null,
    cost: null,
  };
}

/** The provider/CLI tool that ran the most turns this run (for log attribution). */
function mostCommonProvider(state: TeamRunState): AgentType | undefined {
  const counts = new Map<AgentType, number>();
  for (const turn of state.turns) {
    const tool = state.roles.find((r) => r.id === turn.roleId)?.tool;
    if (tool) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  let best: AgentType | undefined;
  let bestN = 0;
  for (const [tool, n] of counts) if (n > bestN) ((best = tool), (bestN = n));
  return best;
}

/** Render a run export as a human-readable markdown document. */
function renderRunMarkdown(run: TeamRunExportJson): string {
  const lines: string[] = [];
  lines.push(`# AI Team Run — ${run.name}`, '');
  lines.push(`- **Run id:** ${run.runId}`);
  lines.push(`- **Status:** ${run.status}`);
  lines.push(`- **Workspace:** ${run.workspace}`);
  lines.push(`- **Created:** ${run.createdAt}`);
  if (run.startedAt) lines.push(`- **Started:** ${run.startedAt}`);
  if (run.endedAt) lines.push(`- **Ended:** ${run.endedAt}`);
  lines.push(`- **Duration:** ${Math.round(run.metrics.durationMs / 1000)}s over ${run.metrics.turnCount} turn(s)`);
  lines.push('', '## Goal', '', run.goal, '');
  lines.push('## Roles', '');
  for (const role of run.roles) {
    lines.push(
      `- **${role.name}** (${role.id}) — ${role.tool}${role.canWriteCode ? ', can write code' : ''}${
        role.requiredForSignoff ? ', required for sign-off' : ''
      }`,
    );
  }
  lines.push('', '## Done gate', '');
  lines.push(`- **Satisfied:** ${run.doneGate.satisfied ? 'yes' : 'no'}`);
  if (run.doneGate.openBlockers.length) {
    lines.push('- **Open blockers:**');
    for (const blocker of run.doneGate.openBlockers) lines.push(`  - (${blocker.code}) ${blocker.message}`);
  }
  lines.push('', '## Verifications', '');
  if (run.verifications.length === 0) lines.push('_None recorded._');
  for (const v of run.verifications) {
    lines.push(`- [${v.status}] ${v.command ? `\`${v.command}\` ` : ''}${v.summary ?? ''} (${v.createdAt})`);
  }
  lines.push('', '## Sign-offs', '');
  if (run.signoffs.length === 0) lines.push('_None recorded._');
  for (const s of run.signoffs) {
    lines.push(`- ${s.roleName} (${s.roleId}) — ${s.stale ? `stale: ${s.staleReason ?? ''}` : 'fresh'} (${s.createdAt})`);
  }
  lines.push('', '## Transcript', '');
  for (const m of run.messages) {
    const to = m.to ? ` → ${m.to}` : '';
    lines.push(`### #${m.seq} ${m.from}${to} · ${m.kind} · ${m.createdAt}`, '', m.body, '');
  }
  return lines.join('\n');
}

/** A short display name derived from a run goal (mirrors snapshot.deriveRunName). */
function deriveRunNameFromGoal(goal: string): string {
  const firstLine = goal.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  if (!firstLine) return 'Team Run';
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

function isTerminalStatus(status: TeamRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

function turnStatusToRunStatus(status: TeamTurnStatus): TeamRunStatus {
  if (status === 'blocked') return 'blocked';
  if (status === 'stopped') return 'stopped';
  if (status === 'interrupted') return 'interrupted';
  return 'failed';
}

function teamStatusToExecutionStatus(status: TeamRunStatus): ExecutionRunStatus {
  if (status === 'completed') return 'completed';
  // 'blocked' is a resumable waiting halt (idle with no Lead work, a provider limit, or a
  // blocked done-gate) — the run keeps its sessions alive and can resume — so it maps to
  // 'stopped', not 'failed'. Recording it as failed would mislead execution status history.
  if (status === 'stopped' || status === 'paused' || status === 'blocked') return 'stopped';
  if (status === 'interrupted') return 'interrupted';
  return 'failed';
}

function isMaterialMessage(kind: TeamMessageKind): boolean {
  return kind === 'decision' || kind === 'task' || kind === 'finding' || kind === 'verification' || kind === 'steering';
}

function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function atomicWrite(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${nanoid(6)}.tmp`;
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, file);
}

function messageFromUnknown(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/**
 * Infer a verification outcome from a role's verification message text. Failure words are
 * only decisive when NOT negated: a passing report like "build passed, 0 errors, no failures"
 * must not be misread as a failure just because it contains the substrings "error"/"fail".
 * We first neutralize "no/0/zero/without <failure-word>" phrasing, then look for a real
 * failure signal in what remains.
 */
function inferVerificationOutcome(body: string): TeamVerificationStatus {
  const neutralized = body
    .toLowerCase()
    // "0 errors", "no failures", "zero warnings", "without errors", "free of regressions"
    .replace(/\b(?:0|no|zero|without|free\s+of|free\s+from)\s+(?:open\s+)?(?:errors?|failures?|failing|warnings?|regressions?|issues?)\b/g, ' ')
    // "all tests pass", "did pass", "tests passed" — keep positive phrasing from tripping fail words
    .replace(/\b(?:all\s+)?(?:tests?|checks?|builds?)\s+pass(?:ed|ing)?\b/g, ' ');
  return /\b(fail|failed|failing|failure|error|errored|broke|broken|did ?n['o]t pass|does ?n['o]t pass|not pass|unmet|regress)/.test(
    neutralized,
  )
    ? 'failed'
    : 'passed';
}

interface HttpError extends Error {
  status: number;
}

function httpError(status: number, message: string): HttpError {
  const err = new Error(message) as HttpError;
  err.status = status;
  return err;
}
