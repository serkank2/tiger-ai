import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../obs/logger.js';
import type { AppCtx } from '../context.js';
import { configFromObject, loadCueConfig } from './config-loader.js';
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

/** File-change debounce: collapse an editor save's burst of events into one cue fire. */
const FILE_DEBOUNCE_MS = 500;
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
    const watcher = new CueFileWatcher({
      dir,
      debounceMs: FILE_DEBOUNCE_MS,
      onChange: (change) => {
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
    this.lastTeamStatus = this.ctx.teamOrchestrator.tryGetState()?.status ?? null;
    this.onTeamState = (state) => {
      const status = state?.status;
      if (!status) return;
      const wasDone = this.lastTeamStatus === 'completed';
      this.lastTeamStatus = status;
      if (status === 'completed' && !wasDone) {
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
      const file = ws ? path.resolve(ws, sub.promptFile) : sub.promptFile;
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
      enabled: true,
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
