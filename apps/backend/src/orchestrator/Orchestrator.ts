import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { TerminalManager } from '../terminal/TerminalManager.js';
import { STAGE_META, TigerPaths, agentLabel } from './paths.js';
import { STAGE_ORDER } from './types.js';
import type {
  AgentRun,
  AgentType,
  OrchestratorState,
  ProjectInfo,
  ReviewStatus,
  StageId,
  StageRunConfig,
  StageState,
  StageStatus,
  TigerConfig,
} from './types.js';
import { defaultTigerConfig, loadConfig, normalizeConfig, saveConfig } from './config.js';
import { ensureScaffold } from './scaffold.js';
import { buildLaunchCommand } from './launch-command.js';
import { AgentSession } from './AgentSession.js';
import { composePrompt, type ComposeOptions } from './compose.js';
import { checkOutputFile } from './validate.js';
import { logAgentResult, logNote, logStageEnd, logStageStart } from './runlog.js';
import {
  claimNextTaskFile,
  finishTaskFile,
  hasTaskFiles,
  listTaskRecords,
  parseExecutionResult,
  parseTasks,
  reviewTaskFile,
  splitTasksToFiles,
  summarizeTasks,
} from './tasks.js';
import {
  claimNextFinding,
  finishFinding,
  hasFindings,
  listFindings,
  parseFixResult,
  readFindingBlock,
  splitFindingsToFiles,
  summarizeFindings,
  type FindingsSummary,
} from './findings.js';

const nowIso = (): string => new Date().toISOString();

/** Run items through `worker` with bounded concurrency. */
async function runPool<T>(items: T[], limit: number, worker: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: n }, runner));
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

  constructor(private readonly manager: TerminalManager) {
    super();
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
    await this.deriveStagesFromDisk();
    await this.refreshTasks();
    this.emitState();
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

  async updateConfig(partial: unknown): Promise<TigerConfig> {
    if (!this.paths) throw httpError(400, 'no workspace selected');
    const merged = normalizeConfig({ ...this.config, ...(partial && typeof partial === 'object' ? partial : {}) });
    this.config = merged;
    await saveConfig(this.paths.configFile, merged);
    return merged;
  }

  // --- stage control ---

  /**
   * Validate + kick off a stage (non-blocking). Progress arrives via 'state' events.
   * When `auto` is true, the workflow auto-advances to the next stage on success.
   */
  startStage(stageId: StageId, cfg: StageRunConfig, auto = false): void {
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

    void this.executeStage(stageId, cfg)
      .catch((err) => {
        stage.status = 'failed';
        stage.message = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.busy = false;
        this.abort = null;
        stage.endedAt = nowIso();
        this.emitState();
        this.maybeAutoAdvance(stageId);
      });
  }

  /** Configure-all-then-run: auto-advance from `fromStage` using a per-stage config map. */
  startAll(configs: Partial<Record<StageId, StageRunConfig>>, fromStage?: StageId): void {
    if (!this.paths || !this.initialized) throw httpError(400, 'initialize a workspace first');
    if (this.busy) throw httpError(409, 'a stage is already running');
    this.autoConfigs = configs;
    const start =
      fromStage && STAGE_ORDER.includes(fromStage) ? fromStage : this.firstIncompleteStage();
    this.startStage(start, configs[start] ?? this.defaultStageConfig(start), true);
  }

  private firstIncompleteStage(): StageId {
    return STAGE_ORDER.find((s) => this.stages[s].status !== 'completed') ?? 'brainstorming';
  }

  /** After a stage finishes: if auto-advancing and it succeeded, start the next stage. */
  private maybeAutoAdvance(stageId: StageId): void {
    if (!this.autoAdvance) return;
    const stage = this.stages[stageId];
    if (stage.status !== 'completed') {
      this.autoAdvance = false; // stop the chain on failure/stop
      void logNote(this.paths!.runLogFile, `Auto-advance stopped at stage ${stageId} (status: ${stage.status}).`);
      this.emitState();
      return;
    }
    const idx = STAGE_ORDER.indexOf(stageId);
    const next = STAGE_ORDER[idx + 1];
    if (!next) {
      this.autoAdvance = false; // reached the final stage
      this.emitState();
      return;
    }
    void logNote(this.paths!.runLogFile, `Auto-advancing from ${stageId} to ${next}.`);
    try {
      this.startStage(next, this.autoConfigs[next] ?? this.defaultStageConfig(next), true);
    } catch (err) {
      this.autoAdvance = false;
      this.stages[next].message = `Auto-advance failed to start: ${err instanceof Error ? err.message : String(err)}`;
      this.emitState();
    }
  }

  /** Build a stage run configuration from the saved defaults (used during auto-advance). */
  private defaultStageConfig(_stageId: StageId): StageRunConfig {
    const d = this.config.defaults;
    return {
      claudeAgents: d.claudeAgents,
      codexAgents: d.codexAgents,
      claudeModel: d.claudeModel,
      codexModel: d.codexModel,
      claudeEffort: d.claudeEffort,
      codexEffort: d.codexEffort,
      claudePermission: d.claudePermission,
      codexPermission: d.codexPermission,
      parallel: d.parallel,
      mergeAgent: 'claude',
    };
  }

  /** Re-run only the failed agents of a stage. */
  retryStage(stageId: StageId): void {
    if (!this.paths || !this.initialized) throw httpError(400, 'initialize a workspace first');
    if (this.busy) throw httpError(409, 'a stage is already running');
    const stage = this.stages[stageId];
    const failed = stage.runs.filter((r) => r.state === 'failed' || r.state === 'stopped');
    if (failed.length === 0) throw httpError(400, 'no failed agents to retry');

    this.autoAdvance = false; // a manual retry never auto-advances
    this.busy = true;
    this.currentStage = stageId;
    this.abort = new AbortController();
    stage.status = 'running';
    this.emitState();

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
      .finally(() => {
        this.busy = false;
        this.abort = null;
        stage.endedAt = nowIso();
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
    );
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
    );
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
    await fs.mkdir(paths.runtimeDir(stageId), { recursive: true }).catch(() => {});
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
    }
    stage.runs = runs;
    runs.forEach((r) => this.registerRun(r));
    this.emitState();

    if (runs.length === 0) {
      stage.message = 'No agents were configured for this stage.';
      return;
    }
    await runPool(runs, this.concurrency(stageId, runs.length, cfg.parallel), async (run) => {
      if (signal.aborted) return;
      await this.executeAgentRun(run, await this.composeExtrasFor(run), signal);
    });
  }

  /** Stage 5: split tasks into per-task files, then claim/implement them one task per agent run. */
  private async executeExecutionStage(cfg: StageRunConfig, signal: AbortSignal): Promise<void> {
    const paths = this.paths!;
    const stage = this.stages['executing-plan'];
    await this.ensureTaskFiles();
    if (!(await hasTaskFiles(paths.tasksDir))) {
      stage.message = 'No merged task file found. Run the Merge Tasks stage first.';
      stage.runs = [];
      return;
    }
    const all = await listTaskRecords(paths.tasksDir);
    if (all.length === 0) {
      stage.message = 'The merged task file contains no tasks.';
      return;
    }
    if (!all.some((t) => t.executionStatus === 'not_started')) {
      stage.message = 'No tasks are in not_started state; nothing to execute.';
      return;
    }

    // Worker type slots. Parallel: one concurrent worker per configured agent. Sequential: a
    // single worker that round-robins types so both claude and codex are still used.
    const types: AgentType[] = [];
    for (let i = 0; i < clampCount(cfg.claudeAgents); i++) types.push('claude');
    for (let i = 0; i < clampCount(cfg.codexAgents); i++) types.push('codex');
    if (types.length === 0) {
      stage.message = 'No agents were configured for this stage.';
      return;
    }

    let counter = 0;
    // Claim + implement exactly one task with the given agent type. The claim is an atomic file
    // rename (not_started -> in_progress); the filename is the lock. Returns false when none remain.
    // `++counter` is synchronous (runs before the first await), so concurrent workers always get a
    // UNIQUE index — and therefore a unique label and output-log file. A worker that claims nothing
    // (queue drained) simply never creates a run, so extra agents beyond the task count never start.
    const processTask = async (type: AgentType): Promise<boolean> => {
      const index = ++counter;
      const claimed = await claimNextTaskFile(paths.tasksDir, agentLabel(type, index), nowIso());
      if (!claimed) return false;
      const run = this.makeRun('executing-plan', type, index, cfg, claimed.record.id);
      stage.runs.push(run);
      this.registerRun(run);
      void logNote(paths.runLogFile, `${run.label} claimed ${claimed.record.id} (atomic rename to in_progress).`);
      this.emitState();

      await this.executeAgentRun(run, { taskId: claimed.record.id, taskBlock: claimed.block }, signal);

      // Resolve final task status from the agent's self-report, falling back to the run state.
      let finalStatus: 'done' | 'blocked' = run.state === 'completed' ? 'done' : 'blocked';
      const reported = await fs
        .readFile(run.outputPath, 'utf8')
        .then((t) => parseExecutionResult(t))
        .catch(() => null);
      if (reported && run.state === 'completed') finalStatus = reported.status;
      await finishTaskFile(paths.tasksDir, claimed.record.id, finalStatus, nowIso());
      await this.refreshTasks();
      return true;
    };

    if (cfg.parallel) {
      const worker = async (type: AgentType): Promise<void> => {
        while (!signal.aborted && (await processTask(type))) {
          /* keep draining the shared queue */
        }
      };
      await Promise.all(types.map(worker));
    } else {
      let ti = 0;
      while (!signal.aborted) {
        const did = await processTask(types[ti % types.length]!);
        if (!did) break;
        ti++;
      }
    }
    await this.refreshTasks();
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
    for (let i = 1; i <= clampCount(cfg.claudeAgents); i++) findRuns.push(this.makeRun('task-review', 'claude', i, cfg));
    for (let i = 1; i <= clampCount(cfg.codexAgents); i++) findRuns.push(this.makeRun('task-review', 'codex', i, cfg));
    stage.runs = findRuns;
    findRuns.forEach((r) => this.registerRun(r));
    this.emitState();
    if (findRuns.length === 0) {
      stage.message = 'No agents were configured for this stage.';
      return;
    }

    const partitions = new Map<string, string[]>();
    findRuns.forEach((r) => partitions.set(r.id, []));
    done.forEach((t, i) => partitions.get(findRuns[i % findRuns.length]!.id)!.push(t.id));
    for (const t of done) await reviewTaskFile(paths.tasksDir, t.id, 'reviewing');
    await this.refreshTasks();

    await runPool(findRuns, this.concurrency('task-review', findRuns.length, cfg.parallel), async (run) => {
      if (signal.aborted) return;
      await this.executeAgentRun(run, { reviewTaskIds: partitions.get(run.id) ?? [], reviewPhase: 'find' }, signal);
    });

    // Collect findings from the review logs into a per-finding work queue.
    const logs = await Promise.all(
      findRuns.map(async (r) => ({ label: r.label, content: await fs.readFile(r.outputPath, 'utf8').catch(() => '') })),
    );
    const found = await splitFindingsToFiles(logs, paths.findingsDir);
    await logNote(paths.runLogFile, `Task review reported ${found.length} finding(s).`);
    await this.refreshFindings();

    // --- Phase 2: FIX (only if there are findings; clean review skips this entirely) ---
    if (!signal.aborted && (await hasFindings(paths.findingsDir))) {
      const types: AgentType[] = [];
      for (let i = 0; i < clampCount(cfg.claudeAgents); i++) types.push('claude');
      for (let i = 0; i < clampCount(cfg.codexAgents); i++) types.push('codex');
      let counter = findRuns.length; // keep run labels/output files unique within this stage
      const processFinding = async (type: AgentType): Promise<boolean> => {
        const claimed = await claimNextFinding(paths.findingsDir);
        if (!claimed) return false;
        const index = ++counter;
        const run = this.makeRun('task-review', type, index, cfg, claimed.id);
        stage.runs.push(run);
        this.registerRun(run);
        void logNote(paths.runLogFile, `${run.label} claimed ${claimed.id} to fix.`);
        this.emitState();
        await this.executeAgentRun(run, { reviewPhase: 'fix', findingId: claimed.id, findingBlock: claimed.block }, signal);
        const reported =
          run.state === 'completed' ? parseFixResult(await fs.readFile(run.outputPath, 'utf8').catch(() => '')) : null;
        await finishFinding(paths.findingsDir, claimed.id, reported?.status === 'fixed' ? 'fixed' : 'wontfix');
        await this.refreshFindings();
        return true;
      };
      if (cfg.parallel) {
        const worker = async (type: AgentType): Promise<void> => {
          while (!signal.aborted && (await processFinding(type))) {
            /* drain the finding queue */
          }
        };
        await Promise.all(types.map(worker));
      } else {
        let ti = 0;
        while (!signal.aborted) {
          const did = await processFinding(types[ti % types.length]!);
          if (!did) break;
          ti++;
        }
      }
    }

    // Roll findings up into each task's review status.
    const finalFindings = await listFindings(paths.findingsDir);
    for (const t of done) {
      const own = finalFindings.filter((f) => f.relatedTask === t.id);
      const rs: ReviewStatus =
        own.length === 0 ? 'approved' : own.every((f) => f.status === 'fixed') ? 'fixed' : 'needs_fix';
      await reviewTaskFile(paths.tasksDir, t.id, rs);
    }
    await this.refreshTasks();
    await this.refreshFindings();
  }

  private async refreshFindings(): Promise<void> {
    if (!this.paths) {
      this.findingsSummary = null;
      return;
    }
    this.findingsSummary = (await hasFindings(this.paths.findingsDir))
      ? summarizeFindings(await listFindings(this.paths.findingsDir))
      : null;
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
    this.emitState();

    await fs.mkdir(paths.runtimeDir(run.stage), { recursive: true }).catch(() => {});
    const promptText = await composePrompt({
      paths,
      stage: run.stage,
      label: run.label,
      outputPath: run.outputPath,
      markerPath: run.markerPath,
      taskId: run.taskId,
      ...extras,
      warning: this.upstreamContinuedWarning(run.stage),
    });
    await fs.writeFile(run.promptPath, promptText, 'utf8');
    // Clear any stale marker so detection reflects this run only.
    await fs.rm(run.markerPath, { force: true }).catch(() => {});

    const session = new AgentSession({
      manager: this.manager,
      termId: run.terminalId,
      label: run.label,
      command: run.command,
      cwd: paths.root,
      promptPath: run.promptPath,
      outputPath: run.outputPath,
      markerPath: run.markerPath,
      timing: this.config.timing,
      onState: (s) => {
        run.state = s;
        this.emitState();
      },
    });

    const result = await session.run(signal);
    run.state = result.state;
    run.completion = result.completion;
    run.exitCode = result.exitCode ?? null;
    run.error = result.error;
    run.endedAt = nowIso();
    await logAgentResult(paths.runLogFile, run);
    this.emitState();
  }

  // --- helpers ---

  private makeRun(
    stage: StageId,
    type: AgentType,
    index: number,
    cfg: StageRunConfig,
    taskId?: string,
  ): AgentRun {
    const id = nanoid();
    const outputPath = this.paths!.outputFile(stage, type, index);
    const model = type === 'claude' ? cfg.claudeModel : cfg.codexModel;
    const effort = type === 'claude' ? cfg.claudeEffort : cfg.codexEffort;
    const permission = type === 'claude' ? cfg.claudePermission : cfg.codexPermission;
    return {
      id,
      terminalId: id,
      stage,
      type,
      index,
      label: agentLabel(type, index),
      outputPath,
      outputRel: this.paths!.rel(outputPath),
      markerPath: this.paths!.markerFile(stage, id),
      promptPath: this.paths!.promptFileFor(stage, id),
      command: buildLaunchCommand(this.config, type, { model, effort, permission }),
      state: 'pending',
      attempts: 0,
      taskId,
    };
  }

  private concurrency(_stageId: StageId, count: number, parallel = true): number {
    // No imposed cap — the user chooses the agent counts; in parallel mode run them all at once.
    return parallel ? Math.max(1, count) : 1;
  }

  private finalizeStage(stageId: StageId): void {
    const stage = this.stages[stageId];
    const total = stage.runs.length;
    const succeeded = stage.runs.filter((r) => r.state === 'completed').length;
    const stopped = stage.runs.some((r) => r.state === 'stopped') || this.abort?.signal.aborted;
    let status: StageStatus;
    if (total === 0) status = stage.status === 'running' ? 'completed' : stage.status;
    else if (succeeded === total) status = 'completed';
    else if (stopped) status = 'stopped';
    else status = 'failed';
    stage.status = status;
    if (!stage.message) {
      stage.message =
        total === 0 ? stage.message : `${succeeded}/${total} agent(s) completed successfully.`;
    }
    void logStageEnd(this.paths!.runLogFile, stageId, status, succeeded, total);
    this.emitState();
  }

  private async cleanupStageTerminals(stage: StageState): Promise<void> {
    await Promise.allSettled(stage.runs.map((r) => this.manager.remove(r.terminalId)));
  }

  /** Register the ephemeral agent terminal so the live UI tile can attach immediately. */
  private registerRun(run: AgentRun): void {
    const now = nowIso();
    this.manager.upsertDefinition({
      id: run.terminalId,
      name: run.label,
      groupId: null,
      cwd: this.paths!.root,
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
      this.tasksSummary = summarizeTasks(await listTaskRecords(this.paths.tasksDir));
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

  /** On (re)load, infer stage completion from on-disk outputs so progress survives restarts. */
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
  closeProject(): void {
    if (this.busy) throw httpError(409, 'a stage is currently running');
    this.workspace = null;
    this.paths = null;
    this.initialized = false;
    this.projectPrompt = '';
    this.currentStage = null;
    this.correctionCycles = 0;
    this.autoAdvance = false;
    this.stages = blankStages();
    this.tasksSummary = null;
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
    const ids = STAGE_ORDER.flatMap((s) => this.stages[s].runs.map((r) => r.terminalId));
    await Promise.allSettled(ids.map((id) => this.manager.remove(id)));
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
