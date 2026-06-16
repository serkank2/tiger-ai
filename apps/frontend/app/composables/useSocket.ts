import type { CommandTarget, ServerMessage } from '~/types';

// Module-scoped singletons: one WebSocket per browser window, shared across callers.
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 500;
let msgSeq = 0;
const outputListeners = new Map<string, Set<(data: string) => void>>();
const snapshotListeners = new Map<string, Set<(data: string) => void>>();
// ref-counted: a terminal may be bound by >1 view briefly (focus<->grid swap)
const attached = new Map<string, number>();

export interface BroadcastOutcome {
  matched: number;
  written: number;
  failed: { termId: string; code: string }[];
}
interface BroadcastWaiter {
  resolve: (r: BroadcastOutcome | null) => void;
  timer: ReturnType<typeof setTimeout>;
}
const broadcastWaiters = new Map<string, BroadcastWaiter>();
/** Resolve + clear the timer for one pending broadcast (result, error, timeout, or disconnect). */
function settleWaiter(id: string, value: BroadcastOutcome | null): void {
  const w = broadcastWaiters.get(id);
  if (!w) return;
  clearTimeout(w.timer);
  broadcastWaiters.delete(id);
  w.resolve(value);
}
/** Settle every pending waiter (used on disconnect / HMR dispose so callers never hang). */
function settleAllWaiters(value: BroadcastOutcome | null): void {
  for (const id of [...broadcastWaiters.keys()]) settleWaiter(id, value);
}

/**
 * Single multiplexed WebSocket to the backend. Routes status/exit/snapshot into
 * the stores and per-terminal listeners; auto-reconnects and re-attaches.
 */
export function useSocket() {
  const config = useRuntimeConfig();
  const conn = useConnectionStore();
  const terminals = useTerminalsStore();
  const notices = useNoticesStore();
  const wsBase = config.public.wsBase as string;

  function connect(): void {
    if (!import.meta.client) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    conn.setStatus('connecting');

    const ws = new WebSocket(`${wsBase}/ws`);
    socket = ws;

    ws.onopen = () => {
      if (socket !== ws) return; // superseded
      conn.setStatus('connected');
      backoff = 500;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      for (const id of attached.keys()) raw({ type: 'term.attach', termId: id });
      // Reconcile every terminal's status — some may have changed while disconnected.
      void terminals.fetchAll().catch(() => {});
    };
    ws.onclose = () => {
      if (socket !== ws) return; // a newer socket already replaced us
      socket = null;
      conn.setStatus('disconnected');
      settleAllWaiters(null); // don't leave broadcast() callers hanging across a disconnect
      scheduleReconnect();
    };
    ws.onerror = () => {
      /* a close event follows */
    };
    ws.onmessage = (ev) => {
      if (socket !== ws) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      handle(msg);
    };
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoff = Math.min(backoff * 2, 8000);
      connect();
    }, backoff);
  }

  /** Returns true if the frame was sent, false if the socket isn't open. */
  function raw(msg: Record<string, unknown>): boolean {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function emitTo(map: Map<string, Set<(d: string) => void>>, id: string, data: string): void {
    const set = map.get(id);
    if (!set) return;
    for (const cb of Array.from(set)) {
      try {
        cb(data);
      } catch (err) {
        console.error('[useSocket] listener error', err);
      }
    }
  }

  function handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'term.snapshot':
        if (msg.termId && typeof msg.data === 'string') emitTo(snapshotListeners, msg.termId, msg.data);
        if (msg.termId && msg.state) terminals.applyStatus(msg.termId, msg.state);
        break;
      case 'term.output':
        if (msg.termId && typeof msg.data === 'string') emitTo(outputListeners, msg.termId, msg.data);
        break;
      case 'term.attached':
        if (msg.termId && msg.state) terminals.applyStatus(msg.termId, msg.state);
        break;
      case 'term.status':
        if (msg.termId && msg.state)
          terminals.applyStatus(msg.termId, msg.state, {
            pid: msg.pid,
            exitCode: msg.exitCode,
            signal: msg.signal,
            error: msg.error,
          });
        break;
      case 'term.exit':
        if (msg.termId) terminals.applyExit(msg.termId, msg.exitCode ?? null, msg.signal ?? null);
        break;
      case 'term.broadcastResult': {
        const failed = msg.failed ?? [];
        const written = msg.written ?? 0;
        const matched = msg.matched ?? 0;
        if (msg.id) settleWaiter(msg.id, { matched, written, failed });
        if (failed.length === 0) {
          notices.push(`Sent to ${written} terminal(s)`, 'info');
        } else {
          const counts: Record<string, number> = {};
          for (const f of failed) counts[f.code] = (counts[f.code] ?? 0) + 1;
          const labels: Record<string, string> = {
            NOT_RUNNING: 'not running',
            START_FAILED: 'failed to start',
            UNKNOWN: 'unknown',
            PROTECTED: 'protected',
          };
          const parts = Object.entries(counts).map(([c, n]) => `${n} ${labels[c] ?? c.toLowerCase()}`);
          // protected-only skips are intentional → info, not error
          const realFailure = failed.some((f) => f.code !== 'PROTECTED');
          notices.push(`Sent to ${written}/${matched} — ${parts.join(', ')}`, written > 0 || !realFailure ? 'info' : 'error');
          if (counts.UNKNOWN) void terminals.fetchAll().catch(() => {});
        }
        break;
      }
      case 'term.error':
        if (msg.id) settleWaiter(msg.id, null); // server-side broadcast error: settle so the caller doesn't wait 5s
        if (msg.message) notices.push(msg.message, 'error');
        if (msg.code === 'UNKNOWN_TERMINAL') void terminals.fetchAll().catch(() => {});
        break;
    }
  }

  function attach(id: string): void {
    const n = (attached.get(id) ?? 0) + 1;
    attached.set(id, n);
    if (n === 1) raw({ type: 'term.attach', termId: id }); // only on first binder
  }
  function detach(id: string): void {
    const n = (attached.get(id) ?? 0) - 1;
    if (n <= 0) {
      attached.delete(id);
      raw({ type: 'term.detach', termId: id }); // only when the last binder leaves
    } else {
      attached.set(id, n);
    }
  }
  function input(id: string, data: string): boolean {
    return raw({ type: 'term.input', termId: id, data });
  }
  function resize(id: string, cols: number, rows: number): void {
    raw({ type: 'term.resize', termId: id, cols, rows });
  }
  /** Resolves with the routing outcome, or null if the socket wasn't open / timed out. */
  function broadcast(
    target: CommandTarget,
    data: string,
    appendNewline?: boolean,
  ): Promise<BroadcastOutcome | null> {
    const id = `c${++msgSeq}`;
    const sent = raw({ type: 'term.broadcastInput', id, target, data, appendNewline });
    if (!sent) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => settleWaiter(id, null), 5000);
      broadcastWaiters.set(id, { resolve, timer });
    });
  }

  function subscribe(map: Map<string, Set<(d: string) => void>>, id: string, cb: (d: string) => void): () => void {
    let set = map.get(id);
    if (!set) {
      set = new Set();
      map.set(id, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) map.delete(id);
    };
  }
  const onOutput = (id: string, cb: (d: string) => void) => subscribe(outputListeners, id, cb);
  const onSnapshot = (id: string, cb: (d: string) => void) => subscribe(snapshotListeners, id, cb);

  return { connect, attach, detach, input, resize, broadcast, onOutput, onSnapshot };
}

// HMR safety: tear down the live socket/timer when this module is replaced.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket = null;
    reconnectTimer = null;
    outputListeners.clear();
    snapshotListeners.clear();
    attached.clear();
    settleAllWaiters(null); // resolve pending broadcasts so awaiting callers don't hang on HMR
  });
}
