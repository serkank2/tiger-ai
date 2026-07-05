/**
 * Tiny, dependency-free schedule helpers for `time.scheduled` / `time.once` subscriptions.
 *
 * Rather than pull in a cron library, an interval is expressed as a human duration spec
 * ("30s", "5m", "1h", "500ms", or a bare integer = ms). This covers the periodic-pipeline use
 * case (re-run X every N minutes) without a dependency. A one-shot uses an absolute ISO time.
 */

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Minimum interval we will honor, to keep a misconfigured cue from hot-looping. */
export const MIN_INTERVAL_MS = 1000;

/**
 * Parse a duration spec to milliseconds. Returns null when the spec is missing or invalid so the
 * caller can skip an un-schedulable subscription rather than crash. Accepts "<num><unit>" with
 * unit ms|s|m|h|d, or a bare positive integer interpreted as milliseconds.
 */
export function parseIntervalSpec(spec: string | number | undefined): number | null {
  if (spec === undefined || spec === null) return null;
  if (typeof spec === 'number')
    return Number.isFinite(spec) && spec > 0 ? Math.max(MIN_INTERVAL_MS, Math.trunc(spec)) : null;
  const trimmed = spec.trim().toLowerCase();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n > 0 ? Math.max(MIN_INTERVAL_MS, n) : null;
  }
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(trimmed);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2]!;
  const ms = value * UNIT_MS[unit]!;
  return ms > 0 ? Math.max(MIN_INTERVAL_MS, Math.trunc(ms)) : null;
}

/**
 * Milliseconds from `now` until the `at` ISO timestamp. Returns null for an invalid date, and a
 * non-negative number otherwise (0 when the time is already in the past — fire immediately).
 */
export function msUntil(at: string | undefined, now = Date.now()): number | null {
  if (!at) return null;
  const target = new Date(at).getTime();
  if (!Number.isFinite(target)) return null;
  return Math.max(0, target - now);
}
