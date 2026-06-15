import type { Server } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { config } from '../config.js';
import type { AppCtx } from '../context.js';
import type { ManagerOutputEvent } from '../terminal/TerminalManager.js';
import type { CommandTarget, TerminalRuntimeStatus } from '../store/types.js';
import { parseClientMessage, type ServerMsg } from './protocol.js';

interface Peer {
  ws: WebSocket;
  attached: Set<string>;
  alive: boolean;
}

const HEARTBEAT_MS = 30_000;
const MAX_PAYLOAD = 512 * 1024; // input/command frames are tiny; this is a generous cap
const MAX_ATTACH = 256;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) <= 2000;

function validTarget(t: unknown): t is CommandTarget {
  if (!t || typeof t !== 'object') return false;
  const x = t as { mode?: unknown; groupId?: unknown; termIds?: unknown };
  if (x.mode === 'all') return true;
  if (x.mode === 'group') return isStr(x.groupId);
  if (x.mode === 'selected') return Array.isArray(x.termIds) && x.termIds.every(isStr);
  return false;
}

export function createWsServer(server: Server, ctx: AppCtx): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: MAX_PAYLOAD,
    // Defend against cross-site WebSocket hijacking: a browser page from another
    // origin must not be able to open this socket and drive local terminals.
    // Non-browser local clients send no Origin header and are allowed.
    verifyClient: (info, cb) => {
      const origin = info.origin;
      const ok = !origin || config.corsOrigins.includes(origin);
      cb(ok, 403, 'Forbidden origin');
    },
  });
  const peers = new Set<Peer>();
  const { manager, state } = ctx;

  const send = (ws: WebSocket, msg: ServerMsg): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMsg): void => {
    for (const p of peers) send(p.ws, msg);
  };
  const cleanup = (peer: Peer): void => {
    peers.delete(peer);
    try {
      peer.ws.terminate();
    } catch {
      /* already gone */
    }
  };

  // Fan manager events out. Output only to attached peers; status/exit to all
  // (the sidebar needs status for every terminal regardless of which one is open).
  const onOutput = ({ termId, data }: ManagerOutputEvent) => {
    for (const p of peers) if (p.attached.has(termId)) send(p.ws, { type: 'term.output', termId, data });
  };
  const onStatus = (s: TerminalRuntimeStatus) =>
    broadcast({ type: 'term.status', termId: s.id, state: s.state, pid: s.pid });
  const onExit = (s: TerminalRuntimeStatus) =>
    broadcast({ type: 'term.exit', termId: s.id, exitCode: s.exitCode, signal: s.signal });
  manager.on('output', onOutput);
  manager.on('status', onStatus);
  manager.on('exit', onExit);

  wss.on('connection', (ws: WebSocket) => {
    const peer: Peer = { ws, attached: new Set(), alive: true };
    peers.add(peer);
    ws.on('pong', () => {
      peer.alive = true;
    });
    ws.on('message', (raw: RawData, isBinary: boolean) => {
      if (isBinary) return; // text protocol only
      void handleMessage(peer, raw.toString());
    });
    ws.on('close', () => peers.delete(peer));
    ws.on('error', () => cleanup(peer));
  });

  async function handleMessage(peer: Peer, raw: string): Promise<void> {
    const msg = parseClientMessage(raw);
    if (!msg) return;
    try {
      switch (msg.type) {
        case 'term.attach': {
          if (!isStr(msg.termId) || !manager.getDefinition(msg.termId)) {
            send(peer.ws, { type: 'term.error', termId: msg.termId, id: msg.id, code: 'UNKNOWN_TERMINAL', message: 'unknown terminal' });
            break;
          }
          if (peer.attached.size >= MAX_ATTACH) break;
          peer.attached.add(msg.termId);
          const status = manager.getStatus(msg.termId);
          const state = status?.state ?? 'stopped';
          const cols = status?.cols ?? 80;
          const rows = status?.rows ?? 30;
          send(peer.ws, { type: 'term.attached', termId: msg.termId, id: msg.id, state, cols, rows });
          // Always send a snapshot (even empty) so the client resets before rendering —
          // this makes a reconnect re-attach replace the view instead of duplicating it.
          send(peer.ws, {
            type: 'term.snapshot',
            termId: msg.termId,
            data: manager.getBuffer(msg.termId),
            state,
            cols,
            rows,
          });
          break;
        }
        case 'term.detach':
          if (isStr(msg.termId)) peer.attached.delete(msg.termId);
          break;
        case 'term.input':
          if (isStr(msg.termId) && isStr(msg.data)) manager.write(msg.termId, msg.data);
          break;
        case 'term.resize':
          if (isStr(msg.termId) && isPosInt(msg.cols) && isPosInt(msg.rows)) {
            manager.resize(msg.termId, msg.cols, msg.rows);
          }
          break;
        case 'term.broadcastInput': {
          if (!validTarget(msg.target) || !isStr(msg.data)) {
            send(peer.ws, { type: 'term.error', id: msg.id, code: 'BAD_REQUEST', message: 'invalid broadcastInput' });
            break;
          }
          const appendNewline =
            typeof msg.appendNewline === 'boolean'
              ? msg.appendNewline
              : state.settings.commandRouting.appendNewlineByDefault;
          const result = await manager.routeInput(msg.target, msg.data, {
            appendNewline,
            startTerminalOnSend: state.settings.commandRouting.startTerminalOnSend,
          });
          send(peer.ws, { type: 'term.broadcastResult', id: msg.id, ...result });
          break;
        }
        case 'ping':
          send(peer.ws, { type: 'pong', ts: msg.ts });
          break;
      }
    } catch (err) {
      send(peer.ws, {
        type: 'term.error',
        termId: 'termId' in msg ? msg.termId : undefined,
        id: 'id' in msg ? msg.id : undefined,
        message: err instanceof Error ? err.message : String(err),
        code: (err as { code?: string })?.code,
      });
    }
  }

  const heartbeat = setInterval(() => {
    for (const p of peers) {
      if (!p.alive) {
        cleanup(p);
        continue;
      }
      p.alive = false;
      try {
        p.ws.ping();
      } catch {
        /* socket already closing */
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  wss.on('close', () => {
    clearInterval(heartbeat);
    manager.off('output', onOutput);
    manager.off('status', onStatus);
    manager.off('exit', onExit);
  });

  return wss;
}
