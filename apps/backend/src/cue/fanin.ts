/**
 * Fan-in accounting for `agent.completed` subscriptions with a `filter.allOf` list: the
 * subscription must wait until EVERY named source has completed (since the last fire) before it
 * triggers once. This is the pure bookkeeping — no events, no timers — so it is trivially
 * testable and reused by the engine.
 */
export class FanInTracker {
  /** Required source names (lower-cased for case-insensitive matching). */
  private readonly required: Set<string>;
  /** Sources seen since the last reset. */
  private readonly seen = new Set<string>();

  constructor(required: string[]) {
    this.required = new Set(required.map((s) => s.trim().toLowerCase()).filter(Boolean));
  }

  /** True when the subscription has no required sources (degenerate: always ready on any event). */
  get isTrivial(): boolean {
    return this.required.size === 0;
  }

  /** The required sources not yet seen since the last reset. */
  pending(): string[] {
    return [...this.required].filter((s) => !this.seen.has(s));
  }

  /**
   * Record that `source` completed. Returns true when this completion makes the full set ready
   * (all required sources seen) — at which point the caller should fire and then call `reset()`.
   * A source not in the required set is ignored (returns false).
   */
  record(source: string): boolean {
    const key = source.trim().toLowerCase();
    if (!this.required.has(key)) return false;
    this.seen.add(key);
    return this.isReady();
  }

  /** True when every required source has been seen since the last reset. */
  isReady(): boolean {
    if (this.isTrivial) return true;
    for (const s of this.required) {
      if (!this.seen.has(s)) return false;
    }
    return true;
  }

  /** Clear the seen set so the next round of completions starts fresh. */
  reset(): void {
    this.seen.clear();
  }
}
