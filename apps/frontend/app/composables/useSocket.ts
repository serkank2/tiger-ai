import type { CommandTarget, LimitStatus, ServerMessage, TigerState } from '~/types';
import { useLimitsStore } from '~/stores/limits';

// Optional shared-token auth, persisted to localStorage by the settings store.
// Read directly here so the WS handshake carries it without a store dependency.
const AUTH_TOKEN_KEY = 'kaplan.authToken';
function getStoredAuthToken(): string {
  if (typeof localStorage === 'undefined') return '';
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

// Module-scoped singletons: one WebSocket per browser window, shared across callers.
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 500;
let msgSeq = 0;
let disconnectNoticeShown = false;
const outputListeners = new Map<string, Set<(data: string) => void>>();
const snapshotListeners = new Map<string, Set<(data: string) => void>>();
// Generic server-event fan-out, keyed by message `type`. The shell wires the
// transport once; domain stores delivered by later tasks (queue, limits,
// prompt generation) subscribe to their state pushes without re-touching this
// file. Payload is the full parsed message.
const serverEventListeners = new Map<string, Set<(msg: ServerMessage) => void>>();
// ref-counted: a terminal may be bound by >1 view briefly (focus<->grid swap)
const attached = new Map<string, number>();

export interface BroadcastOkOutcome {
  kind: 'ok';
  matched: number;
  written: number;
  failed: { termId: string; code: string }[];
}
export type BroadcastOutcome =
  | BroadcastOkOutcome
  | { kind: 'timeout' }
  | { kind: 'disconnected' }
  | { kind: 'not_sent'; reason: 'socket_not_open' | 'server_error'; code?: string; message?: string };
interface BroadcastWaiter {
  resolve: (r: BroadcastOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}
const broadcastWaiters = new Map<string, BroadcastWaiter>();
/** Resolve + clear the timer for one pending broadcast (result, error, timeout, or disconnect). */
function settleWaiter(id: string, value: BroadcastOutcome): void {
  const w = broadcastWaiters.get(id);
  if (!w) return;
  clearTimeout(w.timer);
  broadcastWaiters.delete(id);
  w.resolve(value);
}
/** Settle every pending waiter (used on disconnect / HMR dispose so callers never hang). */
function settleAllWaiters(value: BroadcastOutcome): void {
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
  const tiger = useTigerStore();
  const limits = useLimitsStore();
  const wsBase = config.public.wsBase as string;

  function connect(): void {
    if (!import.meta.client) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    conn.setStatus('connecting');

    // Carry the optional shared-token auth on the WS handshake via `?token=` query
    // param (the backend also accepts Sec-WebSocket-Protocol). Omitted when unset.
    const token = getStoredAuthToken();
    const url = token ? `${wsBase}/ws?token=${encodeURIComponent(token)}` : `${wsBase}/ws`;
    const ws = new WebSocket(url);
    socket = ws;

    ws.onopen = () => {
      if (socket !== ws) return; // superseded
      conn.setStatus('connected');
      backoff = 500;
      disconnectNoticeShown = false;
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
      if (!disconnectNoticeShown) {
        notices.push('Live connection lost. Reconnecting...', 'error', 6000);
        disconnectNoticeShown = true;
      }
      settleAllWaiters({ kind: 'disconnected' }); // don't leave broadcast() callers hanging across a disconnect
      scheduleReconnect();
    };
    ws.onerror = () => {
      if (socket !== ws) return;
      if (!disconnectNoticeShown) {
        notices.push('Live connection error. Reconnecting...', 'error', 6000);
        disconnectNoticeShown = true;
      }
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

  /**
   * Force the live socket to re-handshake. Used when the shared-token auth credential
   * changes in Settings: REST picks up the new token on the next request, but the WS
   * carries its token only on the handshake, so it must be torn down and reopened to
   * apply the new (or cleared) token. Closing triggers onclose -> scheduleReconnect,
   * but we reconnect eagerly here so the change applies immediately.
   */
  function reconnect(): void {
    if (!import.meta.client) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    backoff = 500;
    const old = socket;
    socket = null; // detach handlers (they bail when `socket !== ws`) before closing
    if (old) {
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
    connect();
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
        if (msg.id) settleWaiter(msg.id, { kind: 'ok', matched, written, failed });
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
          notices.push(
            `Sent to ${written}/${matched} — ${parts.join(', ')}`,
            written > 0 || !realFailure ? 'info' : 'error',
          );
          if (counts.UNKNOWN) void terminals.fetchAll().catch(() => {});
        }
        break;
      }
      case 'term.error':
        if (msg.id) {
          // Server-side broadcast error: settle so the caller doesn't wait 5s.
          settleWaiter(msg.id, { kind: 'not_sent', reason: 'server_error', code: msg.code, message: msg.message });
        }
        // A broadcast error (carries an id) is surfaced by the awaiting caller via the settled
        // outcome above; only push here for unsolicited errors that have no caller to own them.
        if (msg.message && !msg.id) notices.push(msg.message, 'error');
        if (msg.code === 'UNKNOWN_TERMINAL') void terminals.fetchAll().catch(() => {});
        break;
      case 'tiger.state':
        // tiger.state carries the full orchestrator snapshot in `state` (typed loosely here).
        tiger.applyState((msg as unknown as { state: TigerState }).state);
        break;
      // Domain-state pushes for screens delivered by later tasks. The shell does not
      // own these stores yet, so it simply fans the raw message out to subscribers.
      case 'queue.state':
      case 'team.state':
      case 'team.message':
      case 'team.role':
      case 'team.done':
      case 'team.steering':
      case 'team.changes':
      case 'run.state':
      case 'run.event':
      case 'generation.state':
      case 'history.changed':
        emitServerEvent(msg);
        break;
      case 'limit.state':
        limits.applyState((msg as unknown as { state: LimitStatus }).state);
        emitServerEvent(msg);
        break;
    }
  }

  function emitServerEvent(msg: ServerMessage): void {
    const set = serverEventListeners.get(msg.type);
    if (!set) return;
    for (const cb of Array.from(set)) {
      try {
        cb(msg);
      } catch (err) {
        console.error('[useSocket] server-event listener error', err);
      }
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
  /**
   * Resolves with a discriminated broadcast outcome.
   * Every waiter is settled: ok from server routing, not_sent if the frame cannot be
   * sent or is rejected, timeout after 5s, and disconnected if the socket closes first.
   */
  function broadcast(target: CommandTarget, data: string, appendNewline?: boolean): Promise<BroadcastOutcome> {
    const id = `c${++msgSeq}`;
    const sent = raw({ type: 'term.broadcastInput', id, target, data, appendNewline });
    if (!sent) return Promise.resolve({ kind: 'not_sent', reason: 'socket_not_open' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => settleWaiter(id, { kind: 'timeout' }), 5000);
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

  /**
   * Subscribe to a raw server message type (e.g. 'queue.state', 'team.state',
   * 'team.message', 'limit.state', 'generation.state', 'history.changed'). Returns an unsubscribe function. This is the WS-side
   * extension point for the domain stores delivered by later tasks.
   */
  function onServerEvent(type: string, cb: (msg: ServerMessage) => void): () => void {
    let set = serverEventListeners.get(type);
    if (!set) {
      set = new Set();
      serverEventListeners.set(type, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) serverEventListeners.delete(type);
    };
  }

  return { connect, reconnect, attach, detach, input, resize, broadcast, onOutput, onSnapshot, onServerEvent };
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
    disconnectNoticeShown = false;
    outputListeners.clear();
    snapshotListeners.clear();
    serverEventListeners.clear();
    attached.clear();
    settleAllWaiters({ kind: 'disconnected' }); // resolve pending broadcasts so awaiting callers don't hang on HMR
  });
}
