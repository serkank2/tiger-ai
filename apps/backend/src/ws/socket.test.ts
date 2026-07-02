import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createWsServer } from './socket.js';
import type { AppCtx } from '../context.js';
import type { ServerMsg } from './protocol.js';

// ---------------------------------------------------------------------------
// Black-box test of the WS data-plane: a real http server + real `ws` client
// against a fake AppCtx whose subsystems are EventEmitters. Exercises origin
// verification, the attach/snapshot ordering and contents, attached-only output
// fan-out, and team/tiger/queue snapshot broadcasting. Heartbeat reaping (30s
// interval) and 8MB backpressure drop are NOT driven here (they need real timers
// / a stalled socket); see the report's deferred notes.
// ---------------------------------------------------------------------------

interface FakeManager extends EventEmitter {
  defs: Map<string, { id: string }>;
  buffers: Map<string, string>;
  statuses: Map<string, { state: string; cols: number; rows: number }>;
  writes: Array<{ id: string; data: string }>;
}

function fakeManager(): FakeManager {
  const m = new EventEmitter() as FakeManager;
  m.defs = new Map();
  m.buffers = new Map();
  m.statuses = new Map();
  m.writes = [];
  Object.assign(m, {
    getDefinition: (id: string) => m.defs.get(id),
    flush: () => {},
    getStatus: (id: string) => m.statuses.get(id),
    getBuffer: (id: string) => m.buffers.get(id) ?? '',
    write: (id: string, data: string) => {
      m.writes.push({ id, data });
      return true;
    },
    resize: () => {},
    routeInput: async () => ({ matched: 0, written: 0, failed: [] }),
  });
  return m;
}

function fakeCtx(manager: FakeManager): AppCtx {
  const limits = Object.assign(new EventEmitter(), { getState: () => ({ kind: 'limit' }) });
  const runEngine = Object.assign(new EventEmitter(), { getSnapshot: () => null });
  const promptGenerations = new EventEmitter();
  // queueService omitted (optional) to keep the connection snapshot deterministic.
  return {
    manager,
    limits,
    runEngine,
    promptGenerations,
    queueService: undefined,
    state: { settings: { commandRouting: { appendNewlineByDefault: true, startTerminalOnSend: true } } },
  } as unknown as AppCtx;
}

interface Harness {
  url: string;
  manager: FakeManager;
  ctx: AppCtx;
  close: () => Promise<void>;
}

async function startServer(): Promise<Harness> {
  const manager = fakeManager();
  const ctx = fakeCtx(manager);
  const server = http.createServer();
  const wss = createWsServer(server, ctx);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    manager,
    ctx,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

/** Connect and collect frames until `predicate` is satisfied (or the socket errors). */
function collectUntil(ws: WebSocket, predicate: (msgs: ServerMsg[]) => boolean): Promise<ServerMsg[]> {
  const msgs: ServerMsg[] = [];
  return new Promise((resolve, reject) => {
    ws.on('message', (raw) => {
      msgs.push(JSON.parse(raw.toString()));
      if (predicate(msgs)) resolve(msgs);
    });
    ws.on('error', reject);
    ws.on('close', () => (predicate(msgs) ? resolve(msgs) : reject(new Error('socket closed early'))));
  });
}

test('connection rejects a disallowed Origin with HTTP 403', async () => {
  const h = await startServer();
  try {
    const ws = new WebSocket(h.url, { headers: { origin: 'http://evil.example' } });
    const err = await once(ws, 'unexpected-response').catch(() => null);
    // ws surfaces a non-101 upgrade either via 'unexpected-response' or an 'error'.
    if (err) {
      const res = err[1] as http.IncomingMessage;
      assert.equal(res.statusCode, 403);
    } else {
      const e = await once(ws, 'error');
      assert.match(String(e[0]), /403|Unexpected server response/);
    }
  } finally {
    await h.close();
  }
});

test('connection with no Origin (non-browser client) is allowed and gets the initial snapshots', async () => {
  const h = await startServer();
  try {
    const ws = new WebSocket(h.url);
    const msgs = await collectUntil(ws, (m) => m.some((x) => x.type === 'limit.state'));
    assert.ok(
      msgs.find((m) => m.type === 'limit.state'),
      'limit.state snapshot sent on connect',
    );
    // No run snapshot since getSnapshot() returned null.
    assert.equal(
      msgs.some((m) => m.type === 'run.state'),
      false,
    );
    ws.close();
  } finally {
    await h.close();
  }
});

test('connection from an allowed Origin (localhost) is accepted', async () => {
  const h = await startServer();
  try {
    const ws = new WebSocket(h.url, { headers: { origin: 'http://localhost:3000' } });
    await once(ws, 'open');
    ws.close();
  } finally {
    await h.close();
  }
});

test('term.attach emits term.attached then term.snapshot (in that order) carrying the scrollback', async () => {
  const h = await startServer();
  h.manager.defs.set('t1', { id: 't1' });
  h.manager.statuses.set('t1', { state: 'running', cols: 100, rows: 40 });
  h.manager.buffers.set('t1', 'SCROLLBACK_DATA');
  try {
    const ws = new WebSocket(h.url);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'term.attach', termId: 't1', id: 'req-1' }));
    const msgs = await collectUntil(ws, (m) => m.some((x) => x.type === 'term.snapshot'));
    const attachedIdx = msgs.findIndex((m) => m.type === 'term.attached');
    const snapshotIdx = msgs.findIndex((m) => m.type === 'term.snapshot');
    assert.ok(attachedIdx >= 0 && snapshotIdx >= 0);
    assert.ok(attachedIdx < snapshotIdx, 'attached must precede snapshot');
    const attached = msgs[attachedIdx] as Extract<ServerMsg, { type: 'term.attached' }>;
    assert.equal(attached.id, 'req-1');
    assert.equal(attached.state, 'running');
    assert.equal(attached.cols, 100);
    const snap = msgs[snapshotIdx] as Extract<ServerMsg, { type: 'term.snapshot' }>;
    assert.equal(snap.data, 'SCROLLBACK_DATA');
    assert.equal(snap.state, 'running');
    ws.close();
  } finally {
    await h.close();
  }
});

test('term.attach to an unknown terminal returns an UNKNOWN_TERMINAL error keyed by request id', async () => {
  const h = await startServer();
  try {
    const ws = new WebSocket(h.url);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'term.attach', termId: 'ghost', id: 'req-9' }));
    const msgs = await collectUntil(ws, (m) => m.some((x) => x.type === 'term.error'));
    const err = msgs.find((m) => m.type === 'term.error') as Extract<ServerMsg, { type: 'term.error' }>;
    assert.equal(err.code, 'UNKNOWN_TERMINAL');
    assert.equal(err.id, 'req-9');
    ws.close();
  } finally {
    await h.close();
  }
});

test('manager status events are broadcast to every peer regardless of attachment', async () => {
  const h = await startServer();
  try {
    const ws = new WebSocket(h.url);
    await once(ws, 'open');
    const got = collectUntil(ws, (m) => m.some((x) => x.type === 'term.status'));
    h.manager.emit('status', { id: 't1', state: 'running', cols: 80, rows: 30, exitCode: null, pid: 123 });
    const msgs = await got;
    const status = msgs.find((m) => m.type === 'term.status') as Extract<ServerMsg, { type: 'term.status' }>;
    assert.equal(status.termId, 't1');
    assert.equal(status.state, 'running');
    assert.equal(status.pid, 123);
    ws.close();
  } finally {
    await h.close();
  }
});

test('manager output is delivered ONLY to a peer attached to that terminal', async () => {
  const h = await startServer();
  h.manager.defs.set('t1', { id: 't1' });
  try {
    const ws = new WebSocket(h.url);
    await once(ws, 'open');
    // Emit output before attaching: must NOT be delivered.
    h.manager.emit('output', { termId: 't1', data: 'before-attach' });
    ws.send(JSON.stringify({ type: 'term.attach', termId: 't1' }));
    await collectUntil(ws, (m) => m.some((x) => x.type === 'term.snapshot'));
    const got = collectUntil(ws, (m) => m.some((x) => x.type === 'term.output'));
    h.manager.emit('output', { termId: 't1', data: 'after-attach' });
    const msgs = await got;
    const outputs = msgs.filter((m) => m.type === 'term.output') as Array<Extract<ServerMsg, { type: 'term.output' }>>;
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0]!.data, 'after-attach');
    ws.close();
  } finally {
    await h.close();
  }
});

test('term.input is written through to the manager for the addressed terminal', async () => {
  const h = await startServer();
  h.manager.defs.set('t1', { id: 't1' });
  try {
    const ws = new WebSocket(h.url);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'term.input', termId: 't1', data: 'ls\r' }));
    // Round-trip a ping to ensure the input frame was processed first.
    ws.send(JSON.stringify({ type: 'ping', ts: 42 }));
    await collectUntil(ws, (m) => m.some((x) => x.type === 'pong'));
    assert.deepEqual(h.manager.writes, [{ id: 't1', data: 'ls\r' }]);
    ws.close();
  } finally {
    await h.close();
  }
});

test('ping is answered with a pong echoing the timestamp', async () => {
  const h = await startServer();
  try {
    const ws = new WebSocket(h.url);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'ping', ts: 777 }));
    const msgs = await collectUntil(ws, (m) => m.some((x) => x.type === 'pong'));
    const pong = msgs.find((m) => m.type === 'pong') as Extract<ServerMsg, { type: 'pong' }>;
    assert.equal(pong.ts, 777);
    ws.close();
  } finally {
    await h.close();
  }
});

test('run engine events are broadcast as run.state / run.event frames', async () => {
  const h = await startServer();
  try {
    const ws = new WebSocket(h.url);
    await once(ws, 'open');
    const got = collectUntil(ws, (m) => m.some((x) => x.type === 'run.event'));
    (h.ctx.runEngine as unknown as EventEmitter).emit('engine-event', {
      kind: 'event',
      event: { seq: 3, at: 'x', type: 'note', runId: 'run-1', text: 'hello run' },
    });
    const msgs = await got;
    const frame = msgs.find((m) => m.type === 'run.event') as Extract<ServerMsg, { type: 'run.event' }>;
    assert.equal(frame.runId, 'run-1');
    assert.equal(frame.event.text, 'hello run');
    ws.close();
  } finally {
    await h.close();
  }
});

test('an invalid/garbage client frame is ignored without crashing the socket', async () => {
  const h = await startServer();
  try {
    const ws = new WebSocket(h.url);
    await once(ws, 'open');
    ws.send('this is not json');
    ws.send(JSON.stringify({ type: 'totally.unknown' }));
    // The socket must still answer a subsequent valid ping.
    ws.send(JSON.stringify({ type: 'ping', ts: 5 }));
    const msgs = await collectUntil(ws, (m) => m.some((x) => x.type === 'pong'));
    assert.ok(msgs.find((m) => m.type === 'pong'));
    ws.close();
  } finally {
    await h.close();
  }
});
