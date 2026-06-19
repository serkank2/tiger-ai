import type { QueueJobConfigSnapshot, QueueJob, QueueLimitSnapshot, QueueProvider, QueueRule, QueueRuleDecision } from './types.js';

type ConcreteProvider = Exclude<QueueProvider, 'mixed'>;

const ALL_CONCRETE_PROVIDERS: ConcreteProvider[] = ['claude', 'codex', 'antigravity'];

/** The concrete providers a job actually uses, derived from the per-stage agent counts. */
function concreteProvidersFromSnapshot(snapshot: QueueJobConfigSnapshot | undefined): ConcreteProvider[] {
  const configs = snapshot?.configs;
  if (!configs) return [];
  const used = new Set<ConcreteProvider>();
  for (const cfg of Object.values(configs)) {
    if (!cfg) continue;
    if ((cfg.claudeAgents ?? 0) > 0) used.add('claude');
    if ((cfg.codexAgents ?? 0) > 0) used.add('codex');
    if ((cfg.antigravityAgents ?? 0) > 0) used.add('antigravity');
  }
  return ALL_CONCRETE_PROVIDERS.filter((provider) => used.has(provider));
}

function providersFor(job: QueueJob): ConcreteProvider[] {
  if (job.provider !== 'mixed') return [job.provider];
  // A `mixed` job only spans the concrete providers its config snapshot actually uses, so a
  // Claude+Codex job (antigravityAgents: 0) is never blocked by a missing Antigravity snapshot.
  // Fall back to every provider only when the snapshot carries no usable agent counts.
  const used = concreteProvidersFromSnapshot(job.configSnapshot);
  return used.length > 0 ? used : ALL_CONCRETE_PROVIDERS;
}

function providerMatches(ruleProvider: QueueRule['provider'], jobProvider: QueueProvider, concreteProvider: ConcreteProvider): boolean {
  return ruleProvider === 'any' || ruleProvider === concreteProvider || ruleProvider === jobProvider;
}

function compare(left: number, operator: QueueRule['operator'], right: number): boolean {
  switch (operator) {
    case 'gte':
      return left >= right;
    case 'gt':
      return left > right;
    case 'lte':
      return left <= right;
    case 'lt':
      return left < right;
    case 'eq':
      return left === right;
  }
}

function applies(rule: QueueRule, jobProvider: QueueProvider, provider: ConcreteProvider): boolean {
  if (!rule.enabled || rule.action !== 'block_dispatch') return false;
  return providerMatches(rule.provider, jobProvider, provider);
}

function missingSnapshotDecision(rule: QueueRule, provider: ConcreteProvider): QueueRuleDecision {
  return {
    allowed: false,
    ruleId: rule.id,
    resumeAfter: null,
    reason: `${provider} limit snapshot is unavailable; queue dispatch is blocked until a fresh probe succeeds.`,
  };
}

export class RuleEngine {
  evaluate(
    job: QueueJob,
    rules: QueueRule[],
    snapshots: Partial<Record<ConcreteProvider, QueueLimitSnapshot | null>>,
    now = new Date(),
  ): QueueRuleDecision {
    for (const provider of providersFor(job)) {
      const snapshot = snapshots[provider] ?? null;
      for (const rule of rules) {
        if (!applies(rule, job.provider, provider)) continue;
        if (!snapshot || snapshot.percentUsed == null) return missingSnapshotDecision(rule, provider);
        if (rule.windowKey !== 'any' && rule.windowKey !== snapshot.windowKey) continue;
        if (snapshot?.resetAt && new Date(snapshot.resetAt).getTime() <= now.getTime()) continue;
        if (!compare(snapshot!.percentUsed!, rule.operator, rule.threshold)) continue;
        const percent = snapshot!.percentUsed!.toFixed(snapshot!.percentUsed! % 1 === 0 ? 0 : 1);
        const resumeAfter = snapshot!.resetAt ?? null;
        return {
          allowed: false,
          ruleId: rule.id,
          resumeAfter,
          reason: `${provider} ${snapshot!.windowKey} usage is ${percent}% (${rule.operator} ${rule.threshold}%).`,
        };
      }
    }
    return {
      allowed: true,
      resumeAfter: null,
      reason: 'No queue limit rule blocked dispatch.',
    };
  }
}
