// ---------------------------------------------------------------------------
// Bounded-concurrency helpers shared by the fan-out and claim-draining stages.
//
// Both the static fan-out (a fixed list of runs) and the dynamic claim loops
// (executing-plan / task-review FIX, which keep claiming from a shared queue
// until it drains) must never run more than `limit` agents at once. Previously
// the claim loops span one worker per configured agent slot with no cap, so a
// 20-task stage could launch 20 PTYs regardless of execution.maxConcurrent.
// ---------------------------------------------------------------------------

/** Clamp a requested concurrency to a sane positive integer. */
export function boundedConcurrency(requested: number, fallback = 1): number {
  const n = Number.isFinite(requested) ? Math.floor(requested) : fallback;
  return Math.max(1, n);
}

/** Run a fixed list of items through `worker` with at most `limit` running concurrently. */
export async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T, i: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const n = Math.max(1, Math.min(boundedConcurrency(limit), items.length || 1));
  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: n }, runner));
}

/**
 * Drain a dynamic work queue with bounded concurrency. `claim` returns the next work item (or
 * null when the queue is drained); `process` handles one item. At most `limit` claims/processes
 * run concurrently, and the pool stops claiming once `shouldStop()` becomes true (e.g. on abort).
 *
 * Each worker repeatedly claims-then-processes, so the live concurrency is exactly the number of
 * workers — never more than `limit` regardless of how many tasks/findings remain.
 */
export async function drainPool<T>(opts: {
  limit: number;
  claim: () => Promise<T | null>;
  process: (item: T) => Promise<void>;
  shouldStop?: () => boolean;
}): Promise<void> {
  const n = boundedConcurrency(opts.limit);
  const shouldStop = opts.shouldStop ?? (() => false);
  const worker = async (): Promise<void> => {
    while (!shouldStop()) {
      const item = await opts.claim();
      if (item === null) return;
      await opts.process(item);
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
}
