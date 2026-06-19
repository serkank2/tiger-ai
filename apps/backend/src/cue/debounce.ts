/**
 * A trailing debounce keyed by a string. Multiple rapid calls for the same key collapse into a
 * single delayed invocation that fires `delayMs` after the LAST call. Used by the file watcher
 * so an editor save (which can emit several `change` events) wakes a cue exactly once.
 *
 * Pure-ish: the only side effect is `setTimeout`. Tests inject a fake `schedule`/`cancel` pair so
 * the debounce logic itself is verified without real timers.
 */
export interface DebounceTimers {
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

const realTimers: DebounceTimers = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class KeyedDebouncer {
  private readonly pending = new Map<string, unknown>();

  constructor(
    private readonly delayMs: number,
    private readonly timers: DebounceTimers = realTimers,
  ) {}

  /** Schedule `fn` for `key`, replacing any still-pending call for the same key. */
  trigger(key: string, fn: () => void): void {
    const existing = this.pending.get(key);
    if (existing !== undefined) this.timers.cancel(existing);
    const handle = this.timers.schedule(() => {
      this.pending.delete(key);
      fn();
    }, this.delayMs);
    this.pending.set(key, handle);
  }

  /** Cancel every pending call (used on engine stop). */
  cancelAll(): void {
    for (const handle of this.pending.values()) this.timers.cancel(handle);
    this.pending.clear();
  }

  /** Number of keys with a pending call (test/introspection aid). */
  get size(): number {
    return this.pending.size;
  }
}
