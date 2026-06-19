/**
 * Retry backoff policy for queue jobs.
 *
 * A deterministically-failing job that is simply re-queued hot-loops: it gets
 * leased, fails, gets re-queued, and is immediately dispatchable again. This
 * module computes an exponential backoff delay so each retry is deferred via the
 * job's `resumeAfter` timestamp (which `isDispatchable` already honours), and
 * decides when a job has exhausted its attempts and must go to a terminal state.
 */

export interface RetryBackoffOptions {
  /** Delay applied before the first retry (attempt 1 -> 2). */
  baseMs?: number;
  /** Growth factor per attempt. */
  factor?: number;
  /** Upper bound on a single backoff delay. */
  maxMs?: number;
}

const DEFAULT_BASE_MS = 5_000;
const DEFAULT_FACTOR = 2;
const DEFAULT_MAX_MS = 5 * 60_000; // 5 minutes

/**
 * Exponential backoff for the next retry, in milliseconds.
 *
 * `attempts` is the number of attempts already consumed (i.e. the value of
 * `job.attempts` after the just-failed run). The first retry (attempts = 1)
 * waits `baseMs`, the second `baseMs * factor`, and so on, capped at `maxMs`.
 */
export function retryBackoffMs(attempts: number, options: RetryBackoffOptions = {}): number {
  const baseMs = options.baseMs ?? DEFAULT_BASE_MS;
  const factor = options.factor ?? DEFAULT_FACTOR;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const exponent = Math.max(0, attempts - 1);
  const delay = baseMs * factor ** exponent;
  if (!Number.isFinite(delay)) return maxMs;
  return Math.min(maxMs, Math.max(0, Math.round(delay)));
}

/** Whether a job that has consumed `attempts` runs may be retried under its cap. */
export function canRetry(attempts: number, maxAttempts: number): boolean {
  return attempts < Math.max(1, maxAttempts);
}

/**
 * Decide what happens to a job after a failed run.
 *
 * Returns either a retry (with the ISO timestamp it becomes dispatchable again) or
 * a terminal failure once the attempts cap is reached.
 */
export function planRetry(
  attempts: number,
  maxAttempts: number,
  now: string,
  options?: RetryBackoffOptions,
): { retry: true; resumeAfter: string } | { retry: false } {
  if (!canRetry(attempts, maxAttempts)) return { retry: false };
  const delay = retryBackoffMs(attempts, options);
  const resumeAfter = new Date(new Date(now).getTime() + delay).toISOString();
  return { retry: true, resumeAfter };
}
