import { isAgentType } from '../orchestrator/types.js';
import type {
  LimitProvider,
  LimitRule,
  LimitRuleDecision,
  LimitSelectedWindow,
  LimitSnapshot,
} from './types.js';

export const DEFAULT_LIMIT_STALE_AFTER_MS = 15 * 60 * 1000;

/** Input shape accepted by the rules-CRUD endpoints (loose; validated by {@link normalizeRuleInput}). */
export interface LimitRuleInput {
  id?: unknown;
  provider?: unknown;
  windowKey?: unknown;
  thresholdPercent?: unknown;
  enabled?: unknown;
  // `comparison`/`action` are fixed ('gte'/'block') today; accepted but ignored if sent.
  comparison?: unknown;
  action?: unknown;
}

export class LimitRuleValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'LimitRuleValidationError';
  }
}

const VALID_WINDOW_KEYS = new Set(['any', '5h', 'weekly', 'session', 'probe']);

function isValidWindowKey(value: string): boolean {
  return VALID_WINDOW_KEYS.has(value) || value.startsWith('custom:');
}

/**
 * Validate + normalize untrusted CRUD input into a complete {@link LimitRule}. `existing` carries
 * forward immutable/unspecified fields on update (id, createdAt). Throws
 * {@link LimitRuleValidationError} (HTTP 400) on bad input.
 */
export function normalizeRuleInput(
  input: LimitRuleInput,
  existing?: LimitRule,
  now: string = new Date().toISOString(),
): LimitRule {
  const provider = input.provider ?? existing?.provider;
  if (!isAgentType(provider)) {
    throw new LimitRuleValidationError('provider must be one of claude, codex, antigravity');
  }

  const windowKey = (input.windowKey ?? existing?.windowKey ?? 'any') as string;
  if (typeof windowKey !== 'string' || !isValidWindowKey(windowKey)) {
    throw new LimitRuleValidationError(`windowKey "${windowKey}" is not a recognized limit window`);
  }

  const thresholdRaw = input.thresholdPercent ?? existing?.thresholdPercent;
  const thresholdPercent = typeof thresholdRaw === 'string' ? Number(thresholdRaw) : thresholdRaw;
  if (typeof thresholdPercent !== 'number' || !Number.isFinite(thresholdPercent) || thresholdPercent < 0 || thresholdPercent > 100) {
    throw new LimitRuleValidationError('thresholdPercent must be a number between 0 and 100');
  }

  const enabled = input.enabled === undefined ? existing?.enabled ?? true : Boolean(input.enabled);

  const id =
    (typeof input.id === 'string' && input.id.trim()) ||
    existing?.id ||
    `${provider}-${windowKey}-${Math.round(thresholdPercent)}-${Date.now().toString(36)}`;

  return {
    id,
    provider,
    windowKey: windowKey as LimitRule['windowKey'],
    thresholdPercent,
    comparison: 'gte',
    action: 'block',
    enabled,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

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

function selectedWindow(snapshot: LimitSnapshot, stale: boolean): LimitSelectedWindow {
  return {
    provider: snapshot.provider,
    windowKey: snapshot.windowKey,
    label: snapshot.label,
    percentUsed: snapshot.percentUsed,
    resetAt: snapshot.resetAt,
    parseConfidence: snapshot.parseConfidence,
    checkedAt: snapshot.checkedAt,
    stale,
    ok: snapshot.ok,
    error: snapshot.error,
  };
}

function isStale(snapshot: LimitSnapshot, now: Date, staleAfterMs: number): boolean {
  return now.getTime() - toTime(snapshot.checkedAt) > staleAfterMs;
}

function ruleMatches(rule: LimitRule, snapshot: LimitSnapshot): boolean {
  return (
    rule.enabled &&
    snapshot.provider === rule.provider &&
    snapshot.ok &&
    snapshot.percentUsed !== null &&
    (rule.windowKey === 'any' || snapshot.windowKey === rule.windowKey)
  );
}

function defaultAllow(now: Date): LimitRuleDecision {
  return {
    allowed: true,
    action: 'allow',
    reason: 'No active limit rule is blocking execution.',
    resumeAfter: null,
    conservative: false,
    checkedAt: now.toISOString(),
  };
}

function failedProbeDecision(provider: LimitProvider, snapshot: LimitSnapshot, now: Date): LimitRuleDecision {
  return {
    allowed: false,
    action: 'block',
    reason: `${provider} limit probe failed; blocking conservatively until a fresh probe succeeds.`,
    selectedWindow: selectedWindow(snapshot, false),
    resumeAfter: null,
    conservative: true,
    checkedAt: now.toISOString(),
  };
}

function missingSnapshotDecision(rule: LimitRule, now: Date): LimitRuleDecision {
  return {
    allowed: false,
    action: 'block',
    reason: `${rule.provider} limit snapshot is unavailable; blocking conservatively until a probe succeeds.`,
    ruleId: rule.id,
    resumeAfter: null,
    conservative: true,
    checkedAt: now.toISOString(),
  };
}

function staleDecision(rule: LimitRule, snapshot: LimitSnapshot, now: Date): LimitRuleDecision {
  return {
    allowed: false,
    action: 'block',
    reason: `${snapshot.provider} ${snapshot.label} limit snapshot is stale; blocking conservatively until refresh.`,
    ruleId: rule.id,
    selectedWindow: selectedWindow(snapshot, true),
    resumeAfter: null,
    conservative: true,
    checkedAt: now.toISOString(),
  };
}

function thresholdDecision(rule: LimitRule, snapshot: LimitSnapshot, now: Date, stale: boolean): LimitRuleDecision {
  const trustedReset = snapshot.resetAt && snapshot.parseConfidence === 'trusted' ? snapshot.resetAt : null;
  return {
    allowed: false,
    action: 'block',
    reason:
      trustedReset !== null
        ? `${snapshot.provider} ${snapshot.label} is at ${snapshot.percentUsed}% used; resume after reset.`
        : `${snapshot.provider} ${snapshot.label} is at ${snapshot.percentUsed}% used with unknown reset time; blocking conservatively.`,
    ruleId: rule.id,
    selectedWindow: selectedWindow(snapshot, stale),
    resumeAfter: trustedReset,
    conservative: trustedReset === null,
    checkedAt: now.toISOString(),
  };
}

/** A soft usage warning for a single window, surfaced to the UI ahead of any hard block. */
export interface LimitWarning {
  provider: LimitProvider;
  windowKey: LimitSnapshot['windowKey'];
  label: string;
  percentUsed: number;
  level: 'warn' | 'critical';
}

/** Percent-used at/above which a window is flagged 'critical' regardless of warnPercent. */
export const DEFAULT_CRITICAL_PERCENT = 90;
/** Default percent-used at/above which a window is flagged 'warn'. */
export const DEFAULT_WARN_PERCENT = 75;

/**
 * Pure, side-effect-free pass over the latest snapshot per (provider, window) that flags windows
 * approaching their limit. Returns a 'critical' warning for any OK window whose percentUsed is
 * >= 90, otherwise a 'warn' for any whose percentUsed is >= `warnPercent` (default 75). Unlike
 * {@link evaluateLimitRules} this does not block execution — it is purely advisory for the UI.
 * Failed/unparseable snapshots (ok:false or percentUsed === null) are ignored.
 */
export function evaluateLimitWarnings(
  snapshots: LimitSnapshot[],
  opts: { warnPercent?: number } = {},
): LimitWarning[] {
  const warnPercent = opts.warnPercent ?? DEFAULT_WARN_PERCENT;
  const warnings: LimitWarning[] = [];
  for (const snapshot of latestSnapshots(snapshots)) {
    if (!snapshot.ok || snapshot.percentUsed === null) continue;
    const percentUsed = snapshot.percentUsed;
    let level: LimitWarning['level'] | null = null;
    if (percentUsed >= DEFAULT_CRITICAL_PERCENT) level = 'critical';
    else if (percentUsed >= warnPercent) level = 'warn';
    if (!level) continue;
    warnings.push({
      provider: snapshot.provider,
      windowKey: snapshot.windowKey,
      label: snapshot.label,
      percentUsed,
      level,
    });
  }
  return warnings;
}

export function evaluateLimitRules(
  snapshots: LimitSnapshot[],
  rules: LimitRule[],
  options: { now?: Date; staleAfterMs?: number; failOpen?: boolean } = {},
): LimitRuleDecision {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_LIMIT_STALE_AFTER_MS;
  // When failOpen is set, a probe that could not be read (missing / failed / stale) does NOT block:
  // we skip the conservative blocks and only ever block on a fresh, parseable, over-threshold
  // reading. Defaults false so the pure function's behavior is unchanged for direct callers/tests;
  // the production gate passes config.limits.limitFailOpen.
  const failOpen = options.failOpen ?? false;
  const latest = latestSnapshots(snapshots);

  for (const rule of rules.filter((entry) => entry.enabled)) {
    const providerLatest = mostRecent(snapshots.filter((snapshot) => snapshot.provider === rule.provider));
    if (!providerLatest) {
      if (failOpen) continue;
      return missingSnapshotDecision(rule, now);
    }
    if (!providerLatest.ok) {
      const latestOk = mostRecent(latest.filter((snapshot) => ruleMatches(rule, snapshot)));
      if (!latestOk || toTime(providerLatest.checkedAt) >= toTime(latestOk.checkedAt)) {
        if (failOpen) continue;
        return failedProbeDecision(rule.provider, providerLatest, now);
      }
    }

    const candidates = latest.filter((snapshot) => ruleMatches(rule, snapshot));
    if (candidates.length === 0) continue;

    // Prefer fresh windows. A stale, leftover window — e.g. a past misparse that no longer
    // appears in the live probe — must never outrank a fresh reading just because its
    // percentUsed happens to be higher. Only when EVERY matching window is stale do we fall
    // back to the stale pool and block conservatively on staleness.
    const fresh = candidates.filter((snapshot) => !isStale(snapshot, now, staleAfterMs));
    const pool = fresh.length > 0 ? fresh : candidates;
    const selected = pool.reduce((highest, snapshot) =>
      (snapshot.percentUsed ?? -1) > (highest.percentUsed ?? -1) ? snapshot : highest,
    );
    const stale = isStale(selected, now, staleAfterMs);
    if (stale) {
      if (failOpen) continue;
      return staleDecision(rule, selected, now);
    }
    if ((selected.percentUsed ?? 0) >= rule.thresholdPercent) return thresholdDecision(rule, selected, now, stale);
  }

  return defaultAllow(now);
}
