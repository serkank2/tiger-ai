import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { createWorktree, isGitRepo, removeWorktree, worktreeDiff, type Worktree } from '../git/worktree.js';
import type { TerminalManager } from '../terminal/TerminalManager.js';
import type { RunTemplateService } from '../services/run-templates.js';
import { STAGE_META, TigerPaths, agentLabel } from './paths.js';
import { STAGE_ORDER } from './types.js';
import type {
  AgentRun,
  AgentType,
  OrchestratorState,
  ProjectInfo,
  ReviewStatus,
  RunTemplate,
  StageId,
  StageRunConfig,
  StageState,
  StageStatus,
  TaskRecord,
  TigerConfig,
} from './types.js';
import { defaultTigerConfig, loadConfig, normalizeConfig, saveConfig, validateConfigPatch } from './config.js';
import { ensureScaffold } from './scaffold.js';
import { buildLaunchCommand } from './launch-command.js';
import { AgentSession } from './AgentSession.js';
import { composePrompt, type ComposeOptions } from './compose.js';
import { checkOutputFile, markerExists } from './validate.js';
import { checkUpstreamArtifacts, evaluateCompletionGate, requiredSelfReport } from './completion-gate.js';
import { boundedConcurrency, drainPool, runPool } from './worker-pool.js';
import { logAgentResult, logNote, logStageEnd, logStageStart } from './runlog.js';
import {
  NoopExecutionPersistence,
  fileArtifact,
  leaseExpiresAt,
  ownerKey,
  type ExecutionRunStatus,
  type ExecutionOwner,
  type ExecutionPersistence,
  type PersistedAgentRunRecord,
  type PersistedStageRecord,
} from './persistence.js';
import {
  claimNextTaskFile,
  finishTaskFile,
  hasTaskFiles,
  listTaskRecords,
  parseTasks,
  reclaimStaleTaskClaims,
  releaseLock,
  reviewTaskFile,
  splitTasksToFiles,
  summarizeTasks,
} from './tasks.js';
import {
  claimNextFinding,
  finishFinding,
  hasFindings,
  listFindings,
  reclaimStaleFindings,
  readFindingBlock,
  splitFindingsToFiles,
  summarizeFindings,
  type FindingsSummary,
} from './findings.js';
import { BUILTIN_TEMPLATES } from './templates.js';

const nowIso = (): string => new Date().toISOString();

interface TerminalRemovalTarget {
  id: string;
  label: string;
}

export interface OrchestratorOptions {
  persistence?: ExecutionPersistence;
  owner?: ExecutionOwner;
  runTemplates?: RunTemplateService;
  /**
   * When true, an interrupted fan-out stage detected on initialize/attach is automatically
   * re-dispatched (Epic-5 auto-resume). Off by default: auto-spawning agents at boot has real cost
   * and lease implications, so the default is detection-only and resume is an explicit user action.
   */
  autoResumeInterruptedStages?: boolean;
}

function formatRemovalFailure(reason: unknown): string {
  if (reason instanceof Error) return reason.message || reason.name;
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}

function stageStatusToRunStatus(status: StageStatus): ExecutionRunStatus {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'stopped') return 'stopped';
  return 'interrupted';
}

// ---------------------------------------------------------------------------
// Git-worktree-per-task isolation (opt-in; see config.tiger.worktreePerTask).
//
// When enabled and the workspace is a git repo, each parallel task in the
// execute stage runs in its own throwaway worktree on branch `kaplan/<taskId>`.
// The pure helpers below decide a run's cwd and plan the merge-back; the
// side-effecting flow lives in the Orchestrator (createWorktree -> launch with
// the worktree cwd -> diff -> merge back -> remove). Conflict-on-merge leaves the
// worktree + branch intact and marks the task needing attention.
// ---------------------------------------------------------------------------

/** Outcome classes for the per-task branch merge-back. */
export type MergeOutcome = 'fast-forward' | 'merged' | 'conflict' | 'failed';

/**
 * Decide the working directory a run should launch in. Pure + unit-tested.
 * Worktree isolation only applies when (a) it is enabled, (b) the workspace is a
 * git repo, and (c) we successfully created a worktree (worktreePath set). In every
 * other case the run uses the shared tiger root — i.e. default-off behavior is
 * byte-for-byte identical to before.
 */
export function decideRunCwd(opts: {
  tigerRoot: string;
  enabled: boolean;
  isRepo: boolean;
  worktreePath?: string | null;
}): string {
  if (opts.enabled && opts.isRepo && opts.worktreePath) return opts.worktreePath;
  return opts.tigerRoot;
}

/**
 * Classify a `git merge` result into a {@link MergeOutcome}. Pure + unit-tested.
 * Detects the "CONFLICT"/"Automatic merge failed" signature git prints so callers
 * can leave the worktree intact for inspection instead of auto-resolving.
 */
export function classifyMergeResult(res: { ok: boolean; stdout: string; stderr: string }): MergeOutcome {
  if (res.ok) {
    return /already up to date|fast-forward/i.test(res.stdout) ? 'fast-forward' : 'merged';
  }
  const blob = `${res.stdout}\n${res.stderr}`.toLowerCase();
  if (blob.includes('conflict') || blob.includes('automatic merge failed') || blob.includes('overwritten by merge')) {
    return 'conflict';
  }
  return 'failed';
}

/**
 * The Tiger workflow engine. Owns the selected workspace, per-workspace config, and
 * in-memory stage/agent run state. Reuses the shared TerminalManager to run interactive
 * Claude/Codex CLI agents (one ephemeral terminal per agent run), detects completion via
 * AgentSession, validates outputs, writes the run log, and tracks task status.
 *
 * Emits 'state' (OrchestratorState) whenever anything observable changes so the WS layer
 * can push the snapshot to the UI.
 */
export class Orchestrator extends EventEmitter {
  private workspace: string | null = null;
  private paths: TigerPaths | null = null;
  private config: TigerConfig = defaultTigerConfig();
  private projectPrompt = '';
  private initialized = false;
  private busy = false;
  private currentStage: StageId | null = null;
  private stages: Record<StageId, StageState> = blankStages();
  private abort: AbortController | null = null;
  private correctionCycles = 0;
  /** When true, the next stage starts automatically after the current one completes successfully. */
  private autoAdvance = false;
  /** Per-stage configs used during an auto run (Run All). Falls back to defaults when a stage is absent. */
  private autoConfigs: Partial<Record<StageId, StageRunConfig>> = {};
  private activeRunId: string | null = null;
  private activeLeaseOwner: string | null = null;
  private activeLeaseExpiresAt: string | null = null;
  private runLeaseHeartbeat: NodeJS.Timeout | null = null;
  private runLeaseRefresh: Promise<void> | null = null;
  private readonly persistence: ExecutionPersistence;
  /** Default execution owner (manual unless overridden at construction). Used when no scoped owner is active. */
  private readonly defaultOwner: ExecutionOwner;
  /** When set (e.g. by the queue Scheduler), executions persist under this owner instead of the default. */
  private activeOwner: ExecutionOwner | null = null;
  private runTemplates?: RunTemplateService;
  private readonly autoResumeInterruptedStages: boolean;
  /**
   * Worktrees this run created for the active execute stage, keyed by task id. Tracked so an
   * abort/cleanup path can prune any that a clean merge-back did not already remove. Only ever
   * populated when config.tiger.worktreePerTask is enabled and the workspace is a git repo.
   */
  private taskWorktrees = new Map<string, Worktree>();
  /** Task ids whose worktree was deliberately KEPT (merge conflict) — never auto-pruned. */
  private keptWorktrees = new Set<string>();
  /** Cached per-stage decision: is worktree-per-task active right now? Resolved once per stage. */
  private worktreeStageActive = false;
  /**
   * Semantic per-stage success, set by the claim-draining stages (executing-plan / task-review) from
   * the TASK/FINDING outcomes rather than from CLI run.state. finalizeStage consults this so a stage
   * whose work all ended blocked/needs-attention is NOT reported `completed` (which would otherwise
   * satisfy auto-advance and the destructive auto-delete). Absent = no semantic override for the stage.
   */
  private stageSucceeded: Partial<Record<StageId, boolean>> = {};

  constructor(
    private readonly manager: TerminalManager,
    options: OrchestratorOptions = {},
  ) {
    super();
    this.persistence = options.persistence ?? new NoopExecutionPersistence();
    this.defaultOwner = options.owner ?? { type: 'manual', id: `${process.pid}:${nanoid(6)}` };
    this.runTemplates = options.runTemplates;
    this.autoResumeInterruptedStages = options.autoResumeInterruptedStages ?? false;
  }

  /** The owner under which executions are currently persisted (the scoped owner if set, else the default). */
  private get owner(): ExecutionOwner {
    return this.activeOwner ?? this.defaultOwner;
  }

  /**
   * Scope subsequent executions to a specific owner so persisted state (execution_runs, run_stages,
   * agent_runs, task claims, finding claims) records that owner. The queue Scheduler uses this to run
   * Tiger stages as `queue:*` instead of the default `manual:*`. Pass null to revert to the default.
   */
  setExecutionOwner(owner: ExecutionOwner | null): void {
    this.activeOwner = owner;
  }

  setRunTemplateService(runTemplates: RunTemplateService): void {
    this.runTemplates = runTemplates;
  }

  // --- state ---

  getConfig(): TigerConfig {
    return this.config;
  }

  getState(): OrchestratorState {
    return {
      workspace: this.workspace,
      tigerRoot: this.paths?.root ?? null,
      initialized: this.initialized,
      projectPromptPreview: this.projectPrompt.slice(0, 400),
      currentStage: this.currentStage,
      busy: this.busy,
      stages: this.stages,
      tasks: this.tasksSummary,
      findings: this.findingsSummary,
      correctionCycles: this.correctionCycles,
      maxCorrectionCycles: this.config.execution.maxCorrectionCycles,
      autoAdvance: this.autoAdvance,
    };
  }

  private tasksSummary: OrchestratorState['tasks'] = null;
  private findingsSummary: FindingsSummary | null = null;
  /** Serializes task/finding claims so concurrent workers never select the same item. */
  private claimGate: Promise<unknown> = Promise.resolve();

  /**
   * Run a claim strictly after any in-flight claim completes (a single-process mutex). File-level
   * atomicity (O_EXCL locks + atomic rename) is kept as a backstop, but serializing here removes the
   * race entirely: each claim's readdir sees the previous claim's rename, so every agent gets a
   * distinct task/finding and the status updates stick.
   */
  private serializeClaim<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.claimGate.then(fn, fn);
    this.claimGate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private emitState(): void {
    this.emit('state', this.getState());
  }

  // --- workspace lifecycle ---

  /** User-initiated: scaffold the tiger/ tree with this project prompt and load it. */
  async initialize(workspace: string, projectPrompt: string): Promise<void> {
    if (this.busy) throw httpError(409, 'a stage is currently running');
    this.paths = await ensureScaffold(workspace, projectPrompt);
    this.workspace = workspace;
    // The on-disk project-prompt.md is the source of truth (scaffold preserves an existing one).
    this.projectPrompt = await fs.readFile(this.paths.projectPromptFile, 'utf8').catch(() => projectPrompt);
    this.config = await loadConfig(this.paths.configFile);
    this.initialized = true;
    this.correctionCycles = 0;
    this.stages = blankStages();
    await this.stopRunLeaseHeartbeat();
    this.clearActiveRunLease();
    await this.persistence.init();
    await this.reconcilePersistentState();
    await this.reclaimStaleClaims();
    const restored = await this.restoreStagesFromPersistence();
    if (!restored) await this.deriveStagesFromDisk();
    await this.refreshTasks();
    await this.refreshFindings();
    await this.quarantineInterruptedOutputs();
    this.emitState();
    await this.maybeResumeInterruptedStages();
  }

  /** Stages that were left mid-run by a previous backend (restored as `interrupted`). */
  interruptedStages(): StageId[] {
    return STAGE_ORDER.filter((s) => this.stages[s].status === 'interrupted');
  }

  /**
   * Re-dispatch the first interrupted fan-out stage so its incomplete work resumes. The
   * claim-based stages (executing-plan / task-review) are inherently resumable — reconciliation
   * has already reset abandoned in_progress task/fixing finding files back to claimable, so simply
   * re-running the stage picks up exactly the unfinished items. Standard fan-out stages re-run in
   * full (their partial outputs were quarantined on init). No-op when nothing is interrupted or a
   * stage is already running.
   *
   * Returns the resumed stage id, or null if there was nothing to resume.
   */
  async resumeInterruptedStages(): Promise<StageId | null> {
    if (!this.paths || !this.initialized) throw httpError(400, 'initialize a workspace first');
    if (this.busy) throw httpError(409, 'a stage is already running');
    const interrupted = this.interruptedStages();
    const stageId = interrupted[0];
    if (!stageId) return null;
    const cfg = this.stages[stageId].config ?? this.defaultStageConfig(stageId);
    await logNote(this.paths.runLogFile, `Resuming interrupted stage ${STAGE_META[stageId].title}.`).catch(() => {});
    await this.startStage(stageId, cfg, false);
    return stageId;
  }

  /** On init/attach: log any interrupted stages and, when enabled, auto-resume the first one. */
  private async maybeResumeInterruptedStages(): Promise<void> {
    const interrupted = this.interruptedStages();
    if (interrupted.length === 0) return;
    if (this.paths) {
      await logNote(
        this.paths.runLogFile,
        `Detected ${interrupted.length} interrupted stage(s): ${interrupted.map((s) => STAGE_META[s].title).join(', ')}.` +
          (this.autoResumeInterruptedStages ? ' Auto-resuming.' : ' Resume them when ready.'),
      ).catch(() => {});
    }
    if (!this.autoResumeInterruptedStages) return;
    // Fire-and-forget: do not block initialize on a full stage run.
    void this.resumeInterruptedStages().catch((err) => {
      if (this.paths) {
        const message = err instanceof Error ? err.message : String(err);
        void logNote(this.paths.runLogFile, `Auto-resume failed to start: ${message}`).catch(() => {});
      }
    });
  }

  /** Startup restore: attach to an existing workspace without overwriting the prompt. */
  async attachWorkspace(workspace: string): Promise<void> {
    const paths = new TigerPaths(workspace);
    const existing = await fs.readFile(paths.projectPromptFile, 'utf8').catch(() => null);
    if (existing == null) {
      // Not initialized yet — just remember the directory.
      this.workspace = workspace;
      this.paths = paths;
      this.initialized = false;
      this.emitState();
      return;
    }
    await this.initialize(workspace, existing);
  }

  async replaceProjectPrompt(projectPrompt: string): Promise<OrchestratorState> {
    if (!this.paths || !this.initialized) throw httpError(400, 'initialize a workspace first');
    const prompt = projectPrompt.trim();
    if (!prompt) throw httpError(400, 'project prompt is required');
    await fs.writeFile(this.paths.projectPromptFile, prompt, 'utf8');
    this.projectPrompt = prompt;
    this.emitState();
    return this.getState();
  }

  async updateConfig(partial: unknown): Promise<TigerConfig> {
    if (!this.paths) throw httpError(400, 'no workspace selected');
    const validationError = validateConfigPatch(partial, this.config);
    if (validationError) throw httpError(400, validationError);
    const merged = normalizeConfig({ ...this.config, ...(partial && typeof partial === 'object' ? partial : {}) });
    // Persist to disk BEFORE mutating in-memory state: if the write fails, the error surfaces and
    // this.config is left untouched, so in-memory config never silently diverges from config.json.
    await saveConfig(this.paths.configFile, merged);
    this.config = merged;
    return merged;
  }

  // --- stage control ---

  /**
   * Validate + kick off a stage (non-blocking). Progress arrives via 'state' events.
   * When `auto` is true, the workflow auto-advances to the next stage on success.
   */
  async startStage(stageId: StageId, cfg: StageRunConfig, auto = false): Promise<void> {
    if (!this.paths || !this.initialized) throw httpError(400, 'initialize a workspace first');
    if (this.busy) throw httpError(409, 'a stage is already running');
    if (!STAGE_ORDER.includes(stageId)) throw httpError(400, 'unknown stage');

    this.autoAdvance = auto;
    this.busy = true;
    this.currentStage = stageId;
    this.abort = new AbortController();
    const stage = this.stages[stageId];
    // Clear previous agent terminals for this stage so old tiles don't linger.
    void this.cleanupStageTerminals(stage);
    stage.status = 'running';
    stage.runs = [];
    stage.startedAt = nowIso();
    stage.endedAt = undefined;
    stage.message = undefined;
    stage.config = cfg; // remember what this stage ran with, for the UI
    this.emitState();

    let runId: string | null = null;
    try {
      runId = await this.beginPersistentRun();
      await this.persistence.startStage({
        workspace: this.workspace!,
        runId,
        stageId,
        status: 'running',
        cfg,
        owner: this.owner,
        ttlMs: this.config.execution.lockTtlMs,
        startedAt: stage.startedAt,
      });
    } catch (err) {
      this.busy = false;
      this.currentStage = null;
      this.abort = null;
      stage.status = 'not_started';
      stage.startedAt = undefined;
      stage.message = err instanceof Error ? err.message : String(err);
      if (runId) await this.finishPersistentRun(runId, 'failed', stage.message);
      this.emitState();
      throw err;
    }

    void this.executeStage(stageId, cfg)
      .catch((err) => {
        stage.status = 'failed';
        stage.message = err instanceof Error ? err.message : String(err);
      })
      .finally(async () => {
        this.busy = false;
        this.abort = null;
        stage.endedAt = nowIso();
        await this.persistence.finishStage({
          workspace: this.workspace!,
          runId,
          stageId,
          status: stage.status,
          cfg: stage.config,
          message: stage.message,
          owner: this.owner,
          ttlMs: this.config.execution.lockTtlMs,
          startedAt: stage.startedAt,
          endedAt: stage.endedAt,
        });
        const isFinalAutoStage = this.autoAdvance && STAGE_ORDER.indexOf(stageId) === STAGE_ORDER.length - 1;
        if (!this.autoAdvance || stage.status !== 'completed' || isFinalAutoStage) {
          await this.finishPersistentRun(runId, stageStatusToRunStatus(stage.status), stage.message);
        }
        this.emitState();
        this.maybeAutoAdvance(stageId);
      });
  }

  /** Configure-all-then-run: auto-advance from `fromStage` using a per-stage config map. */
  async startAll(configs: Partial<Record<StageId, StageRunConfig>>, fromStage?: StageId): Promise<void> {
    if (!this.paths || !this.initialized) throw httpError(400, 'initialize a workspace first');
    if (this.busy) throw httpError(409, 'a stage is already running');
    this.autoConfigs = configs;
    const start = fromStage && STAGE_ORDER.includes(fromStage) ? fromStage : this.firstIncompleteStage();
    // Starting an auto-run from a mid stage must not consume missing/empty upstream artifacts.
    const upstream = await checkUpstreamArtifacts(this.paths, start);
    if (!upstream.ok) throw httpError(400, upstream.reason ?? `upstream artifacts for ${start} are missing`);
    await this.startStage(start, configs[start] ?? this.defaultStageConfig(start), true);
  }

  private firstIncompleteStage(): StageId {
    return STAGE_ORDER.find((s) => this.stages[s].status !== 'completed') ?? 'brainstorming';
  }

  // --- Run All templates ---

  /** Built-in templates plus DB-backed global custom templates. */
  listRunTemplates(): Promise<RunTemplate[]> {
    return this.runTemplates ? this.runTemplates.list() : Promise.resolve(BUILTIN_TEMPLATES);
  }

  async saveRunTemplate(t: RunTemplate): Promise<RunTemplate[]> {
    if (!this.runTemplates) throw httpError(503, 'run template storage is not available');
    await this.runTemplates.save(t);
    return this.listRunTemplates();
  }

  async deleteRunTemplate(name: string): Promise<RunTemplate[]> {
    if (!this.runTemplates) throw httpError(503, 'run template storage is not available');
    await this.runTemplates.archive(name);
    return this.listRunTemplates();
  }

  /** After a stage finishes: if auto-advancing and it succeeded, start the next stage. */
  private maybeAutoAdvance(stageId: StageId): void {
    if (!this.autoAdvance) return;
    const stage = this.stages[stageId];
    if (stage.status !== 'completed') {
      // A user stop/interrupt always halts. Otherwise, when continue-on-failure is enabled and the
      // stage FAILED but still produced some output, mark it `continued` (downstream agents then get
      // the upstream-continued warning) and push forward instead of halting the whole auto-run. The
      // upstream-artifacts check below still stops a chain whose next stage would have nothing to run.
      const userHalted = stage.status === 'stopped' || stage.status === 'interrupted' || !!this.abort?.signal.aborted;
      const producedSome = stage.runs.some((r) => r.state === 'completed');
      if (this.config.execution.continueOnFailure && stage.status === 'failed' && producedSome && !userHalted) {
        this.stages[stageId].continued = true;
        void logNote(
          this.paths!.runLogFile,
          `Auto-continuing past failed stage ${stageId} (partial success); proceeding to the next stage.`,
        ).catch(() => {});
      } else {
        this.autoAdvance = false; // stop the chain on a user stop, or a stage that produced nothing
        void logNote(
          this.paths!.runLogFile,
          `Auto-advance stopped at stage ${stageId} (status: ${stage.status}).`,
        ).catch(() => {});
        this.emitState();
        return;
      }
    }
    const idx = STAGE_ORDER.indexOf(stageId);
    const next = STAGE_ORDER[idx + 1];
    if (!next) {
      this.autoAdvance = false; // reached the final stage
      this.emitState();
      void this.cleanupAfterAutoRun();
      return;
    }
    void logNote(this.paths!.runLogFile, `Auto-advancing from ${stageId} to ${next}.`).catch(() => {});
    // Validate the next stage's upstream artifacts before auto-dispatching it: a missing/empty
    // upstream output stops the chain with a clear message instead of running a degenerate stage.
    void (async () => {
      const upstream = await checkUpstreamArtifacts(this.paths!, next);
      if (!upstream.ok) {
        this.autoAdvance = false;
        this.stages[next].message = upstream.reason ?? `upstream artifacts for ${next} are missing`;
        await logNote(this.paths!.runLogFile, `Auto-advance stopped: ${this.stages[next].message}`).catch(() => {});
        this.emitState();
        return;
      }
      await this.startStage(next, this.autoConfigs[next] ?? this.defaultStageConfig(next), true);
    })().catch((err) => {
      this.autoAdvance = false;
      this.stages[next].message = `Auto-advance failed to start: ${err instanceof Error ? err.message : String(err)}`;
      this.emitState();
    });
  }

  /**
   * After an auto-run (Run All) completes the final stage, delete the whole .tiger workspace and
   * return to the launcher (so re-running the same project always starts clean).
   *
   * DESTRUCTIVE — strictly gated:
   *  1. requires explicit opt-in (config.execution.deleteTigerOnComplete),
   *  2. requires VERIFIED success — every stage must be `completed`; a single failed/stopped/
   *     interrupted stage cancels the delete so partial work is never silently lost,
   *  3. only resets in-memory state AFTER the removal is verified to have actually succeeded
   *     (the directory is gone). If removal fails, the workspace is kept intact with a message.
   */
  private async cleanupAfterAutoRun(): Promise<void> {
    if (!this.paths || !this.config.execution.deleteTigerOnComplete) return;

    // (2) Verified success: refuse to delete unless every stage completed cleanly.
    const incomplete = STAGE_ORDER.filter((s) => this.stages[s].status !== 'completed');
    if (incomplete.length > 0) {
      await logNote(
        this.paths.runLogFile,
        `Skipping auto-delete of the .tiger workspace: ${incomplete.length} stage(s) did not complete ` +
          `(${incomplete.map((s) => STAGE_META[s].title).join(', ')}). Preserving the workspace.`,
      ).catch(() => {});
      this.emitState();
      return;
    }

    const root = this.paths.root;
    await logNote(this.paths.runLogFile, 'Auto-run complete — deleting the .tiger workspace.').catch(() => {});
    try {
      await fs.rm(root, { recursive: true, force: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logNote(this.paths.runLogFile, `Auto-delete failed; preserving the workspace: ${message}`).catch(() => {});
      if (this.currentStage) this.stages[this.currentStage].message = `Auto-delete failed: ${message}`;
      this.emitState();
      return;
    }
    // (3) Verify the removal actually happened before discarding in-memory state.
    const stillExists = await fs
      .stat(root)
      .then(() => true)
      .catch(() => false);
    if (stillExists) {
      await logNote(this.paths.runLogFile, 'Auto-delete did not remove the workspace; preserving it.').catch(() => {});
      this.emitState();
      return;
    }

    // Leave the workspace so the UI returns to the launcher.
    this.workspace = null;
    this.paths = null;
    this.initialized = false;
    this.projectPrompt = '';
    this.currentStage = null;
    this.correctionCycles = 0;
    this.autoAdvance = false;
    this.busy = false;
    this.stages = blankStages();
    this.tasksSummary = null;
    this.findingsSummary = null;
    await this.stopRunLeaseHeartbeat();
    this.clearActiveRunLease();
    this.emitState();
  }

  /** Build a stage run configuration from the saved defaults (used during auto-advance). */
  private defaultStageConfig(_stageId: StageId): StageRunConfig {
    const d = this.config.defaults;
    return {
      claudeAgents: d.claudeAgents,
      codexAgents: d.codexAgents,
      antigravityAgents: d.antigravityAgents,
      claudeModel: d.claudeModel,
      codexModel: d.codexModel,
      antigravityModel: d.antigravityModel,
      claudeEffort: d.claudeEffort,
      codexEffort: d.codexEffort,
      antigravityEffort: d.antigravityEffort,
      claudePermission: d.claudePermission,
      codexPermission: d.codexPermission,
      antigravityPermission: d.antigravityPermission,
      parallel: d.parallel,
      mergeAgent: 'claude',
    };
  }

  /** Re-run only the failed agents of a stage. */
  async retryStage(stageId: StageId): Promise<void> {
    if (!this.paths || !this.initialized) throw httpError(400, 'initialize a workspace first');
    if (this.busy) throw httpError(409, 'a stage is already running');
    const stage = this.stages[stageId];
    const failed = stage.runs.filter((r) => r.state === 'failed' || r.state === 'stopped' || r.state === 'interrupted');
    if (failed.length === 0) throw httpError(400, 'no failed agents to retry');

    this.autoAdvance = false; // a manual retry never auto-advances
    this.busy = true;
    this.currentStage = stageId;
    this.abort = new AbortController();
    stage.status = 'running';
    this.emitState();

    let runId: string | null = null;
    try {
      runId = await this.beginPersistentRun();
      await this.persistence.startStage({
        workspace: this.workspace!,
        runId,
        stageId,
        status: 'running',
        cfg: stage.config,
        owner: this.owner,
        ttlMs: this.config.execution.lockTtlMs,
        startedAt: stage.startedAt ?? nowIso(),
      });
    } catch (err) {
      this.busy = false;
      this.currentStage = null;
      this.abort = null;
      stage.status = 'failed';
      stage.message = err instanceof Error ? err.message : String(err);
      if (runId) await this.finishPersistentRun(runId, 'failed', stage.message);
      this.emitState();
      throw err;
    }

    void (async () => {
      const signal = this.abort!.signal;
      await logNote(this.paths!.runLogFile, `Retrying ${failed.length} failed agent(s) in stage ${stageId}.`);
      await runPool(failed, this.concurrency(stageId, failed.length), async (run) => {
        if (signal.aborted) return;
        await this.executeAgentRun(run, await this.composeExtrasFor(run), signal);
      });
      this.finalizeStage(stageId);
    })()
      .catch((err) => {
        stage.status = 'failed';
        stage.message = err instanceof Error ? err.message : String(err);
      })
      .finally(async () => {
        this.busy = false;
        this.abort = null;
        stage.endedAt = nowIso();
        await this.persistence.finishStage({
          workspace: this.workspace!,
          runId,
          stageId,
          status: stage.status,
          cfg: stage.config,
          message: stage.message,
          owner: this.owner,
          ttlMs: this.config.execution.lockTtlMs,
          startedAt: stage.startedAt,
          endedAt: stage.endedAt,
        });
        await this.finishPersistentRun(runId, stageStatusToRunStatus(stage.status), stage.message);
        this.emitState();
      });
  }

  stopStage(): void {
    this.autoAdvance = false;
    this.abort?.abort();
    if (this.currentStage) this.stages[this.currentStage].message = 'Stopped by user.';
  }

  /** Explicit user decision to accept a stage's failures and let the workflow proceed. */
  continueStage(stageId: StageId): void {
    if (!this.paths || !this.initialized) throw httpError(400, 'initialize a workspace first');
    if (!STAGE_ORDER.includes(stageId)) throw httpError(400, 'unknown stage');
    this.stages[stageId].continued = true;
    void logNote(
      this.paths.runLogFile,
      `User chose to CONTINUE DESPITE FAILURES at stage ${stageId} (${STAGE_META[stageId].title}).`,
    ).catch(() => {});
    this.emitState();
  }

  /** Route unresolved final-review issues back to Stage 5 or 6A, bounded by maxCorrectionCycles. */
  routeCorrection(target: StageId): void {
    if (!this.paths || !this.initialized) throw httpError(400, 'initialize a workspace first');
    if (this.busy) throw httpError(409, 'a stage is currently running');
    if (target !== 'executing-plan' && target !== 'task-review') {
      throw httpError(400, 'correction can only be routed to executing-plan or task-review');
    }
    const max = this.config.execution.maxCorrectionCycles;
    if (this.correctionCycles >= max) {
      throw httpError(409, `correction cycle limit reached (${max}); resolve the remaining issues manually`);
    }
    this.correctionCycles += 1;
    // Reset the target stage and everything downstream so the corrected work re-runs and re-validates.
    const from = STAGE_ORDER.indexOf(target);
    for (let i = from; i < STAGE_ORDER.length; i++) {
      const s = STAGE_ORDER[i]!;
      this.stages[s] = { id: s, status: 'not_started', runs: [] };
    }
    this.currentStage = target;
    void logNote(
      this.paths.runLogFile,
      `Correction cycle ${this.correctionCycles}/${max}: routed unresolved issues back to ${STAGE_META[target].title}; downstream stages were reset.`,
    ).catch(() => {});
    this.emitState();
  }

  /** A warning to inject into downstream agent prompts when an upstream stage was continued. */
  private upstreamContinuedWarning(stage: StageId): string | undefined {
    const idx = STAGE_ORDER.indexOf(stage);
    const continued = STAGE_ORDER.slice(0, idx).filter((s) => this.stages[s].continued);
    if (!continued.length) return undefined;
    const names = continued.map((s) => STAGE_META[s].title).join(', ');
    return `Upstream stage(s) were continued despite failures: ${names}. Their outputs may be incomplete — proceed carefully and note any gaps you find.`;
  }

  // --- stage execution ---

  private async executeStage(stageId: StageId, cfg: StageRunConfig): Promise<void> {
    const paths = this.paths!;
    const signal = this.abort!.signal;
    // Clear any prior semantic outcome; the claim-draining stages set it fresh from task/finding state.
    delete this.stageSucceeded[stageId];
    await fs.mkdir(paths.runtimeDir(stageId), { recursive: true }).catch(() => {});
    if (stageId === 'executing-plan') await this.reclaimStaleExecutionClaims();
    if (stageId === 'task-review') await this.reclaimStaleFindingClaims();
    await logStageStart(paths.runLogFile, stageId, cfg);

    if (stageId === 'executing-plan') {
      await this.executeExecutionStage(cfg, signal);
    } else if (stageId === 'task-review') {
      await this.executeTaskReviewStage(cfg, signal);
    } else {
      await this.executeFanOutStage(stageId, cfg, signal);
    }

    this.finalizeStage(stageId);

    if (stageId === 'merge-tasks') await this.refreshTasks();
    if (stageId === 'requesting-code-review') await this.writeFinalSummary(stageId);
  }

  /** Standard stages (brainstorming, plan, tasks, merge, code-review): N+M independent agents. */
  private async executeFanOutStage(stageId: StageId, cfg: StageRunConfig, signal: AbortSignal): Promise<void> {
    const meta = STAGE_META[stageId];
    const stage = this.stages[stageId];
    const runs: AgentRun[] = [];

    if (meta.singleAgent) {
      const type = cfg.mergeAgent ?? 'claude';
      runs.push(this.makeRun(stageId, type, 1, cfg));
    } else {
      for (let i = 1; i <= clampCount(cfg.claudeAgents); i++) runs.push(this.makeRun(stageId, 'claude', i, cfg));
      for (let i = 1; i <= clampCount(cfg.codexAgents); i++) runs.push(this.makeRun(stageId, 'codex', i, cfg));
      for (let i = 1; i <= clampCount(cfg.antigravityAgents); i++)
        runs.push(this.makeRun(stageId, 'antigravity', i, cfg));
    }
    stage.runs = runs;
    for (const r of runs) {
      r.runId = this.activeRunId ?? undefined;
      this.registerRun(r);
      await this.recordAgentSnapshot(r);
    }
    this.emitState();

    if (runs.length === 0) {
      stage.message = 'No agents were configured for this stage.';
      return;
    }
    await runPool(runs, this.concurrency(stageId, runs.length, cfg.parallel), async (run) => {
      if (signal.aborted) return;
      await this.executeAgentRunWithRetry(run, await this.composeExtrasFor(run), signal);
    });
  }

  /** Stage 5: split tasks into per-task files, then claim/implement them one task per agent run. */
  private async executeExecutionStage(cfg: StageRunConfig, signal: AbortSignal): Promise<void> {
    const paths = this.paths!;
    const stage = this.stages['executing-plan'];
    await this.ensureTaskFiles();
    await this.reclaimStaleExecutionClaims();
    if (!(await hasTaskFiles(paths.tasksDir))) {
      stage.message = 'No merged task file found. Run the Merge Tasks stage first.';
      stage.runs = [];
      return;
    }
    const all = await listTaskRecords(paths.tasksDir);
    await this.recordTaskRecords(all);
    if (all.length === 0) {
      stage.message = 'The merged task file contains no tasks.';
      return;
    }
    if (!all.some((t) => t.executionStatus === 'not_started')) {
      stage.message = 'No tasks are in not_started state; nothing to execute.';
      return;
    }

    // Worker type slots. Parallel: one concurrent worker per configured agent. Sequential: a
    // single worker that round-robins types so every configured provider is still used.
    const types: AgentType[] = [];
    for (let i = 0; i < clampCount(cfg.claudeAgents); i++) types.push('claude');
    for (let i = 0; i < clampCount(cfg.codexAgents); i++) types.push('codex');
    for (let i = 0; i < clampCount(cfg.antigravityAgents); i++) types.push('antigravity');
    if (types.length === 0) {
      stage.message = 'No agents were configured for this stage.';
      return;
    }

    // Resolve worktree-per-task isolation for this stage exactly once (an `isGitRepo` probe per
    // task would be wasteful and could race). Active only when opted in AND the workspace is a git
    // repo; otherwise every run uses the shared tiger root, byte-for-byte as before.
    this.taskWorktrees.clear();
    this.keptWorktrees.clear();
    this.worktreeStageActive = config.tiger.worktreePerTask && !!this.workspace && (await isGitRepo(this.workspace));
    if (this.worktreeStageActive) {
      await logNote(
        paths.runLogFile,
        'Worktree-per-task isolation is ON: each task runs in its own git worktree, merged back on clean completion.',
      ).catch(() => {});
    }

    let counter = 0;
    // Claim + implement exactly one task with the given agent type. The claim is an atomic file
    // rename (not_started -> in_progress); the filename is the lock. Returns false when none remain.
    // `++counter` is synchronous (runs before the first await), so concurrent workers always get a
    // UNIQUE index — and therefore a unique label and output-log file. A worker that claims nothing
    // (queue drained) simply never creates a run, so extra agents beyond the task count never start.
    const processTask = async (type: AgentType): Promise<boolean> => {
      const index = ++counter;
      const claimed = await this.serializeClaim(() =>
        claimNextTaskFile(
          paths.tasksDir,
          agentLabel(type, index),
          nowIso(),
          this.config.execution.locking
            ? { locksDir: paths.locksDir, agentType: type, ttlMs: this.config.execution.lockTtlMs }
            : undefined,
        ),
      );
      if (!claimed) return false;
      // A claim is correctness-critical: force a fresh refresh so this task's lease is genuinely
      // extended for the current owner (never piggybacking on an in-flight heartbeat refresh).
      await this.refreshActiveRunLease(true);
      await this.persistence.recordTaskClaim({
        workspace: this.workspace!,
        task: claimed.record,
        leaseOwner: this.activeLeaseOwner,
        leaseExpiresAt: this.activeLeaseExpiresAt,
      });
      const run = this.makeRun('executing-plan', type, index, cfg, claimed.record.id);
      run.runId = this.activeRunId ?? undefined;
      // Isolate this task in its own git worktree (if enabled) BEFORE registering the terminal,
      // so the PTY launches with the worktree as its cwd. On any worktree-creation failure we log
      // and fall back to the shared cwd — isolation is best-effort and never blocks execution.
      const worktree = await this.maybeCreateTaskWorktree(claimed.record.id);
      run.cwd = decideRunCwd({
        tigerRoot: paths.root,
        enabled: this.worktreeStageActive,
        isRepo: this.worktreeStageActive,
        worktreePath: worktree?.path ?? null,
      });
      stage.runs.push(run);
      this.registerRun(run);
      await this.recordAgentSnapshot(run);
      void logNote(paths.runLogFile, `${run.label} claimed ${claimed.record.id} (atomic rename to in_progress).`).catch(
        () => {},
      );
      this.emitState();

      await this.executeAgentRunWithRetry(run, { taskId: claimed.record.id, taskBlock: claimed.block }, signal);

      // Semantic completion gate: a finished run that did NOT emit an EXECUTION_RESULT self-report
      // (or reported blocked) is treated as blocked, never silently done.
      const output = await fs.readFile(run.outputPath, 'utf8').catch(() => '');
      const gate = evaluateCompletionGate(requiredSelfReport('executing-plan'), run.state === 'completed', output);
      let finalStatus: 'done' | 'blocked' = gate.ok ? 'done' : 'blocked';
      if (!gate.ok && gate.reason) {
        run.error = run.error ?? gate.reason;
        void logNote(paths.runLogFile, `${run.label} blocked on ${claimed.record.id}: ${gate.reason}`);
      }
      // Surface the worktree's change set and merge its branch back into the workspace. A merge
      // conflict (or other merge failure) downgrades the task to blocked and KEEPS the worktree +
      // branch intact for manual inspection; a clean merge prunes the worktree.
      if (worktree) {
        const mergeResult = await this.mergeBackTaskWorktree(run, claimed.record.id, worktree, finalStatus === 'done');
        if (mergeResult === 'conflict' || mergeResult === 'failed') finalStatus = 'blocked';
      }
      await finishTaskFile(paths.tasksDir, claimed.record.id, finalStatus, nowIso());
      const finalRecord = (await listTaskRecords(paths.tasksDir)).find((t) => t.id === claimed.record.id);
      if (finalRecord) await this.persistence.recordTaskFinish({ workspace: this.workspace!, task: finalRecord });
      if (this.config.execution.locking) await releaseLock(paths.lockFile(claimed.record.id));
      await this.refreshTasks();
      return true;
    };

    // Bounded worker pool over a shared task queue: at most maxConcurrent agents run at once
    // (sequential mode pins it to 1). A shared round-robin cursor keeps every configured
    // provider in rotation without spawning one worker per slot.
    let typeCursor = 0;
    await drainPool<AgentType>({
      limit: this.drainConcurrency(cfg.parallel, types.length),
      shouldStop: () => signal.aborted,
      claim: async () => {
        const type = types[typeCursor++ % types.length]!;
        return (await processTask(type)) ? type : null;
      },
      process: async () => {
        /* processTask already implemented the claimed task; nothing further to do */
      },
    });
    // Prune any worktrees that survived (e.g. left intact on conflict, or stranded by an abort).
    // Conflict worktrees are deliberately KEPT for inspection; everything else is force-removed.
    await this.pruneStageWorktrees();
    await this.refreshTasks();

    // Derive semantic stage success from the TASK outcomes, not from CLI run.state. The completion
    // gate downgrades tasks to `blocked` without ever touching run.state, so a stage whose tasks all
    // ended blocked would otherwise finalize as `completed` (satisfying auto-advance + auto-delete on
    // entirely-blocked work). A stage succeeds only when it was not aborted, produced at least one
    // done task, and left NO task blocked.
    const finalTasks = await listTaskRecords(paths.tasksDir);
    const blocked = finalTasks.filter((t) => t.executionStatus === 'blocked').length;
    const doneCount = finalTasks.filter((t) => t.executionStatus === 'done').length;
    this.stageSucceeded['executing-plan'] = !signal.aborted && blocked === 0 && doneCount > 0;
    if (!this.stageSucceeded['executing-plan'] && !stage.message) {
      stage.message =
        blocked > 0
          ? `${blocked} task(s) ended blocked; the stage needs attention before advancing.`
          : 'No tasks were completed.';
    }
  }

  // --- git-worktree-per-task isolation helpers (no-ops unless the stage is active) ---

  /**
   * Create an isolated worktree for `taskId` when worktree-per-task is active for this stage.
   * Returns the worktree (also tracked for cleanup), or null when isolation is off or creation
   * fails — callers then fall back to the shared cwd. Never throws: isolation is best-effort.
   */
  private async maybeCreateTaskWorktree(taskId: string): Promise<Worktree | null> {
    if (!this.worktreeStageActive || !this.workspace) return null;
    try {
      const wt = await createWorktree({ repoDir: this.workspace, taskId });
      this.taskWorktrees.set(taskId, wt);
      void logNote(this.paths!.runLogFile, `Created worktree for ${taskId} at ${wt.path} on ${wt.branch}.`).catch(
        () => {},
      );
      return wt;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void logNote(
        this.paths!.runLogFile,
        `Worktree creation for ${taskId} failed (${message}); running in the shared workspace instead.`,
      ).catch(() => {});
      return null;
    }
  }

  /**
   * Capture the worktree's change set (logged as the per-task diff) and merge its branch back into
   * the workspace's current branch. On a clean merge the worktree is removed; on conflict/failure
   * the worktree + branch are KEPT intact for manual inspection and the outcome is returned so the
   * caller can mark the task blocked. Never throws.
   */
  private async mergeBackTaskWorktree(
    run: AgentRun,
    taskId: string,
    worktree: Worktree,
    runSucceeded: boolean,
  ): Promise<MergeOutcome> {
    const paths = this.paths!;
    const repoDir = this.workspace!;

    // 1. Record the per-task diff (best-effort; failure here must not block the merge).
    try {
      const diff = await worktreeDiff({ worktreePath: worktree.path, baseRef: worktree.baseRef });
      const summary = diff.files.length ? `${diff.files.length} file(s): ${diff.files.join(', ')}` : 'no changes';
      void logNote(paths.runLogFile, `${run.label} worktree diff for ${taskId} — ${summary}.`).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void logNote(paths.runLogFile, `Could not diff worktree for ${taskId} (${message}).`).catch(() => {});
    }

    // 2. Merge the task branch back. Skip on a failed run — never merge a half-finished branch.
    if (!runSucceeded) {
      this.keptWorktrees.add(taskId);
      void logNote(
        paths.runLogFile,
        `${run.label} did not complete cleanly; KEEPING worktree ${worktree.path} (branch ${worktree.branch}) un-merged for inspection.`,
      ).catch(() => {});
      return 'failed';
    }

    // Commit any uncommitted changes the agent left in the worktree so the merge sees them.
    await this.commitWorktree(worktree, taskId);

    const res = await this.runGitCapture(repoDir, ['merge', '--no-edit', worktree.branch]);
    const outcome = classifyMergeResult(res);

    if (outcome === 'conflict' || outcome === 'failed') {
      // Do NOT auto-resolve. Abort the in-progress merge so the workspace returns to a clean state,
      // then keep the worktree + branch for the user to resolve manually.
      await this.runGitCapture(repoDir, ['merge', '--abort']);
      this.keptWorktrees.add(taskId);
      const detail = (res.stderr || res.stdout).trim().split('\n')[0] ?? '';
      run.error = run.error ?? `merge ${outcome} for ${taskId}: ${detail}`;
      void logNote(
        paths.runLogFile,
        `MERGE ${outcome.toUpperCase()} merging ${worktree.branch} back for ${taskId}: ${detail}. ` +
          `KEEPING worktree ${worktree.path} and branch ${worktree.branch} for manual resolution.`,
      ).catch(() => {});
      this.emitState();
      return outcome;
    }

    // Clean merge — surface it, then remove the now-redundant worktree.
    void logNote(paths.runLogFile, `Merged ${worktree.branch} back for ${taskId} (${outcome}).`).catch(() => {});
    await removeWorktree({ repoDir, path: worktree.path, force: true }).catch(() => {});
    this.taskWorktrees.delete(taskId);
    return outcome;
  }

  /** Commit everything the agent left in the worktree onto its branch (best-effort, never throws). */
  private async commitWorktree(worktree: Worktree, taskId: string): Promise<void> {
    await this.runGitCapture(worktree.path, ['add', '-A']);
    // `git commit` exits non-zero when there is nothing to commit — that is fine (a no-op task).
    await this.runGitCapture(worktree.path, ['commit', '--no-edit', '-m', `kaplan: task ${taskId}`]);
  }

  /**
   * Force-remove any tracked worktrees that were NOT deliberately kept (clean ones are already
   * gone; this sweeps strays left by an abort). Conflict-kept worktrees are preserved. Clears the
   * tracking maps. Never throws.
   */
  private async pruneStageWorktrees(): Promise<void> {
    if (!this.workspace) {
      this.taskWorktrees.clear();
      this.keptWorktrees.clear();
      return;
    }
    const repoDir = this.workspace;
    for (const [taskId, wt] of this.taskWorktrees) {
      if (this.keptWorktrees.has(taskId)) continue;
      await removeWorktree({ repoDir, path: wt.path, force: true }).catch(() => {});
    }
    this.taskWorktrees.clear();
    this.keptWorktrees.clear();
  }

  /** Run a git command in `cwd`, capturing stdout/stderr. Never rejects (mirrors git/worktree.ts). */
  private runGitCapture(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (ok: boolean): void => {
        if (!settled) {
          settled = true;
          resolve({ ok, stdout, stderr });
        }
      };
      try {
        const child = spawn('git', args, { cwd, windowsHide: true, shell: false });
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
          finish(false);
        }, 30_000);
        timer.unref?.();
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (c: string) => {
          if (stdout.length < 1_000_000) stdout += c;
        });
        child.stderr.on('data', (c: string) => {
          if (stderr.length < 64_000) stderr += c;
        });
        child.on('error', () => {
          clearTimeout(timer);
          finish(false);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          finish(code === 0);
        });
      } catch {
        finish(false);
      }
    });
  }

  /**
   * Stage 6A — two phases:
   *  FIND: review agents (partitioned over done tasks) report problems as findings.
   *  FIX:  the orchestrator splits findings into a per-finding queue; fix agents claim findings by
   *        atomic rename and resolve them one at a time (so two agents never fix the same finding).
   * A clean review (no findings) skips the FIX phase entirely and approves all tasks.
   */
  private async executeTaskReviewStage(cfg: StageRunConfig, signal: AbortSignal): Promise<void> {
    const paths = this.paths!;
    const stage = this.stages['task-review'];
    await this.ensureTaskFiles();
    const done = (await listTaskRecords(paths.tasksDir)).filter((t) => t.executionStatus === 'done');

    // --- Phase 1: FIND (review + report findings, no fixing) ---
    const findRuns: AgentRun[] = [];
    for (let i = 1; i <= clampCount(cfg.claudeAgents); i++)
      findRuns.push(this.makeRun('task-review', 'claude', i, cfg));
    for (let i = 1; i <= clampCount(cfg.codexAgents); i++) findRuns.push(this.makeRun('task-review', 'codex', i, cfg));
    for (let i = 1; i <= clampCount(cfg.antigravityAgents); i++)
      findRuns.push(this.makeRun('task-review', 'antigravity', i, cfg));
    stage.runs = findRuns;
    for (const r of findRuns) {
      r.runId = this.activeRunId ?? undefined;
      this.registerRun(r);
      await this.recordAgentSnapshot(r);
    }
    this.emitState();
    if (findRuns.length === 0) {
      stage.message = 'No agents were configured for this stage.';
      return;
    }

    const partitions = new Map<string, string[]>();
    findRuns.forEach((r) => partitions.set(r.id, []));
    done.forEach((t, i) => partitions.get(findRuns[i % findRuns.length]!.id)!.push(t.id));
    for (const t of done) await reviewTaskFile(paths.tasksDir, t.id, 'reviewing');
    await this.recordTaskRecords(await listTaskRecords(paths.tasksDir));
    await this.refreshTasks();

    await runPool(findRuns, this.concurrency('task-review', findRuns.length, cfg.parallel), async (run) => {
      if (signal.aborted) return;
      await this.executeAgentRun(run, { reviewTaskIds: partitions.get(run.id) ?? [], reviewPhase: 'find' }, signal);
    });

    // FIND-phase completion gate: a review that crashed/timed-out/emitted malformed output never
    // wrote its REVIEW_RESULT sentinel. Its partition cannot be trusted as clean, so every task it
    // was assigned is marked needs-attention at rollup (instead of silently rolling up to approved).
    const needsAttentionTaskIds = new Set<string>();
    for (const run of findRuns) {
      const output = await fs.readFile(run.outputPath, 'utf8').catch(() => '');
      const gate = evaluateCompletionGate(requiredSelfReport('task-review', 'find'), run.state === 'completed', output);
      if (gate.ok) continue;
      run.error = run.error ?? gate.reason;
      const assigned = partitions.get(run.id) ?? [];
      for (const id of assigned) needsAttentionTaskIds.add(id);
      if (assigned.length) {
        void logNote(
          paths.runLogFile,
          `Review agent ${run.label} did not complete its FIND phase (${gate.reason}); marking ${assigned.length} ` +
            `task(s) as needing attention: ${assigned.join(', ')}.`,
        ).catch(() => {});
      }
    }

    // Collect findings from the review logs into a per-finding work queue.
    const logs = await Promise.all(
      findRuns.map(async (r) => ({ label: r.label, content: await fs.readFile(r.outputPath, 'utf8').catch(() => '') })),
    );
    const found = await splitFindingsToFiles(logs, paths.findingsDir);
    await this.persistence.recordFindings(found.map((finding) => ({ workspace: this.workspace!, finding })));
    await logNote(paths.runLogFile, `Task review reported ${found.length} finding(s).`);
    await this.refreshFindings();
    await this.reclaimStaleFindingClaims();

    // --- Phase 2: FIX (only if there are findings; clean review skips this entirely) ---
    if (!signal.aborted && (await hasFindings(paths.findingsDir))) {
      const types: AgentType[] = [];
      for (let i = 0; i < clampCount(cfg.claudeAgents); i++) types.push('claude');
      for (let i = 0; i < clampCount(cfg.codexAgents); i++) types.push('codex');
      for (let i = 0; i < clampCount(cfg.antigravityAgents); i++) types.push('antigravity');
      let counter = findRuns.length; // keep run labels/output files unique within this stage
      const processFinding = async (type: AgentType): Promise<boolean> => {
        const index = ++counter;
        const label = agentLabel(type, index);
        const claimed = await this.serializeClaim(() =>
          claimNextFinding(
            paths.findingsDir,
            this.config.execution.locking
              ? {
                  locksDir: paths.findingLocksDir,
                  agentId: label,
                  agentType: type,
                  ttlMs: this.config.execution.lockTtlMs,
                }
              : undefined,
          ),
        );
        if (!claimed) return false;
        const findingRecord = (await listFindings(paths.findingsDir)).find((f) => f.id === claimed.id);
        if (findingRecord) {
          // Correctness-critical claim: force a fresh refresh (see refreshActiveRunLease).
          await this.refreshActiveRunLease(true);
          await this.persistence.recordFindingClaim({
            workspace: this.workspace!,
            finding: findingRecord,
            leaseOwner: this.activeLeaseOwner,
            leaseExpiresAt: this.activeLeaseExpiresAt,
          });
        }
        const run = this.makeRun('task-review', type, index, cfg, claimed.id);
        run.runId = this.activeRunId ?? undefined;
        stage.runs.push(run);
        this.registerRun(run);
        await this.recordAgentSnapshot(run);
        void logNote(paths.runLogFile, `${run.label} claimed ${claimed.id} to fix.`).catch(() => {});
        this.emitState();
        await this.executeAgentRun(
          run,
          { reviewPhase: 'fix', findingId: claimed.id, findingBlock: claimed.block },
          signal,
        );
        // Semantic completion gate: only a completed run that emits FIX_RESULT: fixed counts as fixed;
        // a missing FIX_RESULT (or wontfix) leaves the finding unresolved (wontfix), never silently fixed.
        const fixOutput = await fs.readFile(run.outputPath, 'utf8').catch(() => '');
        const gate = evaluateCompletionGate(
          requiredSelfReport('task-review', 'fix'),
          run.state === 'completed',
          fixOutput,
        );
        if (!gate.ok && gate.reason) {
          run.error = run.error ?? gate.reason;
          void logNote(paths.runLogFile, `${run.label} did not resolve ${claimed.id}: ${gate.reason}`).catch(() => {});
        }
        await finishFinding(paths.findingsDir, claimed.id, gate.ok ? 'fixed' : 'wontfix');
        const finalFinding = (await listFindings(paths.findingsDir)).find((f) => f.id === claimed.id);
        if (finalFinding)
          await this.persistence.recordFindingFinish({ workspace: this.workspace!, finding: finalFinding });
        if (this.config.execution.locking) await releaseLock(paths.findingLockFile(claimed.id));
        await this.refreshFindings();
        return true;
      };
      // Bounded worker pool over the shared finding queue (capped at maxConcurrent).
      let typeCursor = 0;
      await drainPool<AgentType>({
        limit: this.drainConcurrency(cfg.parallel, types.length),
        shouldStop: () => signal.aborted,
        claim: async () => {
          const type = types[typeCursor++ % types.length]!;
          return (await processFinding(type)) ? type : null;
        },
        process: async () => {
          /* processFinding already resolved the claimed finding */
        },
      });
    }

    // Roll findings up into each task's review status. A task whose review partition did not complete
    // its FIND phase is forced to needs_fix (needs attention) regardless of finding count, so an
    // un-reviewed task is never auto-approved on the strength of a crashed/empty review.
    const finalFindings = await listFindings(paths.findingsDir);
    for (const t of done) {
      const own = finalFindings.filter((f) => f.relatedTask === t.id);
      const rs: ReviewStatus = needsAttentionTaskIds.has(t.id)
        ? 'needs_fix'
        : own.length === 0
          ? 'approved'
          : own.every((f) => f.status === 'fixed')
            ? 'fixed'
            : 'needs_fix';
      await reviewTaskFile(paths.tasksDir, t.id, rs);
    }
    // Record whether the review stage actually succeeded so finalizeStage does not report a stage as
    // completed when reviews were inconclusive or fixes did not resolve their findings (see #2/#3).
    const unresolvedFindings = finalFindings.some((f) => f.status !== 'fixed');
    this.stageSucceeded['task-review'] = !signal.aborted && needsAttentionTaskIds.size === 0 && !unresolvedFindings;
    if (!this.stageSucceeded['task-review'] && !stage.message) {
      stage.message = needsAttentionTaskIds.size
        ? `${needsAttentionTaskIds.size} task(s) need attention: their review did not complete or findings are unresolved.`
        : 'Some findings were not resolved.';
    }
    await this.recordTaskRecords(await listTaskRecords(paths.tasksDir));
    await this.refreshTasks();
    await this.refreshFindings();
  }

  private async reclaimStaleClaims(): Promise<void> {
    await this.reclaimStaleExecutionClaims();
    await this.reclaimStaleFindingClaims();
  }

  private async reclaimStaleExecutionClaims(): Promise<void> {
    if (!this.paths) return;
    const reclaimed = await reclaimStaleTaskClaims(this.paths.tasksDir, {
      locksDir: this.config.execution.locking ? this.paths.locksDir : undefined,
      ttlMs: this.config.execution.lockTtlMs,
    });
    if (reclaimed.length > 0) {
      await this.recordTaskRecords(reclaimed);
      await logNote(
        this.paths.runLogFile,
        `Reclaimed ${reclaimed.length} stale executing-plan claim(s): ${reclaimed.map((t) => t.id).join(', ')}.`,
      );
      await this.refreshTasks();
    }
  }

  private async reclaimStaleFindingClaims(): Promise<void> {
    if (!this.paths) return;
    const reclaimed = await reclaimStaleFindings(this.paths.findingsDir, {
      locksDir: this.config.execution.locking ? this.paths.findingLocksDir : undefined,
      ttlMs: this.config.execution.lockTtlMs,
    });
    if (reclaimed.length > 0) {
      await this.persistence.recordFindings(reclaimed.map((finding) => ({ workspace: this.workspace!, finding })));
      await logNote(
        this.paths.runLogFile,
        `Reclaimed ${reclaimed.length} stale task-review finding claim(s): ${reclaimed.map((f) => f.id).join(', ')}.`,
      );
      await this.refreshFindings();
    }
  }

  private async refreshFindings(): Promise<void> {
    if (!this.paths) {
      this.findingsSummary = null;
      return;
    }
    // Single hasFindings + single listFindings — the previous double-read of each was redundant.
    if (await hasFindings(this.paths.findingsDir)) {
      const records = await listFindings(this.paths.findingsDir);
      this.findingsSummary = summarizeFindings(records);
      await this.persistence.recordFindings(records.map((finding) => ({ workspace: this.workspace!, finding })));
    } else {
      this.findingsSummary = null;
    }
    this.emitState();
  }

  // --- single agent run ---

  private async composeExtrasFor(run: AgentRun): Promise<Partial<ComposeOptions>> {
    if (run.stage === 'task-review') {
      // A fix run carries the finding id in run.taskId; otherwise it's a find run.
      if (run.taskId && run.taskId.startsWith('FINDING')) {
        return {
          reviewPhase: 'fix',
          findingId: run.taskId,
          findingBlock: await readFindingBlock(this.paths!.findingsDir, run.taskId),
        };
      }
      return { reviewPhase: 'find' };
    }
    if (run.stage === 'requesting-code-review') {
      return { summary: this.pipelineSummary() };
    }
    return {};
  }

  /** A concise journey summary handed to the final-review stage instead of bulk logs. */
  private pipelineSummary(): string {
    const lines = STAGE_ORDER.filter((s) => s !== 'requesting-code-review').map((s) => {
      const st = this.stages[s];
      return `- ${STAGE_META[s].title}: ${st.status}${st.message ? ` — ${st.message}` : ''}`;
    });
    const t = this.tasksSummary;
    const tasksLine = t
      ? `\nTasks: ${t.byExecution.done} done, ${t.byExecution.blocked} blocked, ${t.total} total.`
      : '';
    return `The project was produced by the Tiger pipeline. Stage outcomes:\n${lines.join('\n')}${tasksLine}`;
  }

  private async executeAgentRun(run: AgentRun, extras: Partial<ComposeOptions>, signal: AbortSignal): Promise<void> {
    const paths = this.paths!;
    this.registerRun(run); // idempotent safety net (covers the retry path)
    run.attempts += 1;
    run.startedAt = nowIso();
    run.endedAt = undefined;
    run.error = undefined;
    run.completion = undefined;
    run.state = 'starting';
    run.runId = this.activeRunId ?? run.runId;
    await this.recordAgentSnapshot(run);
    this.emitState();

    await fs.mkdir(paths.runtimeDir(run.stage), { recursive: true }).catch(() => {});
    const promptText = await composePrompt({
      paths,
      stage: run.stage,
      label: run.label,
      outputPath: run.outputPath,
      markerPath: run.markerPath,
      taskId: run.taskId,
      // When a per-task git worktree is the run's cwd, state it as the working directory + boundary so
      // the agent's code edits land in the worktree (captured by the diff/merge-back) instead of the
      // shared .tiger root. composeWorkdir treats run.cwd === paths.root (the default) as no override.
      workdir: run.cwd,
      ...extras,
      warning: this.upstreamContinuedWarning(run.stage),
    });
    await fs.writeFile(run.promptPath, promptText, 'utf8');
    await this.recordArtifactPath(run, 'prompt', run.promptPath);
    await this.recordArtifactPath(run, 'output', run.outputPath);
    await this.recordArtifactPath(run, 'marker', run.markerPath);
    // Clear any stale marker AND any leftover output from a previous run of this same run slot so
    // completion detection reflects THIS run only. Without clearing the output file, the idle/exit
    // gate (and the semantic completion gate that reads run.outputPath) could accept a prior run's
    // deliverable — e.g. a retried/re-dispatched agent that produces nothing would still look "done".
    await fs.rm(run.markerPath, { force: true }).catch(() => {});
    await fs.rm(run.outputPath, { force: true }).catch(() => {});

    const session = new AgentSession({
      manager: this.manager,
      termId: run.terminalId,
      label: run.label,
      command: run.command,
      // Per-task git worktree when isolation is active; otherwise the shared tiger root (default).
      cwd: run.cwd ?? paths.root,
      promptPath: run.promptPath,
      outputPath: run.outputPath,
      markerPath: run.markerPath,
      timing: this.config.timing,
      onState: (s) => {
        run.state = s;
        void this.recordAgentSnapshot(run);
        this.emitState();
      },
    });

    const result = await session.run(signal);
    run.state = result.state;
    run.completion = result.completion;
    run.exitCode = result.exitCode ?? null;
    run.error = result.error;
    run.endedAt = nowIso();
    await this.recordAgentSnapshot(run);
    await this.recordArtifactPath(run, 'prompt', run.promptPath);
    await this.recordArtifactPath(run, 'output', run.outputPath);
    await this.recordArtifactPath(run, 'marker', run.markerPath);
    await logAgentResult(paths.runLogFile, run);
    this.emitState();
  }

  /**
   * Run an agent, automatically retrying a FAILED run up to `execution.maxAttempts` total attempts.
   * A success, a user stop/interrupt, or an aborted signal ends the loop immediately; only a genuine
   * `failed` state with attempts remaining triggers a retry. `executeAgentRun` already re-increments
   * `run.attempts` and clears the prior marker/output, so each retry starts clean. Used by the
   * auto-run stage workers; the manual `retryStage` path stays a single explicit pass.
   */
  private async executeAgentRunWithRetry(
    run: AgentRun,
    extras: Partial<ComposeOptions>,
    signal: AbortSignal,
  ): Promise<void> {
    const maxAttempts = Math.max(1, this.config.execution.maxAttempts);
    for (;;) {
      await this.executeAgentRun(run, extras, signal);
      if (run.state === 'completed') return;
      if (signal.aborted || run.state === 'stopped' || run.state === 'interrupted') return;
      if (run.attempts >= maxAttempts) return; // retries exhausted — leave it failed
      void logNote(
        this.paths!.runLogFile,
        `${run.label} failed (attempt ${run.attempts}/${maxAttempts}); retrying.`,
      ).catch(() => {});
      // Drop the exited PTY before retrying: TerminalSession.start() does NOT relaunch an
      // already-started/exited session (that is what restart() is for), so reusing the same terminal
      // would hang waiting for a banner that never comes. remove() disposes the session, and
      // executeAgentRun's registerRun re-creates a fresh definition so the next attempt spawns a new PTY.
      await this.manager.remove(run.terminalId).catch(() => {});
    }
  }

  // --- helpers ---

  private makeRun(stage: StageId, type: AgentType, index: number, cfg: StageRunConfig, taskId?: string): AgentRun {
    const id = nanoid();
    const outputPath = this.paths!.outputFile(stage, type, index);
    // Each provider reads its own model/effort/permission so an Antigravity run is never launched
    // with Codex/Claude values it cannot use.
    const model = type === 'claude' ? cfg.claudeModel : type === 'codex' ? cfg.codexModel : cfg.antigravityModel;
    const effort = type === 'claude' ? cfg.claudeEffort : type === 'codex' ? cfg.codexEffort : cfg.antigravityEffort;
    const permission =
      type === 'claude' ? cfg.claudePermission : type === 'codex' ? cfg.codexPermission : cfg.antigravityPermission;
    return {
      id,
      runId: this.activeRunId ?? undefined,
      terminalId: id,
      stage,
      type,
      index,
      label: agentLabel(type, index),
      outputPath,
      outputRel: this.paths!.rel(outputPath),
      markerPath: this.paths!.markerFile(stage, id),
      promptPath: this.paths!.promptFileFor(stage, id),
      // Honor the stage's explicitly-selected permission mode (yolo/dangerous/full). Without this
      // opt-in the launch builder strips the blanket `--dangerously-*` flag and the agent would open
      // in the CLI's restricted prompt-for-everything default. Mirrors the Team runner.
      command: buildLaunchCommand(
        this.config,
        type,
        { model, effort, permission },
        {
          allowDangerous: config.tiger.honorDangerousPermissions,
        },
      ),
      state: 'pending',
      attempts: 0,
      taskId,
    };
  }

  private concurrency(_stageId: StageId, count: number, parallel = true): number {
    if (!parallel) return 1;
    // Cap parallel fan-out at execution.maxConcurrent so a stage with many agents never
    // launches an unbounded number of PTYs at once; the rest queue behind the pool.
    // maxConcurrent <= 0 means UNLIMITED: every selected agent starts at once (cap = count).
    const max = this.config.execution.maxConcurrent;
    const cap = max <= 0 ? count : boundedConcurrency(max);
    return Math.max(1, Math.min(cap, count));
  }

  /** Concurrency for the claim-draining stages (executing-plan / task-review FIX). */
  private drainConcurrency(parallel: boolean, slots: number): number {
    if (!parallel) return 1;
    // maxConcurrent <= 0 means UNLIMITED: run one worker per configured slot (no extra cap).
    const max = this.config.execution.maxConcurrent;
    const cap = max <= 0 ? Math.max(1, slots) : boundedConcurrency(max);
    return Math.max(1, Math.min(cap, Math.max(1, slots)));
  }

  private finalizeStage(stageId: StageId): void {
    const stage = this.stages[stageId];
    const total = stage.runs.length;
    const succeeded = stage.runs.filter((r) => r.state === 'completed').length;
    const interrupted = stage.runs.some((r) => r.state === 'interrupted');
    const stopped = stage.runs.some((r) => r.state === 'stopped') || this.abort?.signal.aborted;
    let status: StageStatus;
    if (total === 0) status = stage.status === 'running' ? 'completed' : stage.status;
    else if (succeeded === total) status = 'completed';
    else if (interrupted) status = 'interrupted';
    else if (stopped) status = 'stopped';
    else status = 'failed';
    // Semantic override: the claim-draining stages decide success from TASK/FINDING outcomes, not from
    // CLI run.state. Even when every agent's run.state is `completed`, a stage whose tasks all ended
    // blocked (or whose reviews were inconclusive / findings unresolved) must NOT be reported
    // `completed`, or it would wrongly satisfy auto-advance and the destructive auto-delete. Downgrade
    // a would-be `completed` to `failed` (needs attention). We never UPGRADE: a genuine fail/stop/
    // interrupt outcome is preserved.
    const semanticOutcome = this.stageSucceeded[stageId];
    if (status === 'completed' && semanticOutcome === false) {
      status = 'failed';
      if (this.abort?.signal.aborted) status = 'stopped';
    }
    stage.status = status;
    if (!stage.message) {
      stage.message = total === 0 ? stage.message : `${succeeded}/${total} agent(s) completed successfully.`;
    }
    void logStageEnd(this.paths!.runLogFile, stageId, status, succeeded, total);
    this.emitState();
  }

  private async cleanupStageTerminals(stage: StageState): Promise<void> {
    await this.removeTerminalsBestEffort(
      stage.runs.map((r) => ({ id: r.terminalId, label: `${stage.id}/${r.label}` })),
      'stage cleanup',
    );
  }

  private agentTerminalTargets(): TerminalRemovalTarget[] {
    const out = new Map<string, TerminalRemovalTarget>();
    for (const s of STAGE_ORDER) {
      for (const r of this.stages[s].runs) {
        out.set(r.terminalId, { id: r.terminalId, label: `${s}/${r.label}` });
      }
    }
    return [...out.values()];
  }

  private async removeTerminalsBestEffort(terminals: TerminalRemovalTarget[], context: string): Promise<void> {
    const results = await Promise.allSettled(terminals.map(async (terminal) => this.manager.remove(terminal.id)));
    const runLogFile = this.paths?.runLogFile;
    if (!runLogFile) return;

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === 'rejected') {
        const terminal = terminals[i]!;
        await logNote(
          runLogFile,
          `Failed to remove terminal ${terminal.label} (${terminal.id}) during ${context}: ${formatRemovalFailure(result.reason)}.`,
        );
      }
    }
  }

  /** Register the ephemeral agent terminal so the live UI tile can attach immediately. */
  private registerRun(run: AgentRun): void {
    const now = nowIso();
    this.manager.upsertDefinition({
      id: run.terminalId,
      name: run.label,
      groupId: null,
      // Honor a per-task worktree cwd when set; otherwise the shared tiger root (default behavior).
      cwd: run.cwd ?? this.paths!.root,
      initialCommand: run.command,
      shell: { kind: 'system-default' },
      // Protected: a fan-out/broadcast from the Terminals view must never type into an agent.
      protected: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Split the merged tasks.md into per-task files once (idempotent). */
  private async ensureTaskFiles(): Promise<void> {
    if (!this.paths) return;
    if (await hasTaskFiles(this.paths.tasksDir)) return;
    const content = await fs.readFile(this.paths.mergedTasksFile, 'utf8').catch(() => null);
    if (content) await splitTasksToFiles(content, this.paths.tasksDir);
  }

  private async refreshTasks(): Promise<void> {
    if (!this.paths) {
      this.tasksSummary = null;
      this.emitState();
      return;
    }
    await this.ensureTaskFiles();
    if (await hasTaskFiles(this.paths.tasksDir)) {
      const records = await listTaskRecords(this.paths.tasksDir);
      this.tasksSummary = summarizeTasks(records);
      await this.recordTaskRecords(records);
    } else {
      const content = await fs.readFile(this.paths.mergedTasksFile, 'utf8').catch(() => null);
      this.tasksSummary = content ? summarizeTasks(parseTasks(content)) : null;
    }
    this.emitState();
  }

  private async writeFinalSummary(stageId: StageId): Promise<void> {
    const paths = this.paths!;
    const runs = this.stages[stageId].runs.filter((r) => r.state === 'completed');
    const parts: string[] = [
      '# Final Code Review Summary',
      '',
      `Generated by the Tiger orchestrator on ${nowIso()}.`,
      '',
      'This file aggregates the individual final code review reports produced in this stage. ' +
        'Refer to each report below for the per-reviewer findings and final decision.',
    ];
    for (const run of runs) {
      const content = await fs.readFile(run.outputPath, 'utf8').catch(() => '(report not found)');
      parts.push('', '---', '', `## Report: ${run.label} (${run.outputRel})`, '', content);
    }
    if (runs.length === 0) parts.push('', '_No completed final code review reports were produced._');
    await fs.writeFile(paths.finalSummaryFile, parts.join('\n'), 'utf8').catch(() => {});
  }

  private async beginPersistentRun(): Promise<string> {
    if (!this.paths || !this.workspace) throw httpError(400, 'initialize a workspace first');
    if (this.activeRunId) {
      // Reusing an existing run: force a fresh refresh so resuming truly extends the lease for the
      // current owner rather than piggybacking on a possibly-unrelated in-flight heartbeat.
      await this.refreshActiveRunLease(true);
      this.startRunLeaseHeartbeat();
      return this.activeRunId;
    }
    const acquired = await this.persistence.acquireRunLease({
      workspace: this.workspace,
      tigerRoot: this.paths.root,
      owner: this.owner,
      ttlMs: this.config.execution.lockTtlMs,
    });
    if (!acquired.ok) {
      throw httpError(
        409,
        `Tiger execution is leased by ${acquired.conflict.leaseOwner}` +
          `${acquired.conflict.leaseExpiresAt ? ` until ${acquired.conflict.leaseExpiresAt}` : ''}`,
      );
    }
    this.activeRunId = acquired.runId;
    this.activeLeaseOwner = acquired.leaseOwner;
    this.activeLeaseExpiresAt = acquired.leaseExpiresAt;
    this.startRunLeaseHeartbeat();
    return acquired.runId;
  }

  private heartbeatIntervalMs(): number {
    const ttlMs = Math.max(1, this.config.execution.lockTtlMs);
    return Math.max(100, Math.min(60_000, Math.floor(ttlMs / 3)));
  }

  private startRunLeaseHeartbeat(): void {
    if (this.runLeaseHeartbeat) return;
    this.runLeaseHeartbeat = setInterval(() => {
      void this.refreshActiveRunLease().catch((err) => {
        // A failed lease refresh means another owner may take over the workspace lease — continuing
        // would risk split-brain double execution. Hard-stop the run: abort in-flight agents and
        // halt auto-advance. The lease will lapse and be reconciled on the next boot.
        const message = err instanceof Error ? err.message : String(err);
        if (this.paths) {
          void logNote(
            this.paths.runLogFile,
            `Execution lease refresh FAILED (${message}); aborting the run to prevent split-brain double execution.`,
          ).catch(() => {});
        }
        this.escalateLeaseFailure(message);
      });
    }, this.heartbeatIntervalMs());
    this.runLeaseHeartbeat.unref();
  }

  /** Hard-stop the active run after a lease heartbeat failure (prevents split-brain). */
  private escalateLeaseFailure(message: string): void {
    this.autoAdvance = false;
    if (this.currentStage) {
      this.stages[this.currentStage].message = `Aborted: execution lease lost (${message}).`;
    }
    this.abort?.abort();
    void this.stopRunLeaseHeartbeat();
    this.emitState();
  }

  private async stopRunLeaseHeartbeat(): Promise<void> {
    if (this.runLeaseHeartbeat) {
      clearInterval(this.runLeaseHeartbeat);
      this.runLeaseHeartbeat = null;
    }
    await this.runLeaseRefresh?.catch(() => undefined);
  }

  /**
   * Renew the active run lease for the current owner.
   *
   * The background heartbeat (`force` omitted) may piggyback on an already in-flight refresh — that
   * is fine for a periodic keep-alive. But a correctness-critical caller (a task/finding claim, or
   * `beginPersistentRun`) MUST NOT piggyback: an in-flight refresh could have been issued before the
   * relevant owner/runId was current, so awaiting it would return without actually extending THIS
   * caller's lease. Such callers pass `force: true` to always issue a fresh refresh that renews for
   * the owner/runId current at call time, guaranteeing a claim truly extends the lease it relies on.
   */
  private async refreshActiveRunLease(force = false): Promise<void> {
    if (!force && this.runLeaseRefresh) {
      await this.runLeaseRefresh;
      return;
    }
    const runId = this.activeRunId;
    if (!runId) return;
    const owner = this.owner;
    const ttlMs = this.config.execution.lockTtlMs;
    const refresh = (async () => {
      await this.persistence.refreshRunLease(runId, owner, ttlMs);
      if (this.activeRunId === runId) {
        this.activeLeaseOwner = ownerKey(owner);
        this.activeLeaseExpiresAt = leaseExpiresAt(ttlMs);
      }
    })();
    // Publish only the periodic refresh as the shared in-flight promise; a forced refresh is private
    // to its caller so the heartbeat never adopts (and later nulls) someone else's critical renewal.
    if (!force) this.runLeaseRefresh = refresh;
    try {
      await refresh;
    } finally {
      if (this.runLeaseRefresh === refresh) this.runLeaseRefresh = null;
    }
  }

  private async finishPersistentRun(runId: string, status: ExecutionRunStatus, message?: string): Promise<void> {
    await this.stopRunLeaseHeartbeat();
    await this.persistence.finishRun(runId, status, message);
    if (this.activeRunId === runId) this.clearActiveRunLease();
  }

  private clearActiveRunLease(): void {
    this.activeRunId = null;
    this.activeLeaseOwner = null;
    this.activeLeaseExpiresAt = null;
  }

  private async recordAgentSnapshot(run: AgentRun): Promise<void> {
    if (!this.workspace) return;
    const runId = run.runId ?? this.activeRunId;
    if (!runId) return;
    run.runId = runId;
    await this.persistence.recordAgentRun({
      workspace: this.workspace,
      runId,
      run,
      owner: this.owner,
      ttlMs: this.config.execution.lockTtlMs,
    });
  }

  private async recordArtifactPath(run: AgentRun, kind: string, absPath: string): Promise<void> {
    if (!this.workspace || !this.paths) return;
    const runId = run.runId ?? this.activeRunId;
    if (!runId) return;
    const stat = await fileArtifact(absPath);
    await this.persistence.recordArtifact({
      workspace: this.workspace,
      runId,
      stageId: run.stage,
      agentRunId: run.id,
      kind,
      absPath,
      relPath: this.paths.rel(absPath),
      checksumSha256: stat.checksumSha256,
      sizeBytes: stat.sizeBytes,
    });
  }

  private async recordTaskRecords(records: TaskRecord[]): Promise<void> {
    if (!this.workspace || records.length === 0) return;
    await this.persistence.recordTasks(records.map((task) => ({ workspace: this.workspace!, task })));
  }

  private async reconcilePersistentState(): Promise<void> {
    if (!this.workspace || !this.paths) return;
    const r = await this.persistence.reconcileOnBoot({
      workspace: this.workspace,
      owner: this.owner,
      ttlMs: this.config.execution.lockTtlMs,
    });
    const changed =
      r.interruptedRuns + r.interruptedStages + r.interruptedAgents + r.reclaimedTasks + r.reclaimedFindings;
    if (changed > 0) {
      await logNote(
        this.paths.runLogFile,
        `Persistence reconciliation: interrupted ${r.interruptedRuns} run(s), ${r.interruptedStages} stage(s), ` +
          `${r.interruptedAgents} agent run(s); reclaimed ${r.reclaimedTasks} task lease(s) and ` +
          `${r.reclaimedFindings} finding lease(s).`,
      ).catch(() => {});
    }
  }

  private async restoreStagesFromPersistence(): Promise<boolean> {
    if (!this.workspace) return false;
    const state = await this.persistence.loadProjectState(this.workspace);
    if (!state) return false;
    this.stages = blankStages();
    for (const stageId of STAGE_ORDER) {
      const persisted = state.stages[stageId];
      if (!persisted) continue;
      this.stages[stageId] = this.stageFromPersistence(persisted);
    }
    return true;
  }

  private stageFromPersistence(record: PersistedStageRecord): StageState {
    const runs = record.runs.map((run) => this.agentFromPersistence(run));
    const interrupted = record.status === 'interrupted';
    return {
      id: record.stageId,
      status: record.status,
      runs,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      message:
        record.message ??
        (interrupted
          ? 'Interrupted by a previous backend shutdown; resume will dispatch incomplete work again.'
          : undefined),
      config: record.config,
    };
  }

  private agentFromPersistence(run: PersistedAgentRunRecord): AgentRun {
    return {
      id: run.id,
      runId: run.runId,
      terminalId: run.terminalId,
      stage: run.stage,
      type: run.type,
      index: run.index,
      label: run.label,
      outputPath: run.outputPath,
      outputRel: run.outputRel,
      markerPath: run.markerPath,
      promptPath: run.promptPath,
      command: run.command,
      state: run.state,
      completion: run.completion,
      exitCode: run.exitCode,
      error: run.error,
      taskId: run.taskId,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      attempts: run.attempts,
    };
  }

  private async quarantineInterruptedOutputs(): Promise<void> {
    if (!this.paths) return;
    for (const stage of Object.values(this.stages)) {
      for (const run of stage.runs) {
        if (run.state !== 'interrupted') continue;
        if (await markerExists(run.markerPath)) continue;
        const exists = await fs
          .stat(run.outputPath)
          .then((s) => s.isFile())
          .catch(() => false);
        if (!exists) continue;
        const quarantineDir = path.join(this.paths.runtimeDir(run.stage), 'quarantine');
        await fs.mkdir(quarantineDir, { recursive: true }).catch(() => {});
        const quarantined = path.join(quarantineDir, `${run.id}-${path.basename(run.outputPath)}.partial`);
        await fs.rename(run.outputPath, quarantined).catch(() => {});
        await this.recordArtifactPath(run, 'quarantine', quarantined);
      }
    }
  }

  /** Fallback/import aid when no durable run state exists yet. */
  private async deriveStagesFromDisk(): Promise<void> {
    if (!this.paths) return;
    for (const stageId of STAGE_ORDER) {
      const has = await this.stageHasOutput(this.paths, stageId);
      this.stages[stageId] = { id: stageId, status: has ? 'completed' : 'not_started', runs: [] };
    }
  }

  private async stageHasOutput(paths: TigerPaths, stageId: StageId): Promise<boolean> {
    const meta = STAGE_META[stageId];
    if (meta.singleAgent) {
      const chk = await checkOutputFile(paths.mergedTasksFile);
      return chk.ok;
    }
    const dir = paths.stageDir(stageId);
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      if (name.endsWith(meta.outputSuffix)) {
        const chk = await checkOutputFile(`${dir}/${name}`);
        if (chk.ok) return true;
      }
    }
    return false;
  }

  /** Summaries of all known project workspaces (for the launcher). Never makes one active. */
  async listProjects(paths: string[]): Promise<ProjectInfo[]> {
    const seen = new Set<string>();
    const out: ProjectInfo[] = [];
    for (const p of paths) {
      if (seen.has(p)) continue;
      seen.add(p);
      const tp = new TigerPaths(p);
      const exists = await fs
        .stat(tp.root)
        .then((s) => s.isDirectory())
        .catch(() => false);
      const prompt = exists ? await fs.readFile(tp.projectPromptFile, 'utf8').catch(() => '') : '';
      let completed = 0;
      if (prompt.trim()) {
        for (const s of STAGE_ORDER) if (await this.stageHasOutput(tp, s)) completed++;
      }
      const updatedAt = await fs
        .stat(tp.runLogFile)
        .then((s) => s.mtime.toISOString())
        .catch(() => undefined);
      out.push({
        path: p,
        tigerRoot: tp.root,
        name: path.basename(p) || p,
        promptPreview: prompt.slice(0, 220),
        initialized: prompt.trim().length > 0,
        exists,
        completedStages: completed,
        totalStages: STAGE_ORDER.length,
        active: this.workspace === p,
        updatedAt,
      });
    }
    out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return out;
  }

  /** Close the active project and return to the launcher (no-op if none open). */
  async closeProject(): Promise<void> {
    if (this.busy) throw httpError(409, 'a stage is currently running');
    await this.removeTerminalsBestEffort(this.agentTerminalTargets(), 'project close');
    this.workspace = null;
    this.paths = null;
    this.initialized = false;
    this.projectPrompt = '';
    this.currentStage = null;
    this.correctionCycles = 0;
    this.autoAdvance = false;
    this.stages = blankStages();
    this.tasksSummary = null;
    this.findingsSummary = null;
    await this.stopRunLeaseHeartbeat();
    this.clearActiveRunLease();
    this.emitState();
  }

  /** Read an artifact file from within the tiger root (path-guarded), for the UI. */
  async readArtifact(rel: string): Promise<{ path: string; content: string }> {
    if (!this.paths) throw httpError(400, 'no workspace selected');
    if (typeof rel !== 'string' || !rel.trim()) throw httpError(400, 'path required');
    const clean = rel.trim().replace(/\\/g, '/');
    if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean)) throw httpError(400, 'absolute path not allowed');
    if (clean.split('/').some((s) => s === '' || s === '.' || s === '..')) throw httpError(400, 'invalid path segment');
    const abs = path.resolve(this.paths.root, clean);
    const relCheck = path.relative(this.paths.root, abs);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) throw httpError(400, 'path is outside the tiger root');
    const st = await fs.stat(abs).catch(() => {
      throw httpError(404, 'file not found');
    });
    if (!st.isFile()) throw httpError(400, 'not a file');
    if (st.size > 4 * 1024 * 1024) throw httpError(413, 'file too large');
    return { path: clean, content: await fs.readFile(abs, 'utf8') };
  }

  /** Kill any live agent terminals (called on shutdown). */
  async killAgents(): Promise<void> {
    await this.removeTerminalsBestEffort(this.agentTerminalTargets(), 'agent shutdown');
  }
}

function blankStages(): Record<StageId, StageState> {
  const out = {} as Record<StageId, StageState>;
  for (const s of STAGE_ORDER) out[s] = { id: s, status: 'not_started', runs: [] };
  return out;
}

function clampCount(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 0;
  return Math.max(0, Math.min(8, v));
}

interface HttpError extends Error {
  status: number;
}
function httpError(status: number, message: string): HttpError {
  const e = new Error(message) as HttpError;
  e.status = status;
  return e;
}
