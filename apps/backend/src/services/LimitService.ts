import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import type { TerminalManager } from '../terminal/TerminalManager.js';
import type { PersistedState } from '../store/types.js';
import type { LimitRepository } from '../repositories/LimitRepository.js';
import { probeAllUsage } from '../orchestrator/usage.js';
import type { UsageProbe } from '../orchestrator/usage.js';
import { normalizeUsageProbes } from '../limits/normalize.js';
import {
  DEFAULT_LIMIT_STALE_AFTER_MS,
  evaluateLimitRules,
  normalizeRuleInput,
  LimitRuleValidationError,
  type LimitRuleInput,
} from '../limits/rules.js';
import type { LimitRule } from '../limits/types.js';
import {
  defaultLimitRules,
  type LimitProvider,
  type LimitProviderStatus,
  type LimitSnapshot,
  type LimitStatus,
  type LimitsPersistedState,
} from '../limits/types.js';

export { evaluateLimitRules, LimitRuleValidationError } from '../limits/rules.js';
export type { LimitRuleInput } from '../limits/rules.js';

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
  return [...byKey.values()].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.windowKey.localeCompare(b.windowKey),
  );
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

    // MySQL is the single authoritative source of truth for limit snapshots and rules.
    // The `limits` block in state.json is relegated to a one-time back-compat MIGRATION path:
    // if MySQL has no snapshots yet but state.json carries legacy ones, import them into MySQL,
    // then stop persisting snapshots back to disk (see {@link refreshInner}).
    await this.repository.upsertRules(limits.rules);
    let persisted = await this.repository.load(this.maxSnapshots);
    if (!persisted.snapshotsUnavailable && persisted.snapshots.length === 0 && limits.snapshots.length > 0) {
      await this.repository.insertSnapshots(limits.snapshots);
      persisted = await this.repository.load(this.maxSnapshots);
    }

    this.state.limits = {
      snapshots: persisted.snapshots.length ? persisted.snapshots : limits.snapshots,
      rules: persisted.rules.length ? persisted.rules : limits.rules,
      lastDecision: limits.lastDecision,
      updatedAt: persisted.updatedAt ?? limits.updatedAt,
      ...(persisted.snapshotsUnavailable ? { snapshotsUnavailable: true } : {}),
    };
    if (!persisted.snapshotsUnavailable) await this.repository.upsertRules(this.state.limits.rules);
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
      decision: limits.snapshotsUnavailable
        ? {
            // Snapshot source unavailable: fail open so a missing table never blocks dispatch.
            allowed: true,
            action: 'allow',
            reason: 'Limit snapshot source unavailable; failing open.',
            resumeAfter: null,
            conservative: false,
            checkedAt: now.toISOString(),
          }
        : evaluateLimitRules(limits.snapshots, limits.rules, {
            now,
            staleAfterMs: this.staleAfterMs,
            failOpen: config.limitFailOpen,
          }),
      staleAfterMs: this.staleAfterMs,
      updatedAt: limits.updatedAt,
    };
  }

  // --- Rules CRUD ------------------------------------------------------------
  // MySQL is authoritative; state.limits.rules is the in-memory mirror the gate reads.

  listRules(): LimitRule[] {
    return ensureLimitsState(this.state).rules;
  }

  async createRule(input: LimitRuleInput): Promise<LimitStatus> {
    const rule = normalizeRuleInput(input);
    await this.persistRule(rule, /* isUpdate */ false);
    return this.getState();
  }

  async updateRule(id: string, input: LimitRuleInput): Promise<LimitStatus> {
    const limits = ensureLimitsState(this.state);
    const existing = limits.rules.find((rule) => rule.id === id);
    if (!existing) throw new LimitRuleValidationError(`rule "${id}" not found`);
    const rule = normalizeRuleInput({ ...input, id }, existing);
    await this.persistRule(rule, /* isUpdate */ true);
    return this.getState();
  }

  async deleteRule(id: string): Promise<LimitStatus> {
    const limits = ensureLimitsState(this.state);
    limits.rules = limits.rules.filter((rule) => rule.id !== id);
    await this.repository?.deleteRule(id);
    limits.updatedAt = new Date().toISOString();
    if (!this.repository) await this.save();
    const status = this.getState();
    this.emit('state', status);
    return status;
  }

  private async persistRule(rule: LimitRule, isUpdate: boolean): Promise<void> {
    const limits = ensureLimitsState(this.state);
    const idx = limits.rules.findIndex((existing) => existing.id === rule.id);
    if (isUpdate && idx === -1) throw new LimitRuleValidationError(`rule "${rule.id}" not found`);
    if (idx === -1) limits.rules.push(rule);
    else limits.rules[idx] = rule;
    await this.repository?.upsertRule(rule);
    limits.updatedAt = new Date().toISOString();
    if (!this.repository) await this.save();
    this.emit('state', this.getState());
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

    if (this.repository) {
      // MySQL is authoritative: write snapshots there, then reload the canonical recent window
      // into the in-memory mirror. state.json is NOT used to persist snapshots anymore.
      await this.repository.insertSnapshots(snapshots);
      await this.repository.upsertRules(limits.rules);
      const persisted = await this.repository.load(this.maxSnapshots);
      limits.snapshots = persisted.snapshots;
      limits.rules = persisted.rules.length ? persisted.rules : limits.rules;
      limits.updatedAt = persisted.updatedAt ?? new Date().toISOString();
      if (persisted.snapshotsUnavailable) limits.snapshotsUnavailable = true;
      else delete limits.snapshotsUnavailable;
      limits.lastDecision = this.getState().decision;
    } else {
      // No repository (tests / file-only mode): keep the legacy in-memory + state.json path.
      limits.snapshots.push(...snapshots);
      if (limits.snapshots.length > this.maxSnapshots) {
        limits.snapshots.splice(0, limits.snapshots.length - this.maxSnapshots);
      }
      limits.lastDecision = evaluateLimitRules(limits.snapshots, limits.rules, {
        staleAfterMs: this.staleAfterMs,
        failOpen: config.limitFailOpen,
      });
      limits.updatedAt = new Date().toISOString();
      await this.save();
    }

    const status = this.getState();
    this.emit('state', status);
    return status;
  }
}
