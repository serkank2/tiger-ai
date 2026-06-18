import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { AgentType, FindingsSummary, TaskSummary, TigerConfig } from '../orchestrator/types.js';
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
import { evaluateRunGate, type CompletionInput, type GuardCounters } from './completion.js';
import {
  selectNextTurns,
  type TeamSchedulerState as PureSchedulerState,
  type TeamRole as PureSchedulerRole,
  type TeamRoleKind as PureRoleKind,
  type TeamTaskState as PureTaskState,
  type TeamFindingState as PureFindingState,
} from './scheduler.js';
import { runRoleTurn, type RunRoleTurnResult } from './runner.js';

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
  lastTurnAt?: string;
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
  command?: string;
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
  materialChangeAt: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  message?: string;
  pauseRequested?: boolean;
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

export interface TeamRunTarget {
  workspace: string;
  runId: string;
}

export interface TeamScheduledTurn {
  roleId: string;
  reason?: string;
  taskId?: string;
  findingId?: string;
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
}

export interface TeamRoleTurnResult {
  status: TeamTurnStatus;
  messages?: TeamMessageDraft[];
  signoffs?: { roleId?: string; messageId?: string; createdAt?: string }[];
  verification?: Omit<TeamVerificationRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: string };
  materialChange?: boolean;
  reason?: string;
}

export interface TeamTurnRunner {
  runRoleTurn(input: TeamRoleTurnInput): Promise<TeamRoleTurnResult>;
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
 * Default scheduler: adapts the engine's run state to the pure scheduler's input
 * and drives selection through `selectNextTurns` (TASK-007), mapping its
 * phase-aware decision back onto the engine's turn lifecycle.
 */
class DefaultTeamScheduler implements TeamScheduler {
  selectNextTurns(state: TeamRunState, context: TeamSchedulerContext): TeamSchedulerDecision {
    if (state.status !== 'running') return { turns: [] };
    const decision = selectNextTurns(buildSchedulerState(state, context));
    if (decision.terminal) {
      return {
        turns: [],
        reason: decision.reason,
        terminal: {
          status: decision.terminal.status === 'done' ? 'completed' : 'blocked',
          reason: decision.terminal.reason,
        },
      };
    }
    return {
      turns: decision.turns.map((turn) => ({ roleId: turn.roleId, reason: turn.reason })),
      reason: decision.reason,
    };
  }
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
  constructor(private readonly limits: { maxTurns: number; maxRounds: number }) {}

  evaluate(state: TeamRunState): TeamCompletionDecision {
    const evaluation = evaluateRunGate(buildCompletionInput(state), buildGuardCounters(state), {
      maxTurns: this.limits.maxTurns,
      maxRounds: this.limits.maxRounds,
      maxCorrectionCycles: DISABLED_GUARD,
    });
    if (evaluation.complete) return { complete: true, reasons: [] };
    if (evaluation.status === 'running') return { complete: false, reasons: evaluation.reasons };
    return {
      complete: false,
      reasons: evaluation.reasons,
      terminalStatus: evaluation.status === 'failed' ? 'failed' : 'blocked',
    };
  }
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
export function createTeamTurnRunner(options: TeamTurnRunnerAdapterOptions): TeamTurnRunner {
  return {
    async runRoleTurn(input: TeamRoleTurnInput): Promise<TeamRoleTurnResult> {
      const result = await runRoleTurn({
        manager: options.manager,
        paths: new TigerPaths(input.workspace),
        config: options.config,
        runId: input.runId,
        role: {
          id: input.role.id,
          name: input.role.name,
          persona: input.role.persona,
          responsibilities: input.role.responsibilities,
          agent: { tool: input.role.tool },
        },
        assignedTask: input.taskId
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
      return mapRunnerResult(result);
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
  return { turns: state.turnCount, rounds: state.round, noProgressRounds: 0, correctionCycles: 0 };
}

function toModelVerification(record: TeamVerificationRecord, runId: string): TeamModelVerification {
  return {
    id: record.id,
    runId,
    roleId: '',
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
  return {
    status: runnerStateToTurnStatus(result.outcome.state),
    messages: result.parsed.messages.map(toEngineDraft),
    signoffs: signoffs.length ? signoffs : undefined,
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
  private activeExecutionRunId: string | null = null;
  private runLeaseHeartbeat: NodeJS.Timeout | null = null;
  private runLeaseRefresh: Promise<void> | null = null;
  private persistGate: Promise<unknown> = Promise.resolve();
  private lastBoundarySteering: TeamDirective[] = [];

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
  /** Consecutive failed turns since the last successful turn (recovery guard). */
  private consecutiveTurnFailures = 0;

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
    this.scheduler = options.scheduler ?? new DefaultTeamScheduler();
    this.runner = options.runner ?? new MissingTeamTurnRunner();
    this.completionGate =
      options.completionGate ?? new DefaultCompletionGate({ maxTurns: this.maxTurns, maxRounds: this.maxRounds });
  }

  async createTeamRun(input: CreateTeamRunInput): Promise<TeamRunState> {
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
      materialChangeAt: createdAt,
      createdAt,
      message: 'Ready to start.',
    };
    this.paths = paths;
    await this.refreshWorkQueues();
    const seed = await this.appendMessage({
      from: USER_SENDER,
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
    if (isTerminalStatus(state.status) && state.status !== 'interrupted' && state.status !== 'blocked') {
      throw httpError(409, `cannot resume a ${state.status} team run`);
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
    const message = await this.appendMessage({
      from,
      kind: 'steering',
      channel: 'directives',
      body: text,
      createdAt,
    });
    state.directives.push({
      id: nanoid(),
      messageId: message.id,
      body: text,
      createdAt: message.createdAt,
      status: 'pending',
    });
    state.materialChangeAt = message.createdAt;
    this.staleSignoffs('Steering changed the run scope.');
    state.pendingSteeringCount = this.countPendingSteering();
    state.message = 'Steering will be applied at the next turn boundary.';
    await this.persistState();
    this.emitState();
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

  async listMessages(afterSeq = 0, target?: TeamRunTarget): Promise<TeamMessage[]> {
    const paths = target ? new TeamPaths(path.resolve(target.workspace), target.runId) : this.requirePaths();
    return this.messageBus.list(paths, afterSeq);
  }

  private async startLoop(status: 'running'): Promise<TeamRunState> {
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
      await this.drainSteeringAtBoundary();
      if (await this.completeOrStopFromGate()) return;
      if (await this.pauseIfRequested()) return;

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
        await this.finishRun('blocked', decision.reason ?? 'Scheduler did not select a next turn.');
        return;
      }

      state.round += 1;
      await this.persistState();
      this.emitState();
      const turns = this.limitWritableConcurrency(decision.turns);
      await Promise.all(turns.map((turn) => this.runOneTurn(turn, signal)));
      // A turn (or a concurrent stop()) may have already driven the run to a terminal
      // state. Bail before mutating/re-persisting it or re-evaluating the completion gate,
      // so a terminal status is never overwritten with a misleading `completed`.
      if (this.requireState().status !== 'running') return;
      await this.markBoundarySteeringApplied();
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

    const turn: TeamTurnRecord = {
      id: nanoid(),
      runId: state.runId,
      roleId: role.id,
      roleName: role.name,
      status: 'running',
      round: state.round,
      startedAt: nowIso(),
      messageSeqs: [],
      appliedDirectiveIds: this.lastBoundarySteering.map((directive) => directive.id),
      reason: scheduled.reason,
    };
    state.currentTurn = turn;
    state.turns.push(turn);
    role.status = 'running';
    role.lastTurnAt = turn.startedAt;
    await this.persistState();
    this.emitState();

    try {
      const result = await this.runner.runRoleTurn({
        workspace: state.workspace,
        paths: this.requirePaths(),
        runId: state.runId,
        role: { ...role },
        turn: clone(turn),
        state: this.getState(),
        messages: await this.listMessages(),
        appliedSteering: clone(this.lastBoundarySteering),
        signal,
        taskId: scheduled.taskId,
        findingId: scheduled.findingId,
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
      await this.persistState();
      this.emitState();
    }
  }

  private async applyTurnResult(turn: TeamTurnRecord, role: TeamRoleInstance, result: TeamRoleTurnResult): Promise<void> {
    const state = this.requireState();
    const messages = result.messages ?? [];
    const signedOffRoleIds = new Set<string>();
    for (const draft of messages) {
      const message = await this.appendMessage({ ...draft, turnId: draft.turnId ?? turn.id });
      turn.messageSeqs.push(message.seq);
      if (isMaterialMessage(message.kind)) {
        state.materialChangeAt = message.createdAt;
        this.staleSignoffs(`${message.kind} message changed the run state.`);
      }
      if (message.kind === 'signoff') {
        this.recordSignoff(role, message);
        signedOffRoleIds.add(role.id);
      }
    }
    if (result.verification) {
      const verification: TeamVerificationRecord = {
        id: result.verification.id ?? nanoid(),
        status: result.verification.status,
        command: result.verification.command,
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
    for (const signoff of result.signoffs ?? []) {
      const signoffRole = state.roles.find((entry) => entry.id === (signoff.roleId ?? role.id)) ?? role;
      // Skip roles already signed off via a `kind: 'signoff'` message this turn so a
      // single logical sign-off is not recorded twice (once per source).
      if (signedOffRoleIds.has(signoffRole.id)) continue;
      this.recordSignoff(signoffRole, undefined, signoff.createdAt, signoff.messageId);
    }

    turn.status = result.status;
    turn.endedAt = nowIso();
    turn.reason = result.reason;
    state.turnCount += 1;
    await this.refreshWorkQueues();

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

  private async drainSteeringAtBoundary(): Promise<void> {
    const state = this.requireState();
    const pending = state.directives.filter((directive) => directive.status === 'pending');
    this.lastBoundarySteering = pending;
    if (pending.length === 0) return;
    const ts = nowIso();
    for (const directive of pending) {
      directive.status = 'acknowledged';
      directive.acknowledgedAt = ts;
    }
    state.pendingSteeringCount = this.countPendingSteering();
    await this.persistState();
    this.emitState();
  }

  private async markBoundarySteeringApplied(): Promise<void> {
    if (this.lastBoundarySteering.length === 0) return;
    const state = this.requireState();
    const appliedAt = nowIso();
    const ids = new Set(this.lastBoundarySteering.map((directive) => directive.id));
    for (const directive of state.directives) {
      if (!ids.has(directive.id) || directive.status === 'applied') continue;
      directive.status = 'applied';
      directive.appliedAt = appliedAt;
    }
    this.lastBoundarySteering = [];
    state.pendingSteeringCount = this.countPendingSteering();
    await this.persistState();
    this.emitState();
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
    await this.persistState();
    this.emitState();
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
    if (this.state) this.emit('state', this.getState());
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
      tool: role.tool === 'claude' ? 'claude' : 'codex',
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
  if (status === 'stopped' || status === 'paused') return 'stopped';
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

interface HttpError extends Error {
  status: number;
}

function httpError(status: number, message: string): HttpError {
  const err = new Error(message) as HttpError;
  err.status = status;
  return err;
}
