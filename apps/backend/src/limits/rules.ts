import type {
  LimitProvider,
  LimitRule,
  LimitRuleDecision,
  LimitSelectedWindow,
  LimitSnapshot,
} from './types.js';

export const DEFAULT_LIMIT_STALE_AFTER_MS = 15 * 60 * 1000;

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

export function evaluateLimitRules(
  snapshots: LimitSnapshot[],
  rules: LimitRule[],
  options: { now?: Date; staleAfterMs?: number } = {},
): LimitRuleDecision {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_LIMIT_STALE_AFTER_MS;
  const latest = latestSnapshots(snapshots);

  for (const rule of rules.filter((entry) => entry.enabled)) {
    const providerLatest = mostRecent(snapshots.filter((snapshot) => snapshot.provider === rule.provider));
    if (!providerLatest) return missingSnapshotDecision(rule, now);
    if (!providerLatest.ok) {
      const latestOk = mostRecent(latest.filter((snapshot) => ruleMatches(rule, snapshot)));
      if (!latestOk || toTime(providerLatest.checkedAt) >= toTime(latestOk.checkedAt)) {
        return failedProbeDecision(rule.provider, providerLatest, now);
      }
    }

    const candidates = latest.filter((snapshot) => ruleMatches(rule, snapshot));
    if (candidates.length === 0) continue;

    const selected = candidates.reduce((highest, snapshot) =>
      (snapshot.percentUsed ?? -1) > (highest.percentUsed ?? -1) ? snapshot : highest,
    );
    const stale = isStale(selected, now, staleAfterMs);
    if (stale) return staleDecision(rule, selected, now);
    if ((selected.percentUsed ?? 0) >= rule.thresholdPercent) return thresholdDecision(rule, selected, now, stale);
  }

  return defaultAllow(now);
}
