import type { Server } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { AppCtx } from '../context.js';
import type { ManagerOutputEvent } from '../terminal/TerminalManager.js';
import type { TerminalRuntimeStatus } from '../store/types.js';
import { parseClientMessage, type ServerMsg } from './protocol.js';

interface Peer {
  ws: WebSocket;
  attached: Set<string>;
  alive: boolean;
}

const HEARTBEAT_MS = 30_000;

export function createWsServer(server: Server, ctx: AppCtx): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const peers = new Set<Peer>();
  const { manager, state } = ctx;

  const send = (ws: WebSocket, msg: ServerMsg): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMsg): void => {
    for (const p of peers) send(p.ws, msg);
  };

  // Fan manager events out. Output goes only to attached peers; status/exit to all
  // (the sidebar needs status for every terminal regardless of which one is open).
  manager.on('output', ({ termId, data }: ManagerOutputEvent) => {
    for (const p of peers) if (p.attached.has(termId)) send(p.ws, { type: 'term.output', termId, data });
  });
  manager.on('status', (s: TerminalRuntimeStatus) => {
    broadcast({ type: 'term.status', termId: s.id, state: s.state, pid: s.pid });
  });
  manager.on('exit', (s: TerminalRuntimeStatus) => {
    broadcast({ type: 'term.exit', termId: s.id, exitCode: s.exitCode, signal: s.signal });
  });

  wss.on('connection', (ws: WebSocket) => {
    const peer: Peer = { ws, attached: new Set(), alive: true };
    peers.add(peer);
    ws.on('pong', () => {
      peer.alive = true;
    });
    ws.on('message', (raw: RawData) => void handleMessage(peer, raw.toString()));
    ws.on('close', () => peers.delete(peer));
    ws.on('error', () => peers.delete(peer));
  });

  async function handleMessage(peer: Peer, raw: string): Promise<void> {
    const msg = parseClientMessage(raw);
    if (!msg) return;
    try {
      switch (msg.type) {
        case 'term.attach': {
          peer.attached.add(msg.termId);
          const status = manager.getStatus(msg.termId);
          send(peer.ws, {
            type: 'term.attached',
            termId: msg.termId,
            id: msg.id,
            state: status?.state ?? 'stopped',
            cols: status?.cols ?? 80,
            rows: status?.rows ?? 30,
          });
          const buf = manager.getBuffer(msg.termId);
          if (buf) send(peer.ws, { type: 'term.output', termId: msg.termId, data: buf });
          break;
        }
        case 'term.detach':
          peer.attached.delete(msg.termId);
          break;
        case 'term.input':
          if (typeof msg.data === 'string') manager.write(msg.termId, msg.data);
          break;
        case 'term.resize':
          manager.resize(msg.termId, msg.cols, msg.rows);
          break;
        case 'term.broadcastInput': {
          const appendNewline = msg.appendNewline ?? state.settings.commandRouting.appendNewlineByDefault;
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
        p.ws.terminate();
        peers.delete(p);
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
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}
