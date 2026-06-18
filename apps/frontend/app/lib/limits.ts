import type { LimitDecision, LimitSnapshot, LimitStatus } from '~/types';

export type LimitSeverity = 'ok' | 'amber' | 'red' | 'unknown';

export function normalizedPercent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function severityForPercent(value: number | null | undefined): LimitSeverity {
  const percent = normalizedPercent(value);
  if (percent === null) return 'unknown';
  if (percent >= 90) return 'red';
  if (percent >= 70) return 'amber';
  return 'ok';
}

export function percentText(value: number | null | undefined): string {
  const percent = normalizedPercent(value);
  return percent === null ? 'Unknown' : `${percent}%`;
}

export function maxLatestPercent(status: LimitStatus | null): number | null {
  if (!status?.latest.length) return null;
  const values = status.latest
    .map((snapshot) => normalizedPercent(snapshot.percentUsed))
    .filter((value): value is number => value !== null);
  return values.length ? Math.max(...values) : null;
}

export function snapshotTime(snapshot: LimitSnapshot): number {
  const time = Date.parse(snapshot.checkedAt);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

export function isSnapshotStale(snapshot: LimitSnapshot, staleAfterMs: number, now = Date.now()): boolean {
  const time = snapshotTime(snapshot);
  if (!Number.isFinite(time)) return true;
  return now - time > staleAfterMs;
}

export function hasStaleLatest(status: LimitStatus | null, now = Date.now()): boolean {
  if (!status?.latest.length) return false;
  return status.latest.some((snapshot) => isSnapshotStale(snapshot, status.staleAfterMs, now));
}

export function latestSnapshotErrors(status: LimitStatus | null): LimitSnapshot[] {
  return status?.latest.filter((snapshot) => !snapshot.ok || !!snapshot.error) ?? [];
}

export function gateLabel(decision: LimitDecision | null | undefined): string {
  if (!decision) return 'No gate state';
  if (decision.action === 'block') return decision.conservative ? 'Blocked conservatively' : 'Blocked';
  return 'Allowed';
}

export function sortSnapshotsNewestFirst(snapshots: LimitSnapshot[]): LimitSnapshot[] {
  return [...snapshots].sort((a, b) => snapshotTime(b) - snapshotTime(a));
}
