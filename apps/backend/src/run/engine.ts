import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { randomUUID } from 'node:crypto';
import type { TigerConfig } from '../orchestrator/types.js';
import { defaultTigerConfig } from '../orchestrator/config.js';
import { logger } from '../obs/logger.js';
import { getDriver } from '../agents/providers/registry.js';
import { runAgentTurn, type AgentTurnReport, type RunAgentTurnOptions } from '../agents/runner.js';
import { SessionRegistry } from '../agents/session.js';
import { TURN_RESULT_JSON_SCHEMA } from '../agents/result.js';
import type { AgentEvent } from '../agents/events.js';
import { composeSessionPreamble, composeTaskBrief } from '../context/brief.js';
import { buildProjectMap } from '../context/project-map.js';
import { computeTeamChanges } from '../git/changes.js';
import {
  VerificationService,
  discoverVerificationCommands,
  type VerificationCommand,
  type VerificationRecord,
} from '../verify/service.js';
import { PLAN_RESULT_JSON_SCHEMA, parsePlanResult } from './plan.js';
import { isDrained, nextItemId, propagateDoom, selectRunnable, summarizeGraph, type WorkItem } from './graph.js';
import {
  toRunSnapshot,
  type RunConfig,
  type RunEvent,
  type RunSnapshot,
  type RunState,
  type RunStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// RunEngine — the v2 orchestrator (docs/REDESIGN.md §4.2, §5).
//
// Control flow lives here, in code: seed a plan item → planner turn produces
// the task graph (schema-enforced) → build turns execute tasks in resumed
// sessions with delta briefs → the engine runs verification itself → red
// checks retry the SAME session with the failing tail as evidence → an
// optional review turn reads the real diff → done when the graph is drained
// and the final checks are green. No role chat, no sign-off ceremony, no
// marker files, no idle heuristics.
//
// v2.0 executes builds SEQUENTIALLY in the shared workspace (the evidence in
// REDESIGN.md §3: coding rarely parallelizes well). `maxParallelBuilds` is
// plumbed for the worktree-isolated fan-out, but the engine clamps it to 1
// until the merge-back flow lands.
// ---------------------------------------------------------------------------

export interface RunEngineOptions {
  /** Injectable for tests; defaults to the real headless runner. */
  turnRunner?: (opts: RunAgentTurnOptions) => Promise<AgentTurnReport>;
  verification?: VerificationService;
  /** CLI tool configs (executables/flags); defaults to the built-in defaults. */
  loadCliConfig?: (workspace: string) => Promise<TigerConfig>;
}

export interface CreateRunInput {
  workspace: string;
  goal: string;
  config?: Partial<RunConfig>;
}

export type RunEngineEvent = { kind: 'event'; event: RunEvent } | { kind: 'state'; state: RunSnapshot };

const DEFAULT_CONFIG: RunConfig = {
  profile: 'mission',
  builder: { provider: 'claude' },
  maxParallelBuilds: 1,
  maxAttemptsPerItem: 2,
  hardTurnTimeoutMs: 45 * 60_000,
  reviewPolicy: 'final',
  verifyPolicy: 'both',
  verifyCommands: [],
  maxFixRounds: 3,
  allowDangerous: false,
  mcp: false,
};

const nowIso = (): string => new Date().toISOString();

export class RunEngine extends EventEmitter {
  private state: RunState | null = null;
  private sessions: SessionRegistry | null = null;
  private loop: Promise<void> | null = null;
  private abort: AbortController | null = null;
  /** Rendered one-line summaries of recent events (delta briefs read from here). */
  private deltaLog: Array<{ seq: number; line: string }> = [];
  private readonly turnRunner: (opts: RunAgentTurnOptions) => Promise<AgentTurnReport>;
  private readonly verification: VerificationService;
  private readonly loadCliConfig: (workspace: string) => Promise<TigerConfig>;
  private cliConfig: TigerConfig | null = null;
  private projectMap = '';

  constructor(options: RunEngineOptions = {}) {
    super();
    this.turnRunner = options.turnRunner ?? runAgentTurn;
    this.verification = options.verification ?? new VerificationService();
    this.loadCliConfig = options.loadCliConfig ?? (async () => defaultTigerConfig());
  }

  // --- lifecycle -------------------------------------------------------------

  async createRun(input: CreateRunInput): Promise<RunSnapshot> {
    if (this.state && (this.state.status === 'running' || this.state.status === 'created')) {
      throw new Error('a run is already active; stop it before creating a new one');
    }
    const runId = `run-${nanoid(10)}`;
    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      ...input.config,
      builder: { ...DEFAULT_CONFIG.builder, ...input.config?.builder },
    };
    // Sequential-build clamp until worktree merge-back lands (see header note).
    if (config.maxParallelBuilds !== 1) config.maxParallelBuilds = 1;
    this.state = {
      runId,
      workspace: path.resolve(input.workspace),
      goal: input.goal,
      status: 'created',
      config,
      createdAt: nowIso(),
      graph: { items: [] },
      seq: 0,
      usage: { turns: 0 },
      verifications: [],
      steering: [],
      fixRounds: 0,
    };
    this.sessions = new SessionRegistry(path.join(this.runDir(), 'sessions.json'));
    await this.sessions.load();
    await this.persist();
    return toRunSnapshot(this.state);
  }

  start(): RunSnapshot {
    const state = this.requireState();
    if (state.status === 'running') return toRunSnapshot(state);
    if (state.status !== 'created' && state.status !== 'blocked' && state.status !== 'stopped') {
      throw new Error(`run is ${state.status}; create a new run instead`);
    }
    state.status = 'running';
    state.startedAt ??= nowIso();
    state.endedAt = undefined;
    state.message = undefined;
    this.abort = new AbortController();
    this.emitStatus();
    if (!this.loop) {
      const signal = this.abort.signal;
      this.loop = this.runLoop(signal)
        .catch((err) => this.finish('failed', `engine error: ${String(err instanceof Error ? err.message : err)}`))
        .finally(() => {
          this.loop = null;
        });
    }
    return toRunSnapshot(state);
  }

  async stop(reason = 'Stopped by user.'): Promise<RunSnapshot> {
    const state = this.requireState();
    this.abort?.abort();
    if (state.status === 'running' || state.status === 'created') {
      await this.finish('stopped', reason);
    }
    if (this.loop) await this.loop.catch(() => {});
    return toRunSnapshot(this.requireState());
  }

  async steer(body: string): Promise<RunSnapshot> {
    const state = this.requireState();
    const directive = { id: nanoid(8), body: body.trim(), createdAt: nowIso(), status: 'pending' as const };
    state.steering.push(directive);
    await this.record({ type: 'steering', text: directive.body });
    // A stopped/blocked run resumes to process the steering.
    if (state.status === 'blocked' || state.status === 'stopped') this.start();
    this.emitStatus();
    return toRunSnapshot(state);
  }

  getSnapshot(): RunSnapshot | null {
    return this.state ? toRunSnapshot(this.state) : null;
  }

  async listEvents(afterSeq = 0): Promise<RunEvent[]> {
    const state = this.requireState();
    const file = this.eventsFile();
    const raw = await fs.readFile(file, 'utf8').catch(() => '');
    const events: RunEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as RunEvent;
        if (event.runId === state.runId && event.seq > afterSeq) events.push(event);
      } catch {
        /* skip corrupt line */
      }
    }
    return events;
  }

  // --- main loop ---------------------------------------------------------------

  private async runLoop(signal: AbortSignal): Promise<void> {
    const state = this.requireState();
    this.cliConfig = await this.loadCliConfig(state.workspace);
    if (!this.projectMap) {
      this.projectMap = await buildProjectMap(state.workspace).catch(() => '');
    }

    let noProgress = 0;
    while (!signal.aborted && this.state?.status === 'running') {
      const current = this.requireState();

      // 1. Steering pending → insert a re-plan item at this boundary (code, not a Lead turn).
      const pendingSteering = current.steering.filter((entry) => entry.status === 'pending');
      const hasPlanScheduled = current.graph.items.some(
        (item) => item.kind === 'plan' && (item.status === 'pending' || item.status === 'running'),
      );
      if (pendingSteering.length > 0 && !hasPlanScheduled) {
        this.insertPlanItem('Re-plan for user steering');
      } else if (current.graph.items.length === 0) {
        // 2. Fresh run → seed the initial plan item.
        this.insertPlanItem('Plan the work');
      }

      // 3. Doom propagation (blocked deps cascade), then pick what can run now.
      for (const doomed of propagateDoom(current.graph)) {
        await this.record({ type: 'item-status', itemId: doomed.id, itemStatus: doomed.status, text: doomed.error });
      }
      const runnable = selectRunnable(current.graph, { maxParallelBuilds: current.config.maxParallelBuilds });

      if (runnable.length === 0) {
        if (isDrained(current.graph)) {
          const finished = await this.finalize(signal);
          if (finished) return;
          noProgress = 0;
          continue; // finalize appended work (fix/review) → keep looping
        }
        // Nothing runnable but not drained should resolve via doom propagation
        // on the next pass; a hard guard prevents any unforeseen hot loop.
        noProgress += 1;
        if (noProgress >= 3) {
          await this.finish('failed', 'scheduler made no progress with a non-drained graph (engine bug guard)');
          return;
        }
        continue;
      }
      noProgress = 0;

      // 4. Execute (sequentially with maxParallelBuilds=1; Promise.all keeps the
      //    shape ready for isolated fan-out).
      await Promise.all(runnable.map((item) => this.executeItem(item, signal)));
      await this.persist();
    }

    if (this.state?.status === 'running') await this.finish('stopped', 'Run loop exited.');
  }

  /** Drained graph: final checks → fix loop → final review → completed/blocked. */
  private async finalize(signal: AbortSignal): Promise<boolean> {
    const state = this.requireState();
    const summary = summarizeGraph(state.graph);
    const hadBuilds = state.graph.items.some((item) => item.kind === 'build' && item.status === 'done');

    // Final verification (policy final/both) — the only truth about "green".
    if ((state.config.verifyPolicy === 'final' || state.config.verifyPolicy === 'both') && hadBuilds) {
      const records = await this.runChecks(signal);
      const failed = records.find((record) => record.outcome !== 'passed');
      if (failed) {
        if (state.fixRounds >= state.config.maxFixRounds) {
          await this.finish(
            'blocked',
            `final checks still failing after ${state.fixRounds} fix rounds (${failed.id}).`,
          );
          return true;
        }
        state.fixRounds += 1;
        this.appendFixItem(failed, 'final verification');
        await this.record({
          type: 'note',
          text: `Final check ${failed.id} failed — fix round ${state.fixRounds} queued.`,
        });
        return false;
      }
    }

    // Run-level review once, when configured and there is something to review.
    if (state.config.reviewPolicy === 'final' && hadBuilds && !state.reviewDone) {
      const reviewId = nextItemId(state.graph, 'R');
      state.graph.items.push({
        id: reviewId,
        kind: 'review',
        title: 'Review the full diff against the goal',
        description:
          'Review the complete working-tree diff produced by this run against the goal and each task’s acceptance criteria. ' +
          'Approve only what is genuinely correct; report concrete fix tasks for anything that is not.',
        dependsOn: [],
        status: 'pending',
        agentKey: 'reviewer',
        attempts: 0,
        createdAt: nowIso(),
      });
      await this.record({ type: 'item-status', itemId: reviewId, itemStatus: 'pending', text: 'Final review queued.' });
      return false;
    }

    if (summary.blocked > 0) {
      await this.finish('blocked', `${summary.blocked} item(s) blocked; ${summary.done}/${summary.total} done.`);
      return true;
    }
    await this.finish('completed', `All ${summary.done} item(s) done; checks green.`);
    return true;
  }

  // --- item execution -------------------------------------------------------

  private async executeItem(item: WorkItem, signal: AbortSignal): Promise<void> {
    const state = this.requireState();
    item.status = 'running';
    item.attempts += 1;
    item.startedAt = nowIso();
    await this.record({ type: 'item-status', itemId: item.id, itemStatus: 'running' });
    this.emitStatus();

    // Review briefs carry the REAL diff — composed just-in-time so the
    // reviewer sees the tree as it stands when its turn starts.
    if (item.kind === 'review') {
      this.descriptionOverrides.set(item.id, await this.itemDescriptionForReview(item));
    }

    const report = await this.runTurn(item, signal);
    this.descriptionOverrides.delete(item.id);

    // Usage accounting (provider-reported, per REDESIGN §3 principle 8).
    if (report.usage) {
      item.usage = { ...item.usage, ...report.usage };
      state.usage.turns += 1;
      state.usage.inputTokens = (state.usage.inputTokens ?? 0) + (report.usage.inputTokens ?? 0);
      state.usage.cachedInputTokens = (state.usage.cachedInputTokens ?? 0) + (report.usage.cachedInputTokens ?? 0);
      state.usage.outputTokens = (state.usage.outputTokens ?? 0) + (report.usage.outputTokens ?? 0);
      state.usage.costUsd = round4((state.usage.costUsd ?? 0) + (report.usage.costUsd ?? 0));
    } else {
      state.usage.turns += 1;
    }

    if (report.state === 'stopped') {
      item.status = 'pending'; // re-runnable on resume
      item.attempts -= 1;
      await this.record({
        type: 'item-status',
        itemId: item.id,
        itemStatus: 'pending',
        text: 'Turn stopped; item re-queued.',
      });
      return;
    }

    if (report.state === 'failed') {
      await this.handleItemFailure(item, report.error ?? 'agent turn failed');
      return;
    }

    if (item.kind === 'plan') {
      await this.applyPlanResult(item, report);
      return;
    }
    if (item.kind === 'review') {
      await this.applyReviewResult(item, report);
      return;
    }
    await this.applyBuildResult(item, report, signal);
  }

  private async runTurn(item: WorkItem, signal: AbortSignal): Promise<AgentTurnReport> {
    const state = this.requireState();
    const cli = this.cliConfig ?? defaultTigerConfig();
    const agent = this.agentConfigFor(item);
    const driver = getDriver(agent.provider);
    const sessions = this.requireSessions();
    const sessionKey = `${state.runId}:${item.agentKey}`;
    const stored = sessions.get(sessionKey);
    const canResume = driver.supportsResume && stored?.sessionId !== undefined;

    // Brief composition: preamble once per session; delta-only follow-ups.
    const brief = composeTaskBrief({
      title: `${item.id} — ${item.title}`,
      description: this.itemDescription(item),
      acceptanceCriteria: item.acceptanceCriteria,
      deltaLines: canResume ? this.deltaLinesSince(stored?.lastSeq ?? 0) : undefined,
      steering: this.drainSteeringTexts(item),
      verificationFailure: this.pendingFailureFor(item),
      recap: !canResume && (stored?.turns ?? 0) > 0 ? this.composeRecap() : undefined,
    });
    const prompt = canResume
      ? brief
      : `${composeSessionPreamble({
          runId: state.runId,
          agentName: item.agentKey,
          goal: state.goal,
          workspace: state.workspace,
          projectMap: this.projectMap,
        })}\n${brief}`;

    const newSessionId = !canResume && driver.id === 'claude' ? randomUUID() : undefined;
    const report = await this.turnRunner({
      driver,
      tool: cli.cli[agent.provider],
      request: {
        prompt,
        model: agent.model,
        effort: agent.effort,
        permission: agent.permission ?? this.defaultPermission(agent.provider, item),
        allowDangerous: state.config.allowDangerous,
        resumeSessionId: canResume ? stored?.sessionId : undefined,
        newSessionId,
        resultSchema: item.kind === 'plan' ? PLAN_RESULT_JSON_SCHEMA : TURN_RESULT_JSON_SCHEMA,
        scratchDir: path.join(this.runDir(), 'scratch', item.id),
      },
      cwd: state.workspace,
      hardTimeoutMs: state.config.hardTurnTimeoutMs,
      signal,
      onEvent: (event) => void this.onAgentEvent(item, event),
    });

    await sessions.upsert(sessionKey, agent.provider, {
      sessionId: report.sessionId ?? newSessionId ?? stored?.sessionId,
      lastSeq: state.seq,
      turnServed: true,
    });
    return report;
  }

  private async applyPlanResult(item: WorkItem, report: AgentTurnReport): Promise<void> {
    const state = this.requireState();
    const plan = parsePlanResult(report.resultText);
    if (!plan || plan.status === 'blocked') {
      await this.handleItemFailure(item, plan?.summary ?? 'planner returned no parseable plan');
      return;
    }

    for (const cancelId of plan.cancelTaskIds ?? []) {
      const target = state.graph.items.find((entry) => entry.id === cancelId && entry.status === 'pending');
      if (target) {
        target.status = 'cancelled';
        target.error = 'cancelled by re-plan';
        target.endedAt = nowIso();
        await this.record({
          type: 'item-status',
          itemId: target.id,
          itemStatus: 'cancelled',
          text: 'Cancelled by re-plan.',
        });
      }
    }

    let added = 0;
    for (const task of plan.tasks) {
      const id =
        task.id && !state.graph.items.some((entry) => entry.id === task.id) ? task.id : nextItemId(state.graph, 'T');
      state.graph.items.push({
        id,
        kind: 'build',
        title: task.title,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        dependsOn: (task.dependsOn ?? []).filter((dep) => dep !== id),
        status: 'pending',
        agentKey: 'builder',
        attempts: 0,
        createdAt: nowIso(),
      });
      added += 1;
      await this.record({ type: 'item-status', itemId: id, itemStatus: 'pending', text: task.title });
    }

    item.status = 'done';
    item.endedAt = nowIso();
    item.resultSummary = plan.summary;
    await this.record({
      type: 'item-status',
      itemId: item.id,
      itemStatus: 'done',
      text: `Plan applied: ${added} task(s). ${plan.summary}`,
    });
    this.emitStatus();
  }

  private async applyBuildResult(item: WorkItem, report: AgentTurnReport, signal: AbortSignal): Promise<void> {
    const state = this.requireState();
    const result = report.result;
    if (!result) {
      await this.handleItemFailure(item, 'turn ended without the structured result contract');
      return;
    }
    if (result.status === 'blocked') {
      await this.handleItemFailure(item, `agent reports blocked: ${result.summary}`);
      return;
    }

    item.resultSummary = result.summary;
    for (const followUp of result.followUpTasks ?? []) {
      const id = nextItemId(state.graph, 'T');
      state.graph.items.push({
        id,
        kind: 'build',
        title: followUp.title,
        description: followUp.description ?? followUp.title,
        dependsOn: [item.id],
        status: 'pending',
        agentKey: 'builder',
        attempts: 0,
        createdAt: nowIso(),
        fixOf: `follow-up of ${item.id}`,
      });
      await this.record({
        type: 'item-status',
        itemId: id,
        itemStatus: 'pending',
        text: `Follow-up: ${followUp.title}`,
      });
    }

    // Per-build verification: red retries the SAME session with the evidence.
    if (state.config.verifyPolicy === 'per-build' || state.config.verifyPolicy === 'both') {
      item.status = 'verifying';
      await this.record({ type: 'item-status', itemId: item.id, itemStatus: 'verifying' });
      this.emitStatus();
      const records = await this.runChecks(signal);
      const failed = records.find((record) => record.outcome !== 'passed');
      if (failed) {
        this.pendingFailures.set(item.id, failed);
        if (item.attempts >= state.config.maxAttemptsPerItem) {
          await this.handleItemFailure(item, `checks failing after ${item.attempts} attempt(s): ${failed.id}`);
          return;
        }
        item.status = 'pending';
        await this.record({
          type: 'item-status',
          itemId: item.id,
          itemStatus: 'pending',
          text: `Check ${failed.id} failed — retrying with the failing output as evidence.`,
        });
        this.emitStatus();
        return;
      }
      this.pendingFailures.delete(item.id);
    }

    item.status = 'done';
    item.endedAt = nowIso();
    await this.record({ type: 'item-status', itemId: item.id, itemStatus: 'done', text: result.summary });
    this.noteDelta(`${item.id} done: ${result.summary}`);
    this.emitStatus();
  }

  private async applyReviewResult(item: WorkItem, report: AgentTurnReport): Promise<void> {
    const state = this.requireState();
    const result = report.result;
    if (!result) {
      await this.handleItemFailure(item, 'review turn ended without the structured result contract');
      return;
    }
    item.status = 'done';
    item.endedAt = nowIso();
    item.resultSummary = result.summary;
    state.reviewDone = true;

    let fixes = 0;
    for (const followUp of result.followUpTasks ?? []) {
      const id = nextItemId(state.graph, 'T');
      state.graph.items.push({
        id,
        kind: 'build',
        title: followUp.title,
        description: followUp.description ?? followUp.title,
        dependsOn: [],
        status: 'pending',
        agentKey: 'builder',
        attempts: 0,
        createdAt: nowIso(),
        fixOf: `review ${item.id}`,
      });
      fixes += 1;
      await this.record({
        type: 'item-status',
        itemId: id,
        itemStatus: 'pending',
        text: `Review fix: ${followUp.title}`,
      });
    }
    await this.record({
      type: 'item-status',
      itemId: item.id,
      itemStatus: 'done',
      text:
        fixes > 0 ? `Review done: ${fixes} fix task(s) filed. ${result.summary}` : `Review approved. ${result.summary}`,
    });
    this.noteDelta(`review ${item.id}: ${result.summary}`);
    this.emitStatus();
  }

  private async handleItemFailure(item: WorkItem, error: string): Promise<void> {
    const state = this.requireState();
    if (item.attempts < state.config.maxAttemptsPerItem) {
      item.status = 'pending';
      await this.record({
        type: 'item-status',
        itemId: item.id,
        itemStatus: 'pending',
        text: `Attempt ${item.attempts} failed (${error}) — retrying (session resumes with context intact).`,
      });
    } else {
      item.status = 'blocked';
      item.error = error;
      item.endedAt = nowIso();
      await this.record({ type: 'item-status', itemId: item.id, itemStatus: 'blocked', text: error });
      this.noteDelta(`${item.id} blocked: ${error}`);
    }
    this.emitStatus();
  }

  // --- helpers -----------------------------------------------------------------

  /** Verification failures awaiting a retry, keyed by item id. */
  private pendingFailures = new Map<string, VerificationRecord>();

  private pendingFailureFor(item: WorkItem): { command: string; outputTail: string } | undefined {
    const record = this.pendingFailures.get(item.id);
    return record ? { command: record.command, outputTail: record.outputTail } : undefined;
  }

  private async runChecks(signal: AbortSignal): Promise<VerificationRecord[]> {
    const state = this.requireState();
    let commands: VerificationCommand[] = state.config.verifyCommands;
    if (!commands.length) commands = await discoverVerificationCommands(state.workspace);
    if (!commands.length) return [];
    const records = await this.verification.run(commands, { cwd: state.workspace, signal });
    state.verifications = records;
    for (const record of records) {
      await this.record({ type: 'verification', verification: record });
      this.noteDelta(`check ${record.id}: ${record.outcome} (exit ${record.exitCode ?? '—'})`);
    }
    this.emitStatus();
    return records;
  }

  private insertPlanItem(title: string): void {
    const state = this.requireState();
    const id = nextItemId(state.graph, 'P');
    state.graph.items.push({
      id,
      kind: 'plan',
      title,
      description: this.planDescription(),
      dependsOn: [],
      status: 'pending',
      agentKey: 'planner',
      attempts: 0,
      createdAt: nowIso(),
    });
    void this.record({ type: 'item-status', itemId: id, itemStatus: 'pending', text: title });
  }

  private planDescription(): string {
    const state = this.requireState();
    const existing = state.graph.items.filter((item) => item.kind === 'build');
    const graphState = existing.length
      ? `\n\nCurrent task graph:\n${existing
          .map((item) => `- ${item.id} [${item.status}] ${item.title}${item.error ? ` (${item.error})` : ''}`)
          .join('\n')}`
      : '';
    return (
      `Decompose the goal into the SMALLEST set of build tasks that fully achieves it. ` +
      `Each task description must be SELF-CONTAINED (executable without reading the other tasks): ` +
      `say exactly what to change, where, and how to know it is done (acceptance criteria). ` +
      `Order tasks by dependency; use dependsOn for hard orderings; do not create tasks for verification ` +
      `(Kaplan runs the checks itself) or coordination (there is none to do). ` +
      `End with the plan JSON object contract.` +
      graphState
    );
  }

  private appendFixItem(failed: VerificationRecord, source: string): void {
    const state = this.requireState();
    const id = nextItemId(state.graph, 'T');
    state.graph.items.push({
      id,
      kind: 'build',
      title: `Fix failing check: ${failed.id}`,
      description:
        `The ${source} check \`${failed.command}\` is failing. Fix the underlying cause — do not weaken or skip the check.\n\n` +
        'Failing output tail:\n```\n' +
        failed.outputTail.slice(-4000) +
        '\n```',
      dependsOn: [],
      status: 'pending',
      agentKey: 'builder',
      attempts: 0,
      createdAt: nowIso(),
      fixOf: source,
    });
    void this.record({ type: 'item-status', itemId: id, itemStatus: 'pending', text: `Fix task for ${failed.id}` });
  }

  private async itemDescriptionForReview(item: WorkItem): Promise<string> {
    const state = this.requireState();
    const changes = await computeTeamChanges(state.workspace, nowIso()).catch(() => null);
    const diffBlock = changes?.diff?.trim()
      ? `\n\n## Working-tree diff (${changes.files.length} file(s), ${changes.summary ?? ''})\n\n` +
        '```diff\n' +
        changes.diff.slice(0, 60_000) +
        '\n```'
      : '\n\n(no diff detected — verify the working tree state yourself)';
    const tasks = state.graph.items
      .filter((entry) => entry.kind === 'build' && entry.status === 'done')
      .map((entry) => `- ${entry.id}: ${entry.title} — ${entry.resultSummary ?? ''}`)
      .join('\n');
    return `${item.description}\n\n## Completed tasks\n${tasks || '(none)'}${diffBlock}`;
  }

  private itemDescription(item: WorkItem): string {
    // Review descriptions are composed asynchronously in runTurn via the
    // itemDescriptionOverride cache set below.
    return this.descriptionOverrides.get(item.id) ?? item.description;
  }

  private descriptionOverrides = new Map<string, string>();

  private agentConfigFor(item: WorkItem): RunConfig['builder'] {
    const state = this.requireState();
    if (item.kind === 'plan') return state.config.planner ?? state.config.builder;
    if (item.kind === 'review') return state.config.reviewer ?? state.config.builder;
    return state.config.builder;
  }

  private defaultPermission(provider: RunConfig['builder']['provider'], item: WorkItem): string {
    // Planners/reviewers read; builders write. These map onto the built-in
    // permission keys from config.ts.
    const writes = item.kind === 'build';
    if (provider === 'claude') return writes ? 'acceptEdits' : 'default';
    if (provider === 'codex') return writes ? 'workspace-write' : 'read-only';
    return writes ? 'sandbox' : 'default';
  }

  private drainSteeringTexts(item: WorkItem): string[] | undefined {
    // Steering is consumed by the plan item created for it.
    if (item.kind !== 'plan') return undefined;
    const state = this.requireState();
    const pending = state.steering.filter((entry) => entry.status === 'pending');
    if (!pending.length) return undefined;
    for (const entry of pending) entry.status = 'applied';
    return pending.map((entry) => entry.body);
  }

  private composeRecap(): string {
    const state = this.requireState();
    const summary = summarizeGraph(state.graph);
    const recent = this.deltaLog.slice(-12).map((entry) => `- ${entry.line}`);
    return `Graph: ${summary.done}/${summary.total} done, ${summary.blocked} blocked.\nRecent events:\n${recent.join('\n') || '- (none)'}`;
  }

  private deltaLinesSince(seq: number): string[] | undefined {
    const lines = this.deltaLog.filter((entry) => entry.seq > seq).map((entry) => entry.line);
    return lines.length ? lines.slice(-40) : undefined;
  }

  private noteDelta(line: string): void {
    const state = this.requireState();
    this.deltaLog.push({ seq: state.seq, line });
    if (this.deltaLog.length > 500) this.deltaLog.shift();
  }

  private async onAgentEvent(item: WorkItem, event: AgentEvent): Promise<void> {
    // Live fan-out; persist a trimmed copy (raw/stderr noise stays live-only).
    if (event.type === 'raw') return;
    const trimmed: AgentEvent = { ...event, text: event.text?.slice(0, 4000) };
    await this.record({ type: 'agent', itemId: item.id, agent: trimmed }, event.type === 'stderr');
  }

  // --- state / persistence -----------------------------------------------------

  private async finish(status: RunStatus, message: string): Promise<void> {
    const state = this.requireState();
    state.status = status;
    state.message = message;
    state.endedAt = nowIso();
    await this.record({ type: 'run-status', status, text: message });
    await this.persist();
    this.emitStatus();
    logger.info('run finished', { runId: state.runId, status, message });
  }

  private async record(event: Omit<RunEvent, 'seq' | 'at' | 'runId'>, skipPersist = false): Promise<void> {
    const state = this.requireState();
    state.seq += 1;
    const full: RunEvent = { ...event, seq: state.seq, at: nowIso(), runId: state.runId };
    this.emit('engine-event', { kind: 'event', event: full } satisfies RunEngineEvent);
    if (!skipPersist) {
      await fs.mkdir(path.dirname(this.eventsFile()), { recursive: true });
      await fs.appendFile(this.eventsFile(), JSON.stringify(full) + '\n', 'utf8').catch(() => {});
    }
  }

  private emitStatus(): void {
    if (!this.state) return;
    this.emit('engine-event', { kind: 'state', state: toRunSnapshot(this.state) } satisfies RunEngineEvent);
  }

  private async persist(): Promise<void> {
    const state = this.requireState();
    const file = path.join(this.runDir(), 'state.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const json = JSON.stringify(state, null, 2);
    await fs.writeFile(tmp, json, 'utf8');
    // Windows: rename onto an existing file can transiently EPERM under AV
    // scanning; retry briefly, then fall back to a direct write. Persistence
    // must never take the run loop down.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(tmp, file);
        return;
      } catch {
        if (attempt >= 2) {
          await fs.writeFile(file, json, 'utf8').catch(() => {});
          await fs.rm(tmp, { force: true }).catch(() => {});
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }

  private runDir(): string {
    const state = this.requireState();
    return path.join(state.workspace, '.tiger', 'runs', state.runId);
  }

  private eventsFile(): string {
    return path.join(this.runDir(), 'events.jsonl');
  }

  private requireState(): RunState {
    if (!this.state) throw new Error('no active run');
    return this.state;
  }

  private requireSessions(): SessionRegistry {
    if (!this.sessions) throw new Error('no active run (sessions)');
    return this.sessions;
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
