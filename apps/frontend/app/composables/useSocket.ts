import type { CommandTarget, ServerMessage } from '~/types';

// Module-scoped singletons: one WebSocket per browser window, shared across callers.
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 500;
const outputListeners = new Map<string, Set<(data: string) => void>>();
const attached = new Set<string>();

/**
 * Single multiplexed WebSocket to the backend. Routes status/exit into the
 * terminals store and output into per-terminal listeners; auto-reconnects and
 * re-attaches on reconnect.
 */
export function useSocket() {
  const config = useRuntimeConfig();
  const conn = useConnectionStore();
  const terminals = useTerminalsStore();
  const wsBase = config.public.wsBase as string;

  function connect(): void {
    if (!import.meta.client) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    conn.setStatus('connecting');
    socket = new WebSocket(`${wsBase}/ws`);
    socket.onopen = () => {
      conn.setStatus('connected');
      backoff = 500;
      for (const id of attached) raw({ type: 'term.attach', termId: id });
    };
    socket.onclose = () => {
      conn.setStatus('disconnected');
      scheduleReconnect();
    };
    socket.onerror = () => {
      /* a close event follows */
    };
    socket.onmessage = (ev) => {
      try {
        handle(JSON.parse(ev.data) as ServerMessage);
      } catch {
        /* ignore malformed frame */
      }
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

  function raw(msg: Record<string, unknown>): void {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  }

  function handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'term.output':
        if (msg.termId && typeof msg.data === 'string') {
          const set = outputListeners.get(msg.termId);
          if (set) for (const cb of set) cb(msg.data);
        }
        break;
      case 'term.status':
        if (msg.termId && msg.state) terminals.applyStatus(msg.termId, msg.state, msg.pid);
        break;
      case 'term.exit':
        if (msg.termId) terminals.applyExit(msg.termId, msg.exitCode ?? null, msg.signal ?? null);
        break;
    }
  }

  function attach(id: string): void {
    attached.add(id);
    raw({ type: 'term.attach', termId: id });
  }
  function detach(id: string): void {
    attached.delete(id);
    raw({ type: 'term.detach', termId: id });
  }
  function input(id: string, data: string): void {
    raw({ type: 'term.input', termId: id, data });
  }
  function resize(id: string, cols: number, rows: number): void {
    raw({ type: 'term.resize', termId: id, cols, rows });
  }
  function broadcast(target: CommandTarget, data: string, appendNewline?: boolean): void {
    raw({ type: 'term.broadcastInput', target, data, appendNewline });
  }

  /** Subscribe to a terminal's output. Returns an unsubscribe function. */
  function onOutput(id: string, cb: (data: string) => void): () => void {
    let set = outputListeners.get(id);
    if (!set) {
      set = new Set();
      outputListeners.set(id, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) outputListeners.delete(id);
    };
  }

  return { connect, attach, detach, input, resize, broadcast, onOutput };
}
