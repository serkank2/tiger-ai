import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { randomUUID } from 'node:crypto';
import type { AgentType, TigerConfig } from '../orchestrator/types.js';
import { defaultTigerConfig } from '../orchestrator/config.js';
import { logger } from '../obs/logger.js';
import { getDriver } from '../agents/providers/registry.js';
import { runAgentTurn, type AgentTurnReport, type RunAgentTurnOptions } from '../agents/runner.js';
import { runInteractiveTurn, type InteractiveTurnController } from '../agents/interactive.js';
import { SessionRegistry } from '../agents/session.js';
import { TURN_RESULT_JSON_SCHEMA, parseTurnResult } from '../agents/result.js';
import type { AgentEvent } from '../agents/events.js';
import { composeSessionPreamble, composeTaskBrief } from '../context/brief.js';
import { buildProjectMap } from '../context/project-map.js';
import { computeTeamChanges } from '../git/changes.js';
import { isGitRepo } from '../git/worktree.js';
import {
  VerificationService,
  discoverQuickVerificationCommands,
  discoverVerificationCommands,
  type VerificationCommand,
  type VerificationRecord,
} from '../verify/service.js';
import { cleanupLane, ensureTigerExcluded, mergeLane, prepareLane, type BuildLane } from './lanes.js';
import { PLAN_RESULT_JSON_SCHEMA, parsePlanResult } from './plan.js';
import { upsertRunIndex } from './history.js';
import { isDrained, nextItemId, propagateDoom, selectRunnable, summarizeGraph, type WorkItem } from './graph.js';
import {
  toRunSnapshot,
  type RunAgentSource,
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
// Builds run SEQUENTIALLY in the shared workspace by default (REDESIGN.md §3:
// coding rarely parallelizes well). When `maxParallelBuilds > 1` and the
// workspace is a git repo, a build BATCH fans out across isolated worktree
// lanes (run/lanes.ts) that each snapshot the tree, run one item, and merge
// back as a patch; a patch conflict falls back to a sequential retry in the
// main tree. Verification is scoped: a cheap QUICK gate (typecheck/lint) per
// build, the FULL suite (incl. tests) only at finalize. Big goals are planned
// in BATCHES (staged planning via `remainingScope`), and long-lived agent
// sessions ROTATE to a fresh session with a recap after N turns.
// ---------------------------------------------------------------------------

export interface RunEngineOptions {
  /** Injectable for tests; defaults to the real headless runner. */
  turnRunner?: (opts: RunAgentTurnOptions) => Promise<AgentTurnReport>;
  /** Injectable for tests; defaults to the real interactive PTY runner. */
  interactiveRunner?: typeof runInteractiveTurn;
  verification?: VerificationService;
  /** CLI tool configs (executables/flags); defaults to the built-in defaults. */
  loadCliConfig?: (workspace: string) => Promise<TigerConfig>;
}

export interface CreateRunInput {
  workspace: string;
  goal: string;
  /** council is accepted partially — engine/route fill plan/review from the roster or presets. */
  config?: Partial<Omit<RunConfig, 'council'>> & { council?: Partial<RunConfig['council']> };
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
  quickVerifyCommands: [],
  maxFixRounds: 3,
  allowDangerous: false,
  mcp: false,
  importance: 'normal',
  council: { plan: 1, review: 1, providers: [] },
  planBatchSize: 12,
  maxPlanBatches: 20,
  sessionRotateTurns: 12,
  interactive: false,
  skipPlanning: false,
  rateLimitBackoffMs: 20_000,
};

const MAX_PARALLEL_BUILDS = 4;
/** Cap on how many council candidates run at once — bounds token/rate spikes. */
const COUNCIL_CONCURRENCY = 4;

/**
 * Importance → council size. Parallelism lives ONLY in the read-only phases
 * (independent plan candidates, independent review lenses); the writer stays
 * single. Counts are per run, spread across the configured provider rotation.
 */
const COUNCIL_PRESETS: Record<RunConfig['importance'], { plan: number; review: number }> = {
  low: { plan: 1, review: 1 },
  normal: { plan: 1, review: 1 },
  high: { plan: 3, review: 3 },
  critical: { plan: 5, review: 5 },
};

const COUNCIL_MAX = 12;

/** Perspective rotation for plan candidates — each candidate argues ONE angle. */
const PLAN_LENSES = [
  'correctness and completeness — what must be true for this to actually work',
  'risk and failure modes — where this goes wrong, what breaks, what to guard',
  'simplicity and minimal change — the smallest plan that fully achieves the goal',
  'architecture and maintainability — how this stays clean six months from now',
  'testing and verifiability — how each step can be proven done',
  'sequencing and dependencies — what must land first and what can be deferred',
  'security and safety — inputs, permissions, and blast radius',
  'edge cases and unknowns — what the happy path hides',
];

/** Perspective rotation for review lenses. */
const REVIEW_LENSES = [
  'correctness — does the diff actually do what the tasks claim, with evidence',
  'regressions and tests — what existing behavior could this break; is coverage honest',
  'requirements coverage — is every acceptance criterion genuinely met',
  'security — injection, permissions, secrets, unsafe input handling',
  'code quality — clarity, duplication, dead code, conventions',
  'performance — obvious inefficiencies or hot-path costs introduced',
];

const nowIso = (): string => new Date().toISOString();

export class RunEngine extends EventEmitter {
  private state: RunState | null = null;
  private sessions: SessionRegistry | null = null;
  private loop: Promise<void> | null = null;
  private abort: AbortController | null = null;
  /** Rendered one-line summaries of recent events (delta briefs read from here). */
  private deltaLog: Array<{ seq: number; line: string }> = [];
  /** In-flight turn abort handles by item id — lets steering interrupt a turn without stopping the run. */
  private readonly activeTurnAborts = new Map<string, AbortController>();
  /** Live interactive-turn controllers by agentId — routes user input/complete/abort to the PTY. */
  private readonly interactiveTurns = new Map<string, InteractiveTurnController>();
  /** Live worktree lanes by build-item id (kept across retries; torn down on done/blocked). */
  private readonly lanes = new Map<string, BuildLane>();
  /** Items that must re-run alone in the main workspace (lane merge conflict / lane failure). */
  private readonly sequentialOnly = new Set<string>();
  /** Serializes worktree creation — concurrent `git worktree add` on one repo contends on the lock. */
  private laneCreateChain: Promise<unknown> = Promise.resolve();
  /** Serializes lane merge-back — `git apply` to the shared tree must be atomic vs other lanes. */
  private laneMergeChain: Promise<unknown> = Promise.resolve();
  private readonly turnRunner: (opts: RunAgentTurnOptions) => Promise<AgentTurnReport>;
  private readonly interactiveRunner: typeof runInteractiveTurn;
  private readonly verification: VerificationService;
  private readonly loadCliConfig: (workspace: string) => Promise<TigerConfig>;
  private cliConfig: TigerConfig | null = null;
  private projectMap = '';
  private persistSeq = 0;

  constructor(options: RunEngineOptions = {}) {
    super();
    this.turnRunner = options.turnRunner ?? runAgentTurn;
    this.interactiveRunner = options.interactiveRunner ?? runInteractiveTurn;
    this.verification = options.verification ?? new VerificationService();
    this.loadCliConfig = options.loadCliConfig ?? (async () => defaultTigerConfig());
  }

  // --- lifecycle -------------------------------------------------------------

  async createRun(input: CreateRunInput): Promise<RunSnapshot> {
    if (this.state && (this.state.status === 'running' || this.state.status === 'created')) {
      throw new Error('a run is already active; stop it before creating a new one');
    }
    const runId = `run-${nanoid(10)}`;
    // council is (re)computed below from the roster/presets, so keep the
    // possibly-partial input council out of the initial full-config spread.
    const { council: _inputCouncil, ...inputRest } = input.config ?? {};
    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      ...inputRest,
      builder: { ...DEFAULT_CONFIG.builder, ...input.config?.builder },
    };
    // Parallel builds run in isolated worktree lanes (patch merge-back); the
    // count is clamped, and runLoop degrades to 1 when the workspace isn't git.
    config.maxParallelBuilds = Math.max(1, Math.min(MAX_PARALLEL_BUILDS, Math.floor(config.maxParallelBuilds || 1)));
    // Council sizing: an explicit roster (per-provider counts + models) IS the
    // council; otherwise explicit counts; otherwise the importance preset.
    const preset = COUNCIL_PRESETS[config.importance] ?? COUNCIL_PRESETS.normal;
    const requested = input.config?.council;
    const members = (requested?.members ?? [])
      .filter((member) => Number.isFinite(member.count) && member.count > 0)
      .map((member) => ({ ...member, count: Math.min(Math.floor(member.count), COUNCIL_MAX) }));
    const rosterSize = Math.min(
      members.reduce((total, member) => total + member.count, 0),
      COUNCIL_MAX,
    );
    if (rosterSize > 0) {
      // Explicit per-phase counts (from the Phases selectors) win over the
      // roster total; the roster still provides the provider/model rotation.
      config.council = {
        plan: clampCount(requested?.plan ?? rosterSize),
        review: clampCount(requested?.review ?? rosterSize),
        providers: [...new Set(members.map((member) => member.provider))],
        members,
      };
    } else {
      config.council = {
        plan: clampCount(requested?.plan ?? preset.plan),
        review: clampCount(requested?.review ?? preset.review),
        providers: (requested?.providers?.length ? requested.providers : [config.builder.provider]).slice(0, 3),
      };
    }
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
      planBatches: 0,
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

  async steer(body: string, opts: { interrupt?: boolean } = {}): Promise<RunSnapshot> {
    const state = this.requireState();
    const directive = { id: nanoid(8), body: body.trim(), createdAt: nowIso(), status: 'pending' as const };
    state.steering.push(directive);
    await this.record({ type: 'steering', text: directive.body });
    // Immediate intervention: abort the in-flight turn(s). The aborted items
    // re-queue (attempts refunded), the loop sees the pending steering at the
    // very next pass, and the re-plan runs first — the flow itself continues.
    if (opts.interrupt && this.activeTurnAborts.size > 0) {
      await this.record({ type: 'note', text: 'Steering interrupt: aborting the in-flight turn(s) to apply it now.' });
      for (const controller of this.activeTurnAborts.values()) controller.abort();
    }
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
    // Keep Kaplan's own `.tiger/` bookkeeping out of git (diff panel + lanes).
    if (await isGitRepo(state.workspace)) {
      await ensureTigerExcluded(state.workspace);
    } else if (state.config.maxParallelBuilds > 1) {
      // Worktree lanes need git; a non-repo workspace degrades to sequential.
      state.config.maxParallelBuilds = 1;
      await this.record({
        type: 'note',
        text: 'Workspace is not a git repository — parallel build lanes need worktrees, running sequentially.',
      });
    }

    let noProgress = 0;
    while (!signal.aborted && this.state?.status === 'running') {
      const current = this.requireState();

      // 1. Steering pending → insert a re-plan item at this boundary (code, not a Lead turn).
      //    When planning is skipped there is no plan phase to re-plan; steering
      //    is drained into the next build turn instead (see drainSteeringTexts).
      const pendingSteering = current.steering.filter((entry) => entry.status === 'pending');
      const hasPlanScheduled = current.graph.items.some(
        (item) => item.kind === 'plan' && (item.status === 'pending' || item.status === 'running'),
      );
      if (pendingSteering.length > 0 && !hasPlanScheduled && !current.config.skipPlanning) {
        this.insertPlanItem('Re-plan for user steering');
      } else if (current.graph.items.length === 0) {
        // 2. Fresh run → seed planning, or a single direct build task when planning is skipped.
        if (current.config.skipPlanning) this.seedDirectBuild();
        else this.insertPlanItem('Plan the work');
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

      // 4. Execute. A multi-build batch fans out into isolated worktree lanes;
      //    conflict-flagged items pre-empt the batch and run alone in the main
      //    workspace (their lane work was discarded).
      let batch = runnable;
      const sequentialFirst = runnable.find((item) => item.kind === 'build' && this.sequentialOnly.has(item.id));
      if (sequentialFirst) batch = [sequentialFirst];
      const useLanes =
        current.config.maxParallelBuilds > 1 && batch.length > 1 && batch.every((item) => item.kind === 'build');
      await Promise.all(batch.map((item) => this.executeItem(item, signal, useLanes)));
      await this.persist();
    }

    if (this.state?.status === 'running') await this.finish('stopped', 'Run loop exited.');
  }

  /** Drained graph: next plan batch → final checks → fix loop → final review → completed/blocked. */
  private async finalize(signal: AbortSignal): Promise<boolean> {
    const state = this.requireState();

    // Staged planning: the current batch is built — plan the next one before
    // finalizing anything (mega-goals never explode into one giant plan).
    if (state.pendingScope) {
      this.insertPlanItem(`Plan the next batch (${state.planBatches + 1}/${state.config.maxPlanBatches})`);
      return false;
    }

    const summary = summarizeGraph(state.graph);
    const hadBuilds = state.graph.items.some((item) => item.kind === 'build' && item.status === 'done');

    // Final verification (policy final/both) — the only truth about "green".
    if ((state.config.verifyPolicy === 'final' || state.config.verifyPolicy === 'both') && hadBuilds) {
      const records = await this.runChecks(signal, { scope: 'full' });
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

  private async executeItem(item: WorkItem, signal: AbortSignal, useLane = false): Promise<void> {
    const state = this.requireState();
    item.status = 'running';
    item.attempts += 1;
    item.startedAt = nowIso();
    await this.record({ type: 'item-status', itemId: item.id, itemStatus: 'running' });
    this.emitStatus();

    // Isolated lane for a parallel build (an existing lane is reused across retries).
    if (item.kind === 'build' && useLane && !this.lanes.has(item.id)) {
      try {
        // Serialize creation: concurrent `git worktree add` on the same repo
        // contends on git's worktree lock and can spuriously fail.
        const create = this.laneCreateChain.then(() => prepareLane(state.workspace, state.runId, item.id));
        this.laneCreateChain = create.catch(() => undefined);
        const lane = await create;
        this.lanes.set(item.id, lane);
        item.worktree = { path: lane.worktree.path, branch: lane.worktree.branch };
        await this.record({
          type: 'note',
          itemId: item.id,
          text: `Build lane ready: ${lane.worktree.branch} (isolated worktree).`,
        });
      } catch (err) {
        // No lane → never race the shared tree inside a parallel batch; defer
        // to a sequential pass instead (attempt refunded).
        item.status = 'pending';
        item.attempts -= 1;
        this.sequentialOnly.add(item.id);
        await this.record({
          type: 'item-status',
          itemId: item.id,
          itemStatus: 'pending',
          text: `Worktree lane failed (${err instanceof Error ? err.message : String(err)}) — queued for sequential execution.`,
        });
        this.emitStatus();
        return;
      }
    }

    // Council: independent read-only perspectives BEFORE the authoritative
    // turn. Plan candidates are merged by a synthesis turn on the planner's
    // session; review lenses are merged in code. The write path stays single.
    // Interactive mode drives ONE live agent, so the council (which is a
    // headless parallel fan-out) is skipped — otherwise a run would pay for a
    // full ensemble before every hands-on turn.
    const council = state.config.council;
    const useCouncil = !state.config.interactive;
    if (item.kind === 'plan' && council.plan > 1 && useCouncil) {
      const candidates = await this.runPlanCouncil(item, council, signal);
      if (candidates.length > 0) {
        this.descriptionOverrides.set(item.id, this.synthesisDescription(item, candidates));
      }
      // No usable candidate → fall through to the normal single-planner turn.
    }
    if (item.kind === 'review') {
      const reviewBrief = await this.itemDescriptionForReview(item);
      if (council.review > 1 && useCouncil) {
        const merged = await this.runReviewCouncil(item, reviewBrief, council, signal);
        if (merged) {
          await this.applyReviewResult(item, merged);
          return;
        }
        // Every lens failed → fall back to the single-reviewer turn.
      }
      this.descriptionOverrides.set(item.id, reviewBrief);
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
    // Interactive mode: a real PTY the user watches and drives (opt-in).
    if (state.config.interactive) return this.runInteractive(item, signal);

    const cli = this.cliConfig ?? defaultTigerConfig();
    const agent = this.agentConfigFor(item);
    const driver = getDriver(agent.provider);
    const sessions = this.requireSessions();
    const sessionKey = this.sessionKeyFor(item);
    const stored = sessions.get(sessionKey);
    // Session rotation: a slot that has served many turns starts a FRESH
    // provider session (with a recap) so stale assumptions don't accumulate.
    const rotate =
      state.config.sessionRotateTurns > 0 &&
      (stored?.turns ?? 0) > 0 &&
      (stored?.turns ?? 0) % state.config.sessionRotateTurns === 0;
    const canResume = driver.supportsResume && stored?.sessionId !== undefined && !rotate;
    if (rotate) {
      await this.record({
        type: 'note',
        itemId: item.id,
        text: `Rotating ${item.agentKey} to a fresh session after ${stored?.turns} turns (recap carried forward).`,
      });
    }

    // Brief composition: preamble once per session; delta-only follow-ups.
    const brief = composeTaskBrief({
      title: `${item.id} — ${item.title}`,
      description: this.itemDescription(item),
      acceptanceCriteria: item.acceptanceCriteria,
      deltaLines: canResume ? this.deltaLinesSince(stored?.lastSeq ?? 0) : undefined,
      steering: this.drainSteeringTexts(item),
      verificationFailure: this.pendingFailureFor(item),
      recap: !canResume && ((stored?.turns ?? 0) > 0 || rotate) ? this.composeRecap() : undefined,
    });
    const prompt = canResume
      ? brief
      : `${composeSessionPreamble({
          runId: state.runId,
          agentName: item.agentKey,
          goal: state.goal,
          workspace: this.cwdFor(item),
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
      cwd: this.cwdFor(item),
      hardTimeoutMs: state.config.hardTurnTimeoutMs,
      signal: this.linkTurnSignal(item.id, signal),
      onEvent: (event) =>
        void this.onAgentEvent(
          item,
          { agentId: this.agentIdFor(item), provider: agent.provider, model: agent.model },
          event,
        ),
    });
    this.clearTurnSignal(item.id);

    await sessions.upsert(sessionKey, agent.provider, {
      sessionId: report.sessionId ?? newSessionId ?? stored?.sessionId,
      lastSeq: state.seq,
      turnServed: true,
    });
    return report;
  }

  /**
   * Session slot key. Sequential builds share the `builder` session (context
   * continuity + delta briefs); a build running in its own worktree lane gets a
   * PER-ITEM session so parallel lanes never resume the same provider session
   * concurrently.
   */
  private sessionKeyFor(item: WorkItem): string {
    const state = this.requireState();
    if (item.kind === 'build' && this.lanes.has(item.id)) return `${state.runId}:${item.agentKey}:${item.id}`;
    return `${state.runId}:${item.agentKey}`;
  }

  /** Working directory for a turn: the item's lane worktree when isolated, else the workspace. */
  private cwdFor(item: WorkItem): string {
    const lane = this.lanes.get(item.id);
    return lane ? lane.worktree.path : this.requireState().workspace;
  }

  /** Stable per-turn stream id: unique per build item (parallel-safe), role key otherwise. */
  private agentIdFor(item: WorkItem): string {
    return item.kind === 'build' ? item.id : item.agentKey;
  }

  /**
   * Interactive turn: launch the provider's REAL CLI in a PTY the user watches
   * and types into. The engine seeds the brief (always with preamble + recap —
   * interactive sessions are not resumed by id) and registers the controller so
   * input / complete / abort can reach the live process.
   */
  private async runInteractive(item: WorkItem, signal: AbortSignal): Promise<AgentTurnReport> {
    const state = this.requireState();
    const cli = this.cliConfig ?? defaultTigerConfig();
    const agent = this.agentConfigFor(item);
    const agentId = this.agentIdFor(item);
    const brief = composeTaskBrief({
      title: `${item.id} — ${item.title}`,
      description: this.itemDescription(item),
      acceptanceCriteria: item.acceptanceCriteria,
      steering: this.drainSteeringTexts(item),
      verificationFailure: this.pendingFailureFor(item),
      recap: (this.requireSessions().get(this.sessionKeyFor(item))?.turns ?? 0) > 0 ? this.composeRecap() : undefined,
    });
    const prompt = `${composeSessionPreamble({
      runId: state.runId,
      agentName: agentId,
      goal: state.goal,
      workspace: this.cwdFor(item),
      projectMap: this.projectMap,
    })}\n${brief}`;

    const controller = this.interactiveRunner({
      provider: agent.provider,
      tool: cli.cli[agent.provider],
      prompt,
      model: agent.model,
      effort: agent.effort,
      permission: agent.permission ?? this.defaultPermission(agent.provider, item),
      allowDangerous: state.config.allowDangerous,
      cwd: this.cwdFor(item),
      scratchDir: path.join(this.runDir(), 'scratch', item.id),
      hardTimeoutMs: state.config.hardTurnTimeoutMs,
      signal: this.linkTurnSignal(item.id, signal),
      onEvent: (event) =>
        void this.onAgentEvent(item, { agentId, provider: agent.provider, model: agent.model }, event),
    });
    this.interactiveTurns.set(agentId, controller);
    await this.record({
      type: 'note',
      itemId: item.id,
      text: `Interactive session live for ${agentId} — watch and type in its terminal; click “complete turn” when done.`,
    });
    try {
      return await controller.promise;
    } finally {
      this.interactiveTurns.delete(agentId);
      this.clearTurnSignal(item.id);
      // Interactive slots still count turns (for rotation-recap bookkeeping).
      await this.requireSessions()
        .upsert(this.sessionKeyFor(item), agent.provider, { lastSeq: state.seq, turnServed: true })
        .catch(() => {});
    }
  }

  /** Route a user keystroke into a live interactive agent turn. */
  interactiveInput(agentId: string, data: string): boolean {
    const controller = this.interactiveTurns.get(agentId);
    if (!controller) return false;
    controller.write(data);
    return true;
  }

  /** User marks an interactive turn complete (the engine reads its result file). */
  interactiveComplete(agentId: string): boolean {
    const controller = this.interactiveTurns.get(agentId);
    if (!controller) return false;
    controller.complete();
    return true;
  }

  /** Live interactive agent stream ids (for the UI / validation). */
  listInteractiveAgents(): string[] {
    return [...this.interactiveTurns.keys()];
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

    // Two passes so dependsOn survives id remapping: when a planner task id
    // collides with an existing item it is reassigned (e.g. a re-plan batch
    // numbering from T1 again), and a sibling's dependsOn:["T1"] must follow the
    // NEW id, not silently bind to the old, already-done T1.
    const idMap = new Map<string, string>();
    const assigned: string[] = [];
    for (const task of plan.tasks) {
      const wanted = task.id?.trim();
      const id =
        wanted && !state.graph.items.some((entry) => entry.id === wanted) && !idMap.has(wanted)
          ? wanted
          : nextItemId(state.graph, 'T');
      if (wanted) idMap.set(wanted, id);
      assigned.push(id);
      // Reserve the id immediately so nextItemId can't hand it out twice.
      state.graph.items.push({
        id,
        kind: 'build',
        title: task.title,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        dependsOn: [],
        status: 'pending',
        agentKey: 'builder',
        attempts: 0,
        createdAt: nowIso(),
      });
    }
    let added = 0;
    plan.tasks.forEach((task, index) => {
      const id = assigned[index]!;
      const entry = state.graph.items.find((candidate) => candidate.id === id)!;
      entry.dependsOn = (task.dependsOn ?? [])
        .map((dep) => idMap.get(dep.trim()) ?? dep.trim())
        .filter((dep) => dep !== id);
      added += 1;
    });
    for (const id of assigned) {
      const entry = state.graph.items.find((candidate) => candidate.id === id)!;
      await this.record({ type: 'item-status', itemId: id, itemStatus: 'pending', text: entry.title });
    }

    // Staged planning bookkeeping: remember any remaining scope so finalize
    // schedules the next batch instead of ending the run. Guard against a spin:
    // a batch that added ZERO tasks must not schedule yet another empty plan.
    state.planBatches += 1;
    const moreToPlan = plan.remainingScope && added > 0 && state.planBatches < state.config.maxPlanBatches;
    state.pendingScope = moreToPlan ? plan.remainingScope : undefined;

    item.status = 'done';
    item.endedAt = nowIso();
    item.resultSummary = plan.summary;
    await this.record({
      type: 'item-status',
      itemId: item.id,
      itemStatus: 'done',
      text:
        `Plan applied: ${added} task(s). ${plan.summary}` +
        (state.pendingScope
          ? ` — more to plan after this batch (${state.planBatches}/${state.config.maxPlanBatches}).`
          : ''),
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

    // Per-build verification: the QUICK static gate (typecheck/lint) only —
    // the full suite runs at finalize. Red retries the SAME session with the
    // failing tail as evidence. Lane builds verify inside their worktree.
    if (state.config.verifyPolicy === 'per-build' || state.config.verifyPolicy === 'both') {
      item.status = 'verifying';
      await this.record({ type: 'item-status', itemId: item.id, itemStatus: 'verifying' });
      this.emitStatus();
      const records = await this.runChecks(signal, { scope: 'quick', cwd: this.cwdFor(item) });
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

    // Merge an isolated lane back onto the main working tree as a patch. A
    // conflict (another lane touched the same lines) is NOT force-merged: the
    // item re-runs sequentially in the main tree, where it sees the real state.
    if (this.lanes.has(item.id)) {
      const merged = await this.mergeItemLane(item);
      if (!merged) return;
    }

    item.status = 'done';
    item.endedAt = nowIso();
    await this.record({ type: 'item-status', itemId: item.id, itemStatus: 'done', text: result.summary });
    this.noteDelta(`${item.id} done: ${result.summary}`);
    this.emitStatus();
  }

  /**
   * Merge the item's worktree lane onto the main tree. Returns true when the
   * item may proceed to `done`; false when it was re-queued for a sequential
   * retry (conflict) — the caller must stop processing this item.
   */
  private async mergeItemLane(item: WorkItem): Promise<boolean> {
    const state = this.requireState();
    const lane = this.lanes.get(item.id);
    if (!lane) return true;
    // Serialize the patch-to-main step: two lanes' `git apply` to the shared
    // working tree must never interleave (no index.lock protects it), or they
    // corrupt/half-apply each other's changes.
    const merge = this.laneMergeChain.then(() =>
      mergeLane(state.workspace, lane).catch((err) => ({
        ok: false as const,
        files: [] as string[],
        detail: err instanceof Error ? err.message : String(err),
      })),
    );
    this.laneMergeChain = merge.catch(() => undefined);
    const result = await merge;
    // Tear the lane down either way; a conflict retry runs in the main tree.
    // Compute the per-item session key BEFORE forgetting the lane.
    const sessionKey = this.sessionKeyFor(item);
    await cleanupLane(state.workspace, lane).catch(() => {});
    this.lanes.delete(item.id);
    await this.requireSessions()
      .remove(sessionKey)
      .catch(() => {});
    item.worktree = null;

    if (result.ok) {
      if (result.files.length) this.noteDelta(`${item.id} merged ${result.files.length} file(s) from its lane`);
      return true;
    }

    // Conflict / merge failure → sequential retry in the main workspace.
    this.sequentialOnly.add(item.id);
    item.attempts = Math.max(0, item.attempts - 1); // not the agent's fault
    this.pendingFailures.delete(item.id);
    item.status = 'pending';
    await this.record({
      type: 'item-status',
      itemId: item.id,
      itemStatus: 'pending',
      text: `Lane merge conflicted (${result.detail ?? 'patch did not apply'}) — re-running sequentially in the main tree.`,
    });
    this.emitStatus();
    return false;
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

  // --- council (multi-perspective ensemble) ----------------------------------

  /** Link a per-item abort controller under the loop signal (steering interrupt). */
  private linkTurnSignal(itemId: string, parent: AbortSignal): AbortSignal {
    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort();
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', onParentAbort, { once: true });
    this.activeTurnAborts.set(itemId, controller);
    // Store the removal so a completed turn drops its listener — otherwise every
    // turn leaks one 'abort' listener on the long-lived run signal.
    this.turnSignalCleanups.set(itemId, () => parent.removeEventListener('abort', onParentAbort));
    return controller.signal;
  }

  /** In-flight turn signal listener removers, keyed by item id. */
  private readonly turnSignalCleanups = new Map<string, () => void>();

  /** Drop a finished turn's abort controller AND its run-signal listener. */
  private clearTurnSignal(itemId: string): void {
    this.activeTurnAborts.delete(itemId);
    this.turnSignalCleanups.get(itemId)?.();
    this.turnSignalCleanups.delete(itemId);
  }

  /** One read-only, one-shot council candidate turn. Null when it failed. */
  private async runCouncilCandidate(
    item: WorkItem,
    input: {
      role: 'plan' | 'review';
      lens: string;
      index: number;
      provider: AgentType;
      model?: string;
      effort?: string;
      brief: string;
    },
    signal: AbortSignal,
  ): Promise<{ text: string | undefined; report: AgentTurnReport } | null> {
    const state = this.requireState();
    const cli = this.cliConfig ?? defaultTigerConfig();
    const driver = getDriver(input.provider);
    const name = `${input.role}-candidate-${input.index + 1}`;
    const prompt =
      composeSessionPreamble({
        runId: state.runId,
        agentName: name,
        goal: state.goal,
        workspace: state.workspace,
        projectMap: this.projectMap,
      }) +
      '\n' +
      input.brief;
    const report = await this.turnRunner({
      driver,
      tool: cli.cli[input.provider],
      request: {
        prompt,
        model: input.model,
        effort: input.effort,
        permission: this.readOnlyPermission(input.provider),
        allowDangerous: false,
        resultSchema: input.role === 'plan' ? PLAN_RESULT_JSON_SCHEMA : TURN_RESULT_JSON_SCHEMA,
        scratchDir: path.join(this.runDir(), 'scratch', item.id, name),
      },
      cwd: state.workspace,
      hardTimeoutMs: state.config.hardTurnTimeoutMs,
      signal,
      onEvent: (event) =>
        void this.onAgentEvent(item, { agentId: name, provider: input.provider, model: input.model }, event),
    });
    this.accountUsage(item, report);
    if (report.state !== 'completed') {
      await this.record({
        type: 'note',
        itemId: item.id,
        text: `Council ${name} (${input.provider}) failed: ${report.error ?? report.state}`,
      });
      return null;
    }
    await this.record({
      type: 'note',
      itemId: item.id,
      text: `Council ${name} (${input.provider}) delivered its ${input.role === 'plan' ? 'plan' : 'review'}.`,
    });
    return { text: report.resultText, report };
  }

  /** Read-only permission key per provider (council candidates never write). */
  private readOnlyPermission(provider: AgentType): string {
    // Council candidates run concurrently in the shared workspace, so they must
    // NOT be able to write — a prose "do not edit" is not enough. Map each
    // provider to its genuinely non-writing mode (config.ts built-ins):
    //   codex → read-only sandbox, claude → plan mode, agy → sandbox.
    if (provider === 'codex') return 'read-only';
    if (provider === 'antigravity') return 'sandbox';
    return 'plan';
  }

  /**
   * Flat council seats (provider + model per candidate). The explicit roster
   * wins; otherwise rotate the configured provider list, model unset.
   */
  private councilSeats(count: number, council: RunConfig['council']): CouncilSeat[] {
    const state = this.requireState();
    if (council.members?.length) {
      const seats: CouncilSeat[] = [];
      for (const member of council.members) {
        for (let index = 0; index < member.count; index += 1) {
          seats.push({ provider: member.provider, model: member.model, effort: member.effort });
        }
      }
      return seats.slice(0, COUNCIL_MAX);
    }
    return Array.from({ length: count }, (_, index) => ({
      provider: council.providers[index % council.providers.length] ?? state.config.builder.provider,
    }));
  }

  /** Fan out N independent plan candidates (parallel, read-only, distinct lenses). */
  private async runPlanCouncil(
    item: WorkItem,
    council: RunConfig['council'],
    signal: AbortSignal,
  ): Promise<CouncilPlanCandidate[]> {
    const seats = this.councilSeats(council.plan, council);
    await this.record({
      type: 'note',
      itemId: item.id,
      text: `Council: ${seats.length} independent plan candidate(s) across [${describeSeats(seats)}] before synthesis.`,
    });
    const briefs = seats.map((seat, index) => {
      const lens = PLAN_LENSES[index % PLAN_LENSES.length] ?? 'general';
      const brief = composeTaskBrief({
        title: `${item.id} — independent plan candidate ${index + 1}`,
        description:
          this.planDescription() +
          `\n\nYOUR ASSIGNED PERSPECTIVE (argue THIS angle hard; the other candidates cover the rest): ${lens}. ` +
          'You are ONE independent voice on a planning council — do NOT write any files or code; produce only your plan JSON.',
      });
      return { lens, provider: seat.provider, model: seat.model, effort: seat.effort, brief };
    });
    const results = await mapWithConcurrency(briefs.length, COUNCIL_CONCURRENCY, (index) => {
      const candidate = briefs[index]!;
      return this.runCouncilCandidate(
        item,
        {
          role: 'plan',
          lens: candidate.lens,
          index,
          provider: candidate.provider,
          model: candidate.model,
          effort: candidate.effort,
          brief: candidate.brief,
        },
        signal,
      );
    });
    const out: CouncilPlanCandidate[] = [];
    results.forEach((result, index) => {
      const plan = result ? parsePlanResult(result.text) : null;
      const meta = briefs[index];
      if (plan && plan.status === 'done' && meta) out.push({ lens: meta.lens, provider: meta.provider, plan });
    });
    return out;
  }

  /** The synthesis brief: every candidate plan, rendered compactly for the planner session. */
  private synthesisDescription(item: WorkItem, candidates: CouncilPlanCandidate[]): string {
    void item;
    const rendered = candidates
      .map((candidate, index) => {
        const tasks = candidate.plan.tasks
          .map(
            (task) =>
              `  - ${task.id ?? '?'}: ${task.title} — ${task.description.slice(0, 300)}${task.dependsOn?.length ? ` (deps: ${task.dependsOn.join(',')})` : ''}`,
          )
          .join('\n');
        return `## Candidate ${index + 1} (${candidate.provider}, lens: ${candidate.lens})\nSummary: ${candidate.plan.summary}\n${tasks}`;
      })
      .join('\n\n');
    return (
      `You are the plan SYNTHESIZER. ${candidates.length} independent candidates each planned this goal from a different angle. ` +
      'Merge them into ONE final task graph: keep every genuinely necessary task, drop duplicates and over-engineering, ' +
      'resolve conflicts by preferring the simplest plan that still covers the risks the other lenses exposed. ' +
      'Task descriptions must stay SELF-CONTAINED; use dependsOn for hard orderings. End with the plan JSON contract.\n\n' +
      rendered +
      '\n\n' +
      this.planDescription()
    );
  }

  /** Fan out N review lenses (parallel, read-only) and merge their findings in code. */
  private async runReviewCouncil(
    item: WorkItem,
    reviewBrief: string,
    council: RunConfig['council'],
    signal: AbortSignal,
  ): Promise<AgentTurnReport | null> {
    const seats = this.councilSeats(council.review, council);
    await this.record({
      type: 'note',
      itemId: item.id,
      text: `Council: ${seats.length} independent review lens(es) across [${describeSeats(seats)}].`,
    });
    const lenses = seats.map((seat, index) => ({
      lens: REVIEW_LENSES[index % REVIEW_LENSES.length] ?? 'correctness',
      provider: seat.provider,
      model: seat.model,
      effort: seat.effort,
    }));
    const results = await mapWithConcurrency(lenses.length, COUNCIL_CONCURRENCY, (index) => {
      const entry = lenses[index]!;
      return this.runCouncilCandidate(
        item,
        {
          role: 'review',
          lens: entry.lens,
          index,
          provider: entry.provider,
          model: entry.model,
          effort: entry.effort,
          brief: composeTaskBrief({
            title: `${item.id} — review lens ${index + 1}`,
            description:
              reviewBrief +
              `\n\nYOUR ASSIGNED REVIEW LENS (judge ONLY through it; other lenses cover the rest): ${entry.lens}. ` +
              'Do NOT modify any files. Report follow-up tasks ONLY for defects you can back with evidence from the diff.',
          }),
        },
        signal,
      );
    });

    const verdicts: string[] = [];
    const followUps: Array<{ title: string; description?: string }> = [];
    let usable = 0;
    results.forEach((result, index) => {
      if (!result) return;
      const parsed = parseTurnResult(result.text);
      if (!parsed) return;
      usable += 1;
      const lensName = lenses[index]?.lens.split(' — ')[0] ?? 'lens';
      verdicts.push(`[${lensName}] ${parsed.summary}`);
      for (const task of parsed.followUpTasks ?? []) {
        // Fuzzy dedup: two lenses often report the SAME defect in different
        // words. Merge when titles are near-duplicates (token-overlap), not
        // just byte-identical, so one fix task is filed per real issue.
        if (!followUps.some((existing) => titlesSimilar(existing.title, task.title))) followUps.push(task);
      }
    });
    if (usable === 0) return null;

    return {
      state: 'completed',
      exitCode: 0,
      resultText: undefined,
      result: {
        status: 'done',
        summary: verdicts.join(' | ').slice(0, 4000),
        followUpTasks: followUps,
      },
      eventCount: 0,
      durationMs: 0,
      command: `council(review x${usable})`,
    };
  }

  /** Accumulate a report's provider-reported usage onto the item + run totals. */
  private accountUsage(item: WorkItem, report: AgentTurnReport): void {
    const state = this.requireState();
    state.usage.turns += 1;
    if (!report.usage) return;
    item.usage = {
      inputTokens: (item.usage?.inputTokens ?? 0) + (report.usage.inputTokens ?? 0),
      cachedInputTokens: (item.usage?.cachedInputTokens ?? 0) + (report.usage.cachedInputTokens ?? 0),
      outputTokens: (item.usage?.outputTokens ?? 0) + (report.usage.outputTokens ?? 0),
      costUsd: round4((item.usage?.costUsd ?? 0) + (report.usage.costUsd ?? 0)),
    };
    state.usage.inputTokens = (state.usage.inputTokens ?? 0) + (report.usage.inputTokens ?? 0);
    state.usage.cachedInputTokens = (state.usage.cachedInputTokens ?? 0) + (report.usage.cachedInputTokens ?? 0);
    state.usage.outputTokens = (state.usage.outputTokens ?? 0) + (report.usage.outputTokens ?? 0);
    state.usage.costUsd = round4((state.usage.costUsd ?? 0) + (report.usage.costUsd ?? 0));
  }

  private async handleItemFailure(item: WorkItem, error: string): Promise<void> {
    const state = this.requireState();
    if (item.attempts < state.config.maxAttemptsPerItem) {
      item.status = 'pending';
      // Provider rate/quota limit: back off before the retry instead of
      // immediately hammering a limited provider (bounded, abort-aware).
      if (isRateLimitError(error) && state.config.rateLimitBackoffMs > 0) {
        await this.record({
          type: 'note',
          itemId: item.id,
          text: `Rate/quota limit hit — backing off ${Math.round(state.config.rateLimitBackoffMs / 1000)}s before retrying ${item.id}.`,
        });
        await this.backoff(state.config.rateLimitBackoffMs);
      }
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
      // A blocked lane build is abandoned: drop its worktree so it never leaks.
      await this.discardItemLane(item);
      await this.record({ type: 'item-status', itemId: item.id, itemStatus: 'blocked', text: error });
      this.noteDelta(`${item.id} blocked: ${error}`);
    }
    this.emitStatus();
  }

  /** Tear down an item's lane without merging (blocked/abandoned build). */
  private async discardItemLane(item: WorkItem): Promise<void> {
    const lane = this.lanes.get(item.id);
    if (!lane) return;
    await cleanupLane(this.requireState().workspace, lane).catch(() => {});
    await this.requireSessions()
      .remove(this.sessionKeyFor(item))
      .catch(() => {});
    this.lanes.delete(item.id);
    item.worktree = null;
  }

  // --- helpers -----------------------------------------------------------------

  /** Verification failures awaiting a retry, keyed by item id. */
  private pendingFailures = new Map<string, VerificationRecord>();

  private pendingFailureFor(item: WorkItem): { command: string; outputTail: string } | undefined {
    const record = this.pendingFailures.get(item.id);
    return record ? { command: record.command, outputTail: record.outputTail } : undefined;
  }

  /**
   * Run checks and persist the records. `scope: 'quick'` uses the cheap static
   * gate (per-build); `scope: 'full'` uses the whole suite (finalize). `cwd`
   * lets a lane build verify inside its own worktree.
   */
  private async runChecks(
    signal: AbortSignal,
    opts: { scope?: 'quick' | 'full'; cwd?: string } = {},
  ): Promise<VerificationRecord[]> {
    const state = this.requireState();
    const scope = opts.scope ?? 'full';
    const cwd = opts.cwd ?? state.workspace;
    let commands: VerificationCommand[];
    if (scope === 'quick') {
      commands = state.config.quickVerifyCommands.length
        ? state.config.quickVerifyCommands
        : await discoverQuickVerificationCommands(state.workspace);
    } else {
      commands = state.config.verifyCommands.length
        ? state.config.verifyCommands
        : await discoverVerificationCommands(state.workspace);
    }
    if (!commands.length) return [];
    const records = await this.verification.run(commands, { cwd, signal });
    // Only full/main-tree runs are the authoritative run-level verification
    // snapshot; a lane's quick gate is item-local and stays in the event log.
    if (scope === 'full' && cwd === state.workspace) state.verifications = records;
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

  /** Planning skipped: seed the goal as a single build task the builder does directly. */
  private seedDirectBuild(): void {
    const state = this.requireState();
    const id = nextItemId(state.graph, 'T');
    state.graph.items.push({
      id,
      kind: 'build',
      title: 'Complete the goal',
      description:
        `Planning is disabled — there is no task breakdown. Complete this goal DIRECTLY and fully:\n\n${state.goal}\n\n` +
        'If the goal is large, do as much as you can this turn and report the rest as follow-up tasks.',
      dependsOn: [],
      status: 'pending',
      agentKey: 'builder',
      attempts: 0,
      createdAt: nowIso(),
    });
    void this.record({
      type: 'item-status',
      itemId: id,
      itemStatus: 'pending',
      text: 'Direct build (planning skipped).',
    });
  }

  private planDescription(): string {
    const state = this.requireState();
    const existing = state.graph.items.filter((item) => item.kind === 'build');
    const graphState = existing.length
      ? `\n\nCurrent task graph:\n${existing
          .map((item) => `- ${item.id} [${item.status}] ${item.title}${item.error ? ` (${item.error})` : ''}`)
          .join('\n')}`
      : '';
    // Staged planning: for a large goal, plan only the next executable BATCH
    // and declare what remains, rather than emitting one giant brittle plan.
    const batch = state.config.planBatchSize;
    const stagedInstruction =
      batch > 0
        ? `\n\nSTAGED PLANNING: plan AT MOST ${batch} build task(s) in this batch — the next coherent, executable slice ` +
          `of the goal (respecting dependencies). If the goal needs more than that, put a short description of the ` +
          `NOT-yet-planned remainder in "remainingScope"; Kaplan will call you again to plan the next batch once this ` +
          `one is built. If everything fits in this batch, leave "remainingScope" empty.`
        : '';
    const carriedScope = state.pendingScope
      ? `\n\nRESUMING A STAGED PLAN. Already-planned batches are shown above (do NOT re-plan them). ` +
        `Plan the NEXT batch for this remaining scope:\n${state.pendingScope}`
      : '';
    return (
      `Decompose the goal into the SMALLEST set of build tasks that fully achieves it. ` +
      `Each task description must be SELF-CONTAINED (executable without reading the other tasks): ` +
      `say exactly what to change, where, and how to know it is done (acceptance criteria). ` +
      `Order tasks by dependency; use dependsOn for hard orderings; do not create tasks for verification ` +
      `(Kaplan runs the checks itself) or coordination (there is none to do). ` +
      `End with the plan JSON object contract.` +
      stagedInstruction +
      carriedScope +
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
    const stat = changes?.summary ? `+${changes.summary.insertions ?? 0}/-${changes.summary.deletions ?? 0}` : '';
    const diffBlock = changes?.diff?.trim()
      ? `\n\n## Working-tree diff (${changes.files.length} file(s), ${stat})\n\n` +
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
    // Steering is consumed by the plan item created for it — or, when planning
    // is skipped (no plan phase), by the next build turn.
    const state = this.requireState();
    const consumes = item.kind === 'plan' || (state.config.skipPlanning && item.kind === 'build');
    if (!consumes) return undefined;
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

  /** Wait `ms`, resolving early if the run is aborted (rate-limit backoff). */
  private backoff(ms: number): Promise<void> {
    const signal = this.abort?.signal;
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      const onAbort = (): void => done();
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Tear down every live lane (used when the run settles or is stopped). */
  private async reclaimLanes(): Promise<void> {
    if (this.lanes.size === 0) return;
    const workspace = this.state?.workspace;
    if (!workspace) return;
    for (const lane of this.lanes.values()) {
      await cleanupLane(workspace, lane).catch(() => {});
    }
    this.lanes.clear();
  }

  private async onAgentEvent(item: WorkItem, source: RunAgentSource, event: AgentEvent): Promise<void> {
    // Live fan-out of EVERYTHING (the per-agent terminal feed); persist a
    // trimmed copy — raw/stderr noise stays live-only.
    const trimmed: AgentEvent = { ...event, text: event.text?.slice(0, 4000) };
    await this.record(
      {
        type: 'agent',
        itemId: item.id,
        agentId: source.agentId,
        provider: source.provider,
        model: source.model,
        agent: trimmed,
      },
      event.type === 'stderr' || event.type === 'raw',
    );
  }

  // --- state / persistence -----------------------------------------------------

  private async finish(status: RunStatus, message: string): Promise<void> {
    const state = this.requireState();
    // Reclaim any lingering worktree lanes before the run settles so a
    // stop/failure never leaves orphaned worktrees + branches behind.
    await this.reclaimLanes();
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
    // Keep the global history index in step with the durable state (best-effort).
    await upsertRunIndex(state);
    const file = path.join(this.runDir(), 'state.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Unique temp so a stop()-triggered persist() can't collide with the run
    // loop's in-flight persist() on a shared `${file}.tmp`.
    const tmp = `${file}.${process.pid}.${this.persistSeq++}.tmp`;
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

interface CouncilPlanCandidate {
  lens: string;
  provider: AgentType;
  plan: NonNullable<ReturnType<typeof parsePlanResult>>;
}

interface CouncilSeat {
  provider: AgentType;
  model?: string;
  effort?: string;
}

/** Compact seat summary for notes: `claude:opus×2, codex` (count omitted when 1). */
function describeSeats(seats: CouncilSeat[]): string {
  const groups = new Map<string, number>();
  for (const seat of seats) {
    const key = seat.model ? `${seat.provider}:${seat.model}` : seat.provider;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.entries()].map(([key, count]) => (count > 1 ? `${key}×${count}` : key)).join(', ');
}

function clampCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(COUNCIL_MAX, Math.floor(value)));
}

/** Whether an error string looks like a provider rate/quota/overload limit. */
function isRateLimitError(error: string): boolean {
  return /\b(429|rate.?limit|quota|too many requests|overloaded|resource[_ ]exhausted|usage limit)\b/i.test(error);
}

/** Run `tasks` with at most `limit` in flight; preserves input order in the result. */
async function mapWithConcurrency<T>(count: number, limit: number, task: (index: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, count)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= count) return;
      results[index] = await task(index);
    }
  });
  await Promise.all(workers);
  return results;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'fix', 'add']);

/** Content tokens of a title (lowercased, destopped) — the fuzzy-dedup signature. */
function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2 && !STOPWORDS.has(token)),
  );
}

/**
 * Two review findings are "the same issue" when their titles' content tokens
 * overlap heavily: Jaccard ≥ 0.6 AND at least 2 shared content tokens. The
 * two-token floor stops distinct bugs that merely share one noun (e.g. two
 * different defects both about "parseConfig") from being wrongly merged.
 */
function titlesSimilar(a: string, b: string): boolean {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let intersection = 0;
  for (const token of ta) if (tb.has(token)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  return intersection >= 2 && jaccard >= 0.6;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
