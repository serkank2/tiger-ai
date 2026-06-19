import type { AgentType } from '../orchestrator/types.js';
import { evaluateLimitRules } from './rules.js';
import type { LimitRuleDecision, LimitsPersistedState } from './types.js';
import { defaultLimitRules } from './types.js';

export interface LimitGate {
  check(provider: AgentType): Promise<LimitRuleDecision>;
}

interface LimitGateEvaluationOptions {
  now?: Date;
  staleAfterMs?: number;
}

export class StateLimitGate implements LimitGate {
  constructor(
    private readonly getState: () => LimitsPersistedState | undefined,
    private readonly options: LimitGateEvaluationOptions = {},
  ) {}

  async check(provider: AgentType): Promise<LimitRuleDecision> {
    return evaluateLimitGate(this.getState(), provider, this.options);
  }
}

export class AllowAllLimitGate implements LimitGate {
  async check(provider: AgentType): Promise<LimitRuleDecision> {
    return allowDecision(provider, 'no limit gate configured');
  }
}

export class StaticLimitGate implements LimitGate {
  constructor(private readonly decision: LimitRuleDecision) {}

  async check(_provider: AgentType): Promise<LimitRuleDecision> {
    return { ...this.decision };
  }
}

export function evaluateLimitGate(
  state: LimitsPersistedState | undefined,
  provider: AgentType,
  options: LimitGateEvaluationOptions = {},
): LimitRuleDecision {
  // Fail open: if the snapshot source of truth is unavailable (e.g. the limit_snapshots table
  // is missing), allow dispatch instead of conservatively blocking everything forever. The
  // missing table is already logged once at the repository read site.
  if (state?.snapshotsUnavailable) {
    return allowDecision(provider, 'limit snapshot source unavailable; failing open', options.now);
  }

  const rules = (state?.rules?.length ? state.rules : defaultLimitRules()).filter(
    (rule) => rule.enabled && rule.provider === provider && rule.action === 'block',
  );
  if (rules.length === 0) return allowDecision(provider, 'no enabled blocking rule matched provider', options.now);

  return evaluateLimitRules(state?.snapshots ?? [], rules, options);
}

function allowDecision(provider: AgentType, reason: string, now = new Date()): LimitRuleDecision {
  return {
    allowed: true,
    action: 'allow',
    reason: `${provider}: ${reason}`,
    resumeAfter: null,
    conservative: false,
    checkedAt: now.toISOString(),
  };
}
