import { EventEmitter } from 'node:events';
import type { TerminalManager } from '../terminal/TerminalManager.js';
import type { PersistedState } from '../store/types.js';
import type { LimitRepository } from '../repositories/LimitRepository.js';
import { probeAllUsage } from '../orchestrator/usage.js';
import type { UsageProbe } from '../orchestrator/usage.js';
import { normalizeUsageProbes } from '../limits/normalize.js';
import { DEFAULT_LIMIT_STALE_AFTER_MS, evaluateLimitRules } from '../limits/rules.js';
import {
  defaultLimitRules,
  type LimitProvider,
  type LimitProviderStatus,
  type LimitSnapshot,
  type LimitStatus,
  type LimitsPersistedState,
} from '../limits/types.js';

export { evaluateLimitRules } from '../limits/rules.js';

type ProbeAllUsage = (manager: TerminalManager, cwd?: string) => Promise<Record<LimitProvider, UsageProbe>>;

export interface LimitServiceOptions {
  manager: TerminalManager;
  state: PersistedState;
  save: () => Promise<void>;
  probe?: ProbeAllUsage;
  repository?: LimitRepository;
  intervalMs?: number;
  staleAfterMs?: number;
  maxSnapshots?: number;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SNAPSHOTS = 500;

function toTime(iso: string | null | undefined): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function mostRecent<T extends { checkedAt: string }>(items: T[]): T | undefined {
  return items.reduce<T | undefined>((latest, item) => {
    if (!latest) return item;
    return toTime(item.checkedAt) >= toTime(latest.checkedAt) ? item : latest;
  }, undefined);
}

function latestSnapshots(snapshots: LimitSnapshot[]): LimitSnapshot[] {
  const byKey = new Map<string, LimitSnapshot>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.provider}:${snapshot.windowKey}`;
    const current = byKey.get(key);
    if (!current || toTime(snapshot.checkedAt) >= toTime(current.checkedAt)) byKey.set(key, snapshot);
  }
  return [...byKey.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.windowKey.localeCompare(b.windowKey));
}

function ensureLimitsState(state: PersistedState): LimitsPersistedState {
  const current = state.limits;
  if (!current) {
    state.limits = { snapshots: [], rules: defaultLimitRules() };
    return state.limits;
  }
  if (!Array.isArray(current.snapshots)) current.snapshots = [];
  if (!Array.isArray(current.rules) || current.rules.length === 0) current.rules = defaultLimitRules();
  return current;
}

function failedProbe(type: LimitProvider, message: string, checkedAt: string): UsageProbe {
  return { type, ok: false, entries: [], raw: '', highlights: [], error: message, checkedAt };
}

function providerStatus(provider: LimitProvider, latest: LimitSnapshot[]): LimitProviderStatus {
  const providerSnapshots = latest.filter((snapshot) => snapshot.provider === provider);
  const latestAny = mostRecent(providerSnapshots);
  const failed = latestAny && !latestAny.ok ? latestAny : undefined;
  return {
    provider,
    latest: providerSnapshots,
    latestCheckedAt: latestAny?.checkedAt ?? null,
    ok: providerSnapshots.some((snapshot) => snapshot.ok),
    error: failed?.error,
  };
}

export class LimitService extends EventEmitter {
  private readonly manager: TerminalManager;
  private readonly state: PersistedState;
  private readonly save: () => Promise<void>;
  private readonly probe: ProbeAllUsage;
  private readonly repository?: LimitRepository;
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly maxSnapshots: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<LimitStatus> | null = null;

  constructor(options: LimitServiceOptions) {
    super();
    this.manager = options.manager;
    this.state = options.state;
    this.save = options.save;
    this.probe = options.probe ?? probeAllUsage;
    this.repository = options.repository;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_LIMIT_STALE_AFTER_MS;
    this.maxSnapshots = options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS;
    ensureLimitsState(this.state);
  }

  async initialize(): Promise<void> {
    const limits = ensureLimitsState(this.state);
    if (!this.repository) return;

    await this.repository.upsertRules(limits.rules);
    let persisted = await this.repository.load(this.maxSnapshots);
    if (persisted.snapshots.length === 0 && limits.snapshots.length > 0) {
      await this.repository.insertSnapshots(limits.snapshots);
      persisted = await this.repository.load(this.maxSnapshots);
    }

    this.state.limits = {
      snapshots: persisted.snapshots.length ? persisted.snapshots : limits.snapshots,
      rules: persisted.rules.length ? persisted.rules : limits.rules,
      lastDecision: limits.lastDecision,
      updatedAt: persisted.updatedAt ?? limits.updatedAt,
    };
    await this.repository.upsertRules(this.state.limits.rules);
    await this.save();
  }

  start(): void {
    if (this.timer || this.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      this.refresh('cadence').catch((err) => {
        console.error('[limits] scheduled refresh failed:', err);
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  getState(now = new Date()): LimitStatus {
    const limits = ensureLimitsState(this.state);
    const latest = latestSnapshots(limits.snapshots);
    return {
      snapshots: limits.snapshots,
      latest,
      providers: {
        claude: providerStatus('claude', latest),
        codex: providerStatus('codex', latest),
        antigravity: providerStatus('antigravity', latest),
      },
      rules: limits.rules,
      decision: evaluateLimitRules(limits.snapshots, limits.rules, { now, staleAfterMs: this.staleAfterMs }),
      staleAfterMs: this.staleAfterMs,
      updatedAt: limits.updatedAt,
    };
  }

  async refresh(_source: 'manual' | 'cadence' | 'legacy' = 'manual'): Promise<LimitStatus> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refreshInner().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  toLegacyUsage(status = this.getState()): Record<LimitProvider, UsageProbe> {
    const makeProbe = (provider: LimitProvider): UsageProbe => {
      const providerSnapshots = status.latest.filter((snapshot) => snapshot.provider === provider);
      const latestAny = mostRecent(providerSnapshots);
      return {
        type: provider,
        ok: providerSnapshots.some((snapshot) => snapshot.ok),
        entries: providerSnapshots
          .filter((snapshot) => snapshot.ok && snapshot.percentUsed !== null && snapshot.metricRaw)
          .map((snapshot) => ({
            label: snapshot.label,
            percent: snapshot.metricRaw?.percent ?? snapshot.percentUsed ?? 0,
            metric: snapshot.metricRaw?.metric ?? 'used',
            reset: snapshot.resetText,
            percentUsed: snapshot.percentUsed ?? 0,
            windowKey: snapshot.windowKey,
            resetAt: snapshot.resetAt,
            parseConfidence: snapshot.parseConfidence,
          })),
        raw: latestAny?.rawPanel ?? '',
        highlights: [],
        error: latestAny && !latestAny.ok ? latestAny.error : undefined,
        checkedAt: latestAny?.checkedAt ?? new Date(0).toISOString(),
      };
    };
    return { claude: makeProbe('claude'), codex: makeProbe('codex'), antigravity: makeProbe('antigravity') };
  }

  private async refreshInner(): Promise<LimitStatus> {
    const checkedAt = new Date().toISOString();
    let probes: Record<LimitProvider, UsageProbe>;
    try {
      probes = await this.probe(this.manager);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      probes = {
        claude: failedProbe('claude', message, checkedAt),
        codex: failedProbe('codex', message, checkedAt),
        antigravity: failedProbe('antigravity', message, checkedAt),
      };
    }

    const snapshots = normalizeUsageProbes(probes);
    const limits = ensureLimitsState(this.state);
    await this.repository?.insertSnapshots(snapshots);
    await this.repository?.upsertRules(limits.rules);
    limits.snapshots.push(...snapshots);
    if (limits.snapshots.length > this.maxSnapshots) {
      limits.snapshots.splice(0, limits.snapshots.length - this.maxSnapshots);
    }
    limits.lastDecision = evaluateLimitRules(limits.snapshots, limits.rules, { staleAfterMs: this.staleAfterMs });
    limits.updatedAt = new Date().toISOString();
    await this.save();

    const status = this.getState();
    this.emit('state', status);
    return status;
  }
}
