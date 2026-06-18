import type { AgentType } from '../orchestrator/types.js';

export type LimitProvider = AgentType;
export type LimitWindowKey = '5h' | 'weekly' | 'session' | `custom:${string}` | 'probe';
export type LimitParseConfidence = 'trusted' | 'unknown';

export interface LimitMetricRaw {
  percent: number;
  metric: 'used' | 'left';
}

export interface LimitSnapshot {
  id: string;
  provider: LimitProvider;
  windowKey: LimitWindowKey;
  label: string;
  percentUsed: number | null;
  metricRaw: LimitMetricRaw | null;
  resetText: string | null;
  resetAt: string | null;
  ok: boolean;
  error?: string;
  rawPanel: string;
  parseConfidence: LimitParseConfidence;
  checkedAt: string;
}

export interface LimitRule {
  id: string;
  provider: LimitProvider;
  windowKey: LimitWindowKey | 'any';
  thresholdPercent: number;
  comparison: 'gte';
  action: 'block';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LimitSelectedWindow {
  provider: LimitProvider;
  windowKey: LimitWindowKey;
  label: string;
  percentUsed: number | null;
  resetAt: string | null;
  parseConfidence: LimitParseConfidence;
  checkedAt: string;
  stale: boolean;
  ok: boolean;
  error?: string;
}

export interface LimitRuleDecision {
  allowed: boolean;
  action: 'allow' | 'block';
  reason: string;
  ruleId?: string;
  selectedWindow?: LimitSelectedWindow;
  resumeAfter: string | null;
  conservative: boolean;
  checkedAt: string;
}

export interface LimitsPersistedState {
  snapshots: LimitSnapshot[];
  rules: LimitRule[];
  lastDecision?: LimitRuleDecision;
  updatedAt?: string;
}

export interface LimitProviderStatus {
  provider: LimitProvider;
  latest: LimitSnapshot[];
  latestCheckedAt: string | null;
  ok: boolean;
  error?: string;
}

export interface LimitStatus {
  snapshots: LimitSnapshot[];
  latest: LimitSnapshot[];
  providers: Record<LimitProvider, LimitProviderStatus>;
  rules: LimitRule[];
  decision: LimitRuleDecision;
  staleAfterMs: number;
  updatedAt?: string;
}

export function defaultLimitRules(now = new Date().toISOString()): LimitRule[] {
  return [
    {
      id: 'claude-percent-used-90',
      provider: 'claude',
      windowKey: 'any',
      thresholdPercent: 90,
      comparison: 'gte',
      action: 'block',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
}
