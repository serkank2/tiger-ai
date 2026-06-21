import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../obs/logger.js';
import { config } from '../config.js';
import type { AppCtx } from '../context.js';
import {
  configFromObject,
  loadCueConfig,
  readRawCueConfig,
  validateSubscriptionStrict,
  writeCueConfig,
} from './config-loader.js';
import { CueFileWatcher } from './file-watcher.js';
import { FanInTracker } from './fanin.js';
import { matchesFilter } from './matching.js';
import { renderPrompt } from './template.js';
import { MIN_INTERVAL_MS, msUntil, parseIntervalSpec } from './schedule.js';
import type {
  CueConfigFile,
  CueEngineStatus,
  CueEventPayload,
  CueSubscription,
  CueSubscriptionStatus,
} from './types.js';

const log = logger.child({ mod: 'cue.engine' });

/** A bad UI edit (validation/duplicate/no-workspace) — maps to a 400/409 in the route. */
export class CueConfigError extends Error {}
/** A referenced subscription does not exist — maps to a 404 in the route. */
export class CueNotFoundError extends Error {}

/** File-change debounce: collapse an editor save's burst of events into one cue fire. */
const FILE_DEBOUNCE_MS = 500;
/**
 * Minimum gap between two fires of the SAME file.changed subscription. The debounce only collapses
 * a single burst; without a cooldown, a subscription whose target writes back under the watched dir
 * re-triggers itself in a hot loop. This caps the self-retrigger rate.
 */
const FILE_REFIRE_COOLDOWN_MS = 10_000;
/** Cap how much upstream output we read for an agent.completed payload. */
const SOURCE_OUTPUT_READ_MAX = 8000;

interface SubRuntime {
  sub: CueSubscription;
  lastFiredAt: string | null;
  fireCount: number;
  lastError: string | null;
  watcher?: CueFileWatcher;
  interval?: ReturnType<typeof setInterval>;
  timeout?: ReturnType<typeof setTimeout>;
  fanIn?: FanInTracker;
}

export interface CueEngineOptions {
  ctx: AppCtx;
  /** When set, the engine watches/acts against this workspace. Falls back to the active Tiger project. */
  workspace?: string | null;
  /** Override the on-disk config with an in-memory one (tests / programmatic use). */
  config?: CueConfigFile;
}

/**
 * The event-driven orchestration engine. It loads declarative subscriptions, attaches the right
 * watcher per event type, and on a matching event renders the subscription's prompt and dispatches
 * it to a target action (queue enqueue or team steering). OFF by default — only constructed and
 * started when `config.cue.enabled` is set (see index.ts).
 */
export class CueEngine {
  private readonly ctx: AppCtx;
  private workspace: string | null;
  private readonly overrideConfig?: CueConfigFile;
  private configPath: string | null = null;
  private running = false;
  private subs = new Map<string, SubRuntime>();
  private warnings: string[] = [];

  // Bound orchestrator listeners (so we can detach cleanly on stop).
  private onTeamState?: (state: { runId: string; status: string }) => void;
  private onTigerState?: (state: { currentStage: string | null; stages: Record<string, { status: string }> }) => void;
  private lastTeamStatus: string | null = null;
  /** RunIds whose `completed` we have already fired on — keyed so back-to-back runs both fire. */
  private firedTeamRunIds = new Set<string>();
  private lastTigerStageStatus = new Map<string, string>();

  constructor(opts: CueEngineOptions) {
    this.ctx = opts.ctx;
    this.workspace = opts.workspace ?? null;
    this.overrideConfig = opts.config;
  }

  /** Resolve the workspace: explicit override, else the active Tiger project workspace. */
  private resolveWorkspace(): string | null {
    if (this.workspace) return this.workspace;
    try {
      return this.ctx.orchestrator.getState().workspace ?? null;
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.loadAndAttach();
    this.attachAgentListeners();
    log.info('cue engine started', { workspace: this.workspace, subscriptions: this.subs.size });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.detachAllWatchers();
    this.detachAgentListeners();
    log.info('cue engine stopped');
  }

  /** Reload the config from disk (or the override) and re-attach watchers. */
  async reload(): Promise<CueEngineStatus> {
    this.detachAllWatchers();
    await this.loadAndAttach();
    return this.getStatus();
  }

  /** Read the full editable subscription (all fields) from `.kaplan/cue.json`, or null if unknown. */
  async getEditableSubscription(id: string): Promise<CueSubscription | null> {
    const ws = this.resolveWorkspace();
    if (!ws) return null;
    const { config: file } = await readRawCueConfig(ws);
    return file.subscriptions.find((s) => s.id === id) ?? null;
  }

  /** Resolve the workspace the editor writes `.kaplan/cue.json` into, or throw a clear error. */
  private requireWriteWorkspace(): string {
    const ws = this.resolveWorkspace();
    if (!ws) {
      throw new CueConfigError('no active workspace; open a project before editing cue subscriptions');
    }
    return ws;
  }

  /**
   * Create or update a subscription via the UI editor: strictly validates it, rewrites
   * `.kaplan/cue.json`, then reloads so watchers/schedules reflect the change immediately.
   * When `expectId` is given the matching entry is replaced (rename allowed); otherwise the new
   * id must not already exist. Returns the saved subscription plus the fresh engine status.
   */
  async saveSubscription(
    raw: unknown,
    expectId?: string,
  ): Promise<{ subscription: CueSubscription; status: CueEngineStatus }> {
    const { sub, errors } = validateSubscriptionStrict(raw);
    if (!sub) throw new CueConfigError(`invalid subscription: ${errors.join('; ')}`);
    const ws = this.requireWriteWorkspace();
    const { config: file } = await readRawCueConfig(ws);
    const list = file.subscriptions;
    const existingIndex = list.findIndex((s) => s.id === sub.id);
    if (expectId) {
      const targetIndex = list.findIndex((s) => s.id === expectId);
      if (targetIndex < 0) throw new CueNotFoundError(`subscription "${expectId}" not found`);
      // A rename must not collide with a different existing entry.
      if (sub.id !== expectId && existingIndex >= 0) {
        throw new CueConfigError(`subscription id "${sub.id}" already exists`);
      }
      list[targetIndex] = sub;
    } else {
      if (existingIndex >= 0) throw new CueConfigError(`subscription id "${sub.id}" already exists`);
      list.push(sub);
    }
    await writeCueConfig(ws, file);
    const status = await this.reload();
    return { subscription: sub, status };
  }

  /** Delete a subscription from `.kaplan/cue.json` and reload. Throws if the id is unknown. */
  async deleteSubscription(id: string): Promise<CueEngineStatus> {
    const ws = this.requireWriteWorkspace();
    const { config: file } = await readRawCueConfig(ws);
    const next = file.subscriptions.filter((s) => s.id !== id);
    if (next.length === file.subscriptions.length) throw new CueNotFoundError(`subscription "${id}" not found`);
    await writeCueConfig(ws, { subscriptions: next });
    return this.reload();
  }

  private async loadAndAttach(): Promise<void> {
    this.workspace = this.resolveWorkspace();
    const result = this.overrideConfig
      ? configFromObject(this.overrideConfig)
      : this.workspace
        ? await loadCueConfig(this.workspace)
        : { subscriptions: [], warnings: ['no active workspace; cue config not loaded'], configPath: null };
    this.configPath = result.configPath;
    this.warnings = result.warnings;
    for (const w of result.warnings) log.warn('cue config warning', { warning: w });

    this.subs = new Map();
    for (const sub of result.subscriptions) {
      const rt: SubRuntime = { sub, lastFiredAt: null, fireCount: 0, lastError: null };
      if (sub.event === 'agent.completed' && sub.filter?.allOf?.length) {
        rt.fanIn = new FanInTracker(sub.filter.allOf);
      }
      this.subs.set(sub.id, rt);
      if (sub.enabled !== false) this.attachWatcher(rt);
    }
  }

  // --- per-subscription watcher wiring ---

  private attachWatcher(rt: SubRuntime): void {
    const { sub } = rt;
    try {
      switch (sub.event) {
        case 'file.changed':
          this.attachFileWatcher(rt);
          break;
        case 'time.scheduled':
          this.attachInterval(rt);
          break;
        case 'time.once':
          this.attachOnce(rt);
          break;
        // agent.completed + cli.trigger are driven centrally (listeners / REST), not per-sub timers.
        case 'agent.completed':
        case 'cli.trigger':
          break;
      }
    } catch (err) {
      // A single bad subscription must never crash startup.
      rt.lastError = err instanceof Error ? err.message : String(err);
      log.warn('cue subscription attach failed', { id: sub.id, err });
    }
  }

  private attachFileWatcher(rt: SubRuntime): void {
    const ws = this.workspace;
    if (!ws) return;
    const dir = path.resolve(ws, rt.sub.watch ?? '.');
    // The directory this subscription's own action writes to. A change under it is almost
    // certainly produced by the fire it triggered, so skipping it breaks the self-feedback loop.
    const outputDir = this.outputTargetDir(rt.sub);
    const watcher = new CueFileWatcher({
      dir,
      debounceMs: FILE_DEBOUNCE_MS,
      onChange: (change) => {
        if (outputDir && isPathInside(outputDir, change.path)) return;
        void this.dispatchIfMatch(rt, {
          event: 'file.changed',
          filePath: change.path,
          changeType: change.changeType,
        });
      },
    });
    watcher.start();
    rt.watcher = watcher;
  }

  /** Resolve the directory a subscription writes its output under (for self-retrigger suppression). */
  private outputTargetDir(sub: CueSubscription): string | null {
    if (sub.target.kind !== 'queue') return null; // team steering writes nothing to the watched FS
    const dest = sub.target.workspacePath ?? this.workspace;
    return dest ? path.resolve(dest) : null;
  }

  private attachInterval(rt: SubRuntime): void {
    const ms = parseIntervalSpec(rt.sub.intervalMs ?? rt.sub.watch);
    if (ms == null) {
      rt.lastError = 'invalid interval spec';
      log.warn('cue time.scheduled: invalid interval', { id: rt.sub.id, spec: rt.sub.intervalMs ?? rt.sub.watch });
      return;
    }
    rt.interval = setInterval(() => {
      void this.dispatchIfMatch(rt, { event: 'time.scheduled' });
    }, Math.max(MIN_INTERVAL_MS, ms));
    // Don't keep the process alive purely for a cue timer.
    rt.interval.unref?.();
  }

  private attachOnce(rt: SubRuntime): void {
    const at = rt.sub.at ? new Date(rt.sub.at).getTime() : NaN;
    if (!Number.isFinite(at)) {
      rt.lastError = 'invalid "at" timestamp';
      log.warn('cue time.once: invalid at', { id: rt.sub.id, at: rt.sub.at });
      return;
    }
    // A one-shot whose time already passed must NOT re-fire on every start()/reload(): the
    // in-memory self-disable below is lost when reload() rebuilds subs from config. Treat a past
    // `at` as already-fired and skip it (a fresh future `at` is required to re-arm it).
    if (at <= Date.now()) {
      rt.sub = { ...rt.sub, enabled: false };
      log.debug('cue time.once is stale; skipped', { id: rt.sub.id, at: rt.sub.at });
      return;
    }
    const ms = msUntil(rt.sub.at);
    if (ms == null) {
      rt.lastError = 'invalid "at" timestamp';
      log.warn('cue time.once: invalid at', { id: rt.sub.id, at: rt.sub.at });
      return;
    }
    rt.timeout = setTimeout(() => {
      void this.dispatchIfMatch(rt, { event: 'time.once' });
      // Self-remove: a one-shot disables itself after firing.
      const live = this.subs.get(rt.sub.id);
      if (live) live.sub = { ...live.sub, enabled: false };
    }, ms);
    rt.timeout.unref?.();
  }

  // --- orchestrator completion listeners (agent.completed) ---

  private attachAgentListeners(): void {
    const initial = this.ctx.teamOrchestrator.tryGetState();
    this.lastTeamStatus = initial?.status ?? null;
    // Seed the watermark for an already-completed run so we don't re-fire it on attach.
    if (initial?.status === 'completed' && initial.runId) this.firedTeamRunIds.add(initial.runId);
    this.onTeamState = (state) => {
      const status = state?.status;
      if (!status) return;
      this.lastTeamStatus = status;
      // Fire once per runId reaching completed. A single global "was previously completed" flag
      // would suppress a second run that completes right after the first (both share status text).
      if (status === 'completed' && state.runId && !this.firedTeamRunIds.has(state.runId)) {
        this.firedTeamRunIds.add(state.runId);
        void this.onAgentCompleted('team', state.runId);
      }
    };
    this.ctx.teamOrchestrator.on('state', this.onTeamState as (s: unknown) => void);

    this.onTigerState = (state) => {
      const stages = state?.stages ?? {};
      for (const [stageId, stage] of Object.entries(stages)) {
        const prev = this.lastTigerStageStatus.get(stageId);
        this.lastTigerStageStatus.set(stageId, stage.status);
        if (stage.status === 'completed' && prev && prev !== 'completed') {
          void this.onAgentCompleted('tiger', stageId);
        }
      }
    };
    this.ctx.orchestrator.on('state', this.onTigerState as (s: unknown) => void);
  }

  private detachAgentListeners(): void {
    if (this.onTeamState) this.ctx.teamOrchestrator.off('state', this.onTeamState as (s: unknown) => void);
    if (this.onTigerState) this.ctx.orchestrator.off('state', this.onTigerState as (s: unknown) => void);
    this.onTeamState = undefined;
    this.onTigerState = undefined;
  }

  /**
   * An orchestrator reported a completion. Route to every `agent.completed` subscription, honoring
   * the source filter and fan-in accounting (a fan-in sub fires once all its named sources land).
   */
  private async onAgentCompleted(triggeredBy: 'team' | 'tiger', source: string): Promise<void> {
    const sourceOutput = await this.readSourceOutput(triggeredBy, source);
    for (const rt of this.subs.values()) {
      if (rt.sub.event !== 'agent.completed' || rt.sub.enabled === false) continue;
      const payload: CueEventPayload = {
        event: 'agent.completed',
        source,
        sourceOutput,
        extra: { triggeredBy },
      };
      if (!matchesFilter(rt.sub, payload)) continue;
      if (rt.fanIn && !rt.fanIn.isTrivial) {
        const ready = rt.fanIn.record(source);
        if (!ready) {
          log.debug('cue fan-in waiting', { id: rt.sub.id, pending: rt.fanIn.pending() });
          continue;
        }
        rt.fanIn.reset();
      }
      await this.fire(rt, payload);
    }
  }

  /** Best-effort read of an upstream agent's recent output for the {{CUE_SOURCE_OUTPUT}} var. */
  private async readSourceOutput(triggeredBy: 'team' | 'tiger', source: string): Promise<string> {
    try {
      if (triggeredBy === 'team') {
        const state = this.ctx.teamOrchestrator.tryGetState();
        return state?.message ?? `Team run ${source} completed.`;
      }
      return `Tiger stage ${source} completed.`;
    } catch {
      return '';
    } finally {
      void SOURCE_OUTPUT_READ_MAX;
    }
  }

  // --- manual trigger (cli.trigger) ---

  /** Fire a `cli.trigger` subscription by id. Throws via the route layer when not found/eligible. */
  async triggerManual(id: string, extra?: Record<string, string>): Promise<CueSubscriptionStatus> {
    const rt = this.subs.get(id);
    if (!rt) throw new Error(`cue subscription not found: ${id}`);
    if (rt.sub.event !== 'cli.trigger') throw new Error(`subscription "${id}" is not a cli.trigger`);
    if (rt.sub.enabled === false) throw new Error(`subscription "${id}" is disabled`);
    await this.fire(rt, { event: 'cli.trigger', ...(extra ? { extra } : {}) });
    return this.statusOf(rt);
  }

  // --- core dispatch ---

  private async dispatchIfMatch(rt: SubRuntime, payload: CueEventPayload): Promise<void> {
    if (!this.running || rt.sub.enabled === false) return;
    if (!matchesFilter(rt.sub, payload)) return;
    // Per-subscription cooldown for file.changed: even with debounce + output-dir skipping, a chain
    // of edits under the watched dir could re-fire rapidly. Enforce a minimum gap between fires.
    if (rt.sub.event === 'file.changed' && rt.lastFiredAt) {
      const sinceLast = Date.now() - new Date(rt.lastFiredAt).getTime();
      if (sinceLast < FILE_REFIRE_COOLDOWN_MS) {
        log.debug('cue file.changed within cooldown; skipped', { id: rt.sub.id, sinceLast });
        return;
      }
    }
    await this.fire(rt, payload);
  }

  /** Render the prompt and route it to the subscription's target. Errors are captured, not thrown. */
  private async fire(rt: SubRuntime, payload: CueEventPayload): Promise<void> {
    try {
      const template = await this.resolveTemplate(rt.sub);
      const prompt = renderPrompt(template, payload);
      if (!prompt.trim()) {
        rt.lastError = 'rendered prompt is empty';
        return;
      }
      await this.dispatchToTarget(rt.sub, prompt);
      rt.lastFiredAt = new Date().toISOString();
      rt.fireCount += 1;
      rt.lastError = null;
      log.info('cue fired', { id: rt.sub.id, event: rt.sub.event, target: rt.sub.target.kind });
    } catch (err) {
      rt.lastError = err instanceof Error ? err.message : String(err);
      // Never let a dispatch failure propagate into a watcher/timer/listener callback.
      log.warn('cue fire failed', { id: rt.sub.id, err });
    }
  }

  private async resolveTemplate(sub: CueSubscription): Promise<string> {
    if (sub.prompt) return sub.prompt;
    if (sub.promptFile) {
      const ws = this.workspace;
      const file = ws ? path.resolve(ws, sub.promptFile) : path.resolve(sub.promptFile);
      // Containment: a `promptFile` with `../` segments must not escape the workspace and read an
      // arbitrary host file into a prompt. Only enforce when we have a workspace to anchor to.
      if (ws && !isPathInside(ws, file)) {
        throw new Error(`promptFile escapes the workspace: ${sub.promptFile}`);
      }
      return fs.readFile(file, 'utf8');
    }
    return '';
  }

  private async dispatchToTarget(sub: CueSubscription, prompt: string): Promise<void> {
    const target = sub.target;
    if (target.kind === 'queue') {
      await this.ctx.queueService.enqueue({
        prompt,
        ...(target.workspacePath ? { workspacePath: target.workspacePath } : this.workspace ? { workspacePath: this.workspace } : {}),
        ...(target.projectName ? { projectName: target.projectName } : { projectName: `Cue: ${sub.name ?? sub.id}` }),
        ...(target.provider ? { provider: target.provider } : {}),
        ...(target.priority !== undefined ? { priority: target.priority } : {}),
        ...(target.maxAttempts !== undefined ? { maxAttempts: target.maxAttempts } : {}),
      });
      return;
    }
    // team steering: only valid while a steerable run is live. A failure here is captured by fire().
    await this.ctx.teamOrchestrator.steer(prompt);
  }

  // --- status ---

  private statusOf(rt: SubRuntime): CueSubscriptionStatus {
    return {
      id: rt.sub.id,
      name: rt.sub.name ?? null,
      event: rt.sub.event,
      target: rt.sub.target.kind,
      enabled: rt.sub.enabled !== false,
      lastFiredAt: rt.lastFiredAt,
      fireCount: rt.fireCount,
      lastError: rt.lastError,
      ...(rt.fanIn && !rt.fanIn.isTrivial ? { pendingSources: rt.fanIn.pending() } : {}),
    };
  }

  getStatus(): CueEngineStatus {
    return {
      enabled: config.cue.enabled,
      running: this.running,
      workspace: this.workspace,
      configPath: this.configPath,
      subscriptions: [...this.subs.values()].map((rt) => this.statusOf(rt)),
    };
  }

  /** Snapshot of config-load warnings (surfaced for diagnostics). */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  private detachAllWatchers(): void {
    for (const rt of this.subs.values()) {
      rt.watcher?.close();
      if (rt.interval) clearInterval(rt.interval);
      if (rt.timeout) clearTimeout(rt.timeout);
      rt.watcher = undefined;
      rt.interval = undefined;
      rt.timeout = undefined;
    }
  }
}

/**
 * True when `child` is the same path as, or nested inside, `parent`. Segment-aware (so `/a/foobar`
 * is NOT inside `/a/foo`) and rejects `..` escapes. Both inputs should be resolved+normalized.
 */
export function isPathInside(parent: string, child: string): boolean {
  if (!parent) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}
