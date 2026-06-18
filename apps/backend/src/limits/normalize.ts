import { nanoid } from 'nanoid';
import type { UsageEntry, UsageProbe } from '../orchestrator/usage.js';
import { parseResetText, type ResetParseOptions } from './resetParse.js';
import type { LimitProvider, LimitSnapshot, LimitWindowKey } from './types.js';

export interface NormalizeOptions extends ResetParseOptions {
  snapshotId?: () => string;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function percentUsedFromEntry(entry: Pick<UsageEntry, 'percent' | 'metric'>): number {
  const raw = clampPercent(entry.percent);
  return entry.metric === 'left' ? clampPercent(100 - raw) : raw;
}

function slugLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'usage';
}

export function classifyLimitWindow(label: string): LimitWindowKey {
  const clean = label.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/\b5\s*h\b|\bfive\s*hour\b|\b5-hour\b/.test(clean)) return '5h';
  if (/\bweek(?:ly)?\b|\bcurrent week\b/.test(clean)) return 'weekly';
  if (/\bsession\b|\bcurrent session\b/.test(clean)) return 'session';
  return `custom:${slugLabel(clean)}`;
}

function normalizedLabel(entry: UsageEntry, windowKey: LimitWindowKey): string {
  const label = entry.label.replace(/\s+/g, ' ').trim();
  if (label) return label;
  if (windowKey === '5h') return '5h limit';
  if (windowKey === 'weekly') return 'Weekly limit';
  if (windowKey === 'session') return 'Current session';
  return 'Usage';
}

function entryScore(snapshot: LimitSnapshot): number {
  let score = 0;
  if (snapshot.ok) score += 10;
  if (snapshot.resetAt && snapshot.parseConfidence === 'trusted') score += 5;
  if (snapshot.percentUsed !== null) score += 2;
  return score;
}

function betterSnapshot(a: LimitSnapshot, b: LimitSnapshot): LimitSnapshot {
  const scoreA = entryScore(a);
  const scoreB = entryScore(b);
  if (scoreA !== scoreB) return scoreA > scoreB ? a : b;
  const usedA = a.percentUsed ?? -1;
  const usedB = b.percentUsed ?? -1;
  return usedA >= usedB ? a : b;
}

export function normalizeUsageProbe(probe: UsageProbe, options: NormalizeOptions = {}): LimitSnapshot[] {
  const makeId = options.snapshotId ?? (() => `limit_${nanoid(12)}`);
  const checkedAt = probe.checkedAt || new Date().toISOString();
  if (!probe.ok || probe.entries.length === 0) {
    return [
      {
        id: makeId(),
        provider: probe.type,
        windowKey: 'probe',
        label: 'Probe',
        percentUsed: null,
        metricRaw: null,
        resetText: null,
        resetAt: null,
        ok: false,
        error: probe.error ?? (probe.entries.length === 0 ? 'no usage entries parsed' : undefined),
        rawPanel: probe.raw,
        parseConfidence: 'unknown',
        checkedAt,
      },
    ];
  }

  const byWindow = new Map<LimitWindowKey, LimitSnapshot>();
  for (const entry of probe.entries) {
    const windowKey = classifyLimitWindow(entry.label);
    const reset = parseResetText(entry.reset, { now: options.now, defaultTimeZone: options.defaultTimeZone });
    const snapshot: LimitSnapshot = {
      id: makeId(),
      provider: probe.type,
      windowKey,
      label: normalizedLabel(entry, windowKey),
      percentUsed: percentUsedFromEntry(entry),
      metricRaw: {
        percent: clampPercent(entry.percent),
        metric: entry.metric,
      },
      resetText: entry.reset,
      resetAt: reset.resetAt,
      ok: true,
      rawPanel: probe.raw,
      parseConfidence: reset.parseConfidence,
      checkedAt,
    };
    const current = byWindow.get(windowKey);
    byWindow.set(windowKey, current ? betterSnapshot(current, snapshot) : snapshot);
  }
  return [...byWindow.values()];
}

export function normalizeUsageProbes(
  probes: Record<LimitProvider, UsageProbe>,
  options: NormalizeOptions = {},
): LimitSnapshot[] {
  return [...normalizeUsageProbe(probes.claude, options), ...normalizeUsageProbe(probes.codex, options)];
}
