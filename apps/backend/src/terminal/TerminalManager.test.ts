import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TerminalManager } from './TerminalManager.js';
import type { TerminalSession } from './TerminalSession.js';
import type { TerminalDefinition, TerminalRuntimeStatus } from '../store/types.js';

function makeDef(over: Partial<TerminalDefinition> & Pick<TerminalDefinition, 'id'>): TerminalDefinition {
  return {
    name: `term-${over.id}`,
    cwd: '/tmp',
    groupId: null,
    shell: { kind: 'system-default' },
    autostart: false,
    protected: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/**
 * In-memory stand-in for a TerminalSession — no real pty. Records writes and lets each test
 * script start() behavior (succeed/throw/delay) so manager routing, lifecycle ordering and
 * shutdown gating can be exercised deterministically.
 */
class FakeSession extends EventEmitter {
  alive = false;
  buffer = '';
  writes: string[] = [];
  disposed = false;
  startCalls = 0;
  /** Override per-test: what start() does. Default: come alive and emit running. */
  startBehavior: () => Promise<TerminalRuntimeStatus> = async () => this.markRunning();

  constructor(public def: TerminalDefinition) {
    super();
  }

  private markRunning(): TerminalRuntimeStatus {
    this.alive = true;
    const s = this.getStatus();
    this.emit('status', s);
    return s;
  }

  getStatus(): TerminalRuntimeStatus {
    return { id: this.def.id, state: this.alive ? 'running' : 'stopped', cols: 80, rows: 30, exitCode: null };
  }
  updateDefinition(def: TerminalDefinition): { deferred: boolean } {
    this.def = def;
    return { deferred: this.alive };
  }
  async start(): Promise<TerminalRuntimeStatus> {
    this.startCalls += 1;
    return this.startBehavior();
  }
  async stop(): Promise<TerminalRuntimeStatus> {
    this.alive = false;
    return this.getStatus();
  }
  async restart(): Promise<TerminalRuntimeStatus> {
    return this.start();
  }
  write(data: string): boolean {
    if (!this.alive) return false;
    this.writes.push(data);
    this.emit('output', data);
    return true;
  }
  resize(): void {}
  flushPending(): void {}
  getBuffer(): string {
    return this.buffer;
  }
  isAlive(): boolean {
    return this.alive;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.alive = false;
    this.removeAllListeners();
  }
}

class TestManager extends TerminalManager {
  fakes = new Map<string, FakeSession>();
  protected override createSession(def: TerminalDefinition): TerminalSession {
    const f = new FakeSession(def);
    this.fakes.set(def.id, f);
    return f as unknown as TerminalSession;
  }
}

const opts = { appendNewline: false, startTerminalOnSend: false };

// --- routing: target resolution ---

test('routeInput "selected" keeps unknown ids so the client gets an UNKNOWN resync signal', async () => {
  const m = new TestManager();
  m.setDefinitions([makeDef({ id: 'a' })]);
  const result = await m.routeInput({ mode: 'selected', termIds: ['a', 'ghost', 'a'] }, 'hi', opts);
  // duplicates collapse; 'ghost' is reported, 'a' fails NOT_RUNNING (no live session, no autostart).
  assert.equal(result.matched, 2);
  assert.equal(result.written, 0);
  assert.deepEqual(
    result.failed.sort((x, y) => x.termId.localeCompare(y.termId)),
    [
      { termId: 'a', code: 'NOT_RUNNING' },
      { termId: 'ghost', code: 'UNKNOWN' },
    ],
  );
});

test('routeInput "group" fans out to every terminal in that group only', async () => {
  const m = new TestManager();
  m.setDefinitions([
    makeDef({ id: 'a', groupId: 'g1' }),
    makeDef({ id: 'b', groupId: 'g1' }),
    makeDef({ id: 'c', groupId: 'g2' }),
  ]);
  await m.start('a');
  await m.start('b');
  const result = await m.routeInput({ mode: 'group', groupId: 'g1' }, 'cmd', opts);
  assert.equal(result.matched, 2);
  assert.equal(result.written, 2);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(m.fakes.get('a')!.writes, ['cmd']);
  assert.deepEqual(m.fakes.get('b')!.writes, ['cmd']);
  assert.equal(m.fakes.get('c')?.writes.length ?? 0, 0);
});

test('routeInput "all" fans out to every definition', async () => {
  const m = new TestManager();
  m.setDefinitions([makeDef({ id: 'a' }), makeDef({ id: 'b' })]);
  await m.start('a');
  await m.start('b');
  const result = await m.routeInput({ mode: 'all' }, 'x', opts);
  assert.equal(result.matched, 2);
  assert.equal(result.written, 2);
});

test('routeInput appends a carriage return only when appendNewline is set', async () => {
  const m = new TestManager();
  m.setDefinitions([makeDef({ id: 'a' })]);
  await m.start('a');
  await m.routeInput({ mode: 'all' }, 'ls', { appendNewline: true, startTerminalOnSend: false });
  assert.deepEqual(m.fakes.get('a')!.writes, ['ls\r']);
});

// --- protected exclusion ---

test('routeInput never delivers a fan-out command to a protected terminal', async () => {
  const m = new TestManager();
  m.setDefinitions([makeDef({ id: 'a' }), makeDef({ id: 'guard', protected: true })]);
  await m.start('a');
  await m.start('guard');
  const result = await m.routeInput({ mode: 'all' }, 'rm -rf', opts);
  assert.equal(result.written, 1);
  assert.deepEqual(result.failed, [{ termId: 'guard', code: 'PROTECTED' }]);
  // The protected session's live pty must not have received anything.
  assert.equal(m.fakes.get('guard')!.writes.length, 0);
});

// --- start-on-send ---

test('routeInput auto-starts a stopped terminal when startTerminalOnSend is true', async () => {
  const m = new TestManager();
  m.setDefinitions([makeDef({ id: 'a' })]);
  const result = await m.routeInput({ mode: 'all' }, 'go', { appendNewline: false, startTerminalOnSend: true });
  assert.equal(result.written, 1);
  assert.equal(m.fakes.get('a')!.startCalls, 1);
  assert.deepEqual(m.fakes.get('a')!.writes, ['go']);
});

test('routeInput reports START_FAILED when an auto-start throws', async () => {
  class FailStart extends TestManager {
    protected override createSession(def: TerminalDefinition) {
      const s = super.createSession(def);
      this.fakes.get(def.id)!.startBehavior = async () => {
        throw new Error('spawn failed');
      };
      return s;
    }
  }
  const m = new FailStart();
  m.setDefinitions([makeDef({ id: 'a' })]);
  const result = await m.routeInput({ mode: 'all' }, 'go', { appendNewline: false, startTerminalOnSend: true });
  assert.deepEqual(result.failed, [{ termId: 'a', code: 'START_FAILED' }]);
  assert.equal(result.written, 0);
});

// --- fan-out events tagged by id ---

test('manager re-emits session output tagged with the terminal id', async () => {
  const m = new TestManager();
  m.setDefinitions([makeDef({ id: 'a' })]);
  const seen: Array<{ termId: string; data: string }> = [];
  m.on('output', (e) => seen.push(e));
  await m.start('a');
  m.write('a', 'hello');
  assert.deepEqual(seen, [{ termId: 'a', data: 'hello' }]);
});

// --- shutdown gating ---

test('start/restart are no-ops returning stopped status once shutdown has begun', async () => {
  const m = new TestManager();
  m.setDefinitions([makeDef({ id: 'a' })]);
  m.beginShutdown();
  const started = await m.start('a');
  assert.equal(started.state, 'stopped');
  const restarted = await m.restart('a');
  assert.equal(restarted.state, 'stopped');
  // No session should have been created/spawned during shutdown.
  assert.equal(m.fakes.has('a'), false);
});

test('autostartAll launches only autostart terminals and stops launching once shutdown begins mid-loop', async () => {
  const m = new TestManager();
  m.setDefinitions([
    makeDef({ id: 'a', autostart: true }),
    makeDef({ id: 'skip', autostart: false }),
    makeDef({ id: 'b', autostart: true }),
  ]);
  await m.autostartAll();
  assert.equal(m.fakes.get('a')!.startCalls, 1);
  assert.equal(m.fakes.has('skip'), false);
  assert.equal(m.fakes.get('b')!.startCalls, 1);
});

test('autostartAll swallows a failing terminal start and continues with the rest', async () => {
  class FailFirst extends TestManager {
    protected override createSession(def: TerminalDefinition) {
      const s = super.createSession(def);
      if (def.id === 'bad') {
        (this.fakes.get('bad') as FakeSession).startBehavior = async () => {
          throw new Error('boom');
        };
      }
      return s;
    }
  }
  const m = new FailFirst();
  m.setDefinitions([makeDef({ id: 'bad', autostart: true }), makeDef({ id: 'good', autostart: true })]);
  await m.autostartAll(); // must not throw
  assert.equal(m.fakes.get('good')!.startCalls, 1);
});

// --- remove / lifecycle ---

test('remove deletes the definition first then disposes the live session', async () => {
  const m = new TestManager();
  m.setDefinitions([makeDef({ id: 'a' })]);
  await m.start('a');
  const fake = m.fakes.get('a')!;
  await m.remove('a');
  assert.equal(m.getDefinition('a'), undefined, 'definition must be gone');
  assert.equal(fake.disposed, true, 'live session must be disposed');
  // A subsequent route can no longer resolve the id.
  const result = await m.routeInput({ mode: 'selected', termIds: ['a'] }, 'x', opts);
  assert.deepEqual(result.failed, [{ termId: 'a', code: 'UNKNOWN' }]);
});

test('stop on a known-but-never-started terminal is an idempotent no-op (not an error)', async () => {
  const m = new TestManager();
  m.setDefinitions([makeDef({ id: 'a' })]);
  const status = await m.stop('a');
  assert.equal(status.state, 'stopped');
});

test('stop / start / restart on a completely unknown id throw', async () => {
  const m = new TestManager();
  await assert.rejects(() => m.start('nope'), /unknown terminal/);
  await assert.rejects(() => m.stop('nope'), /unknown terminal/);
  await assert.rejects(() => m.restart('nope'), /unknown terminal/);
});

test('resize is remembered for a terminal with no live session and reused on next start', async () => {
  const m = new TestManager();
  m.setDefinitions([makeDef({ id: 'a' })]);
  m.resize('a', 120, 40); // no session yet — just remembered
  assert.equal(m.fakes.has('a'), false);
  await m.start('a');
  assert.equal(m.fakes.get('a')!.startCalls, 1);
});

test('killAll disposes every session and clears the registry', async () => {
  const m = new TestManager();
  m.setDefinitions([makeDef({ id: 'a' }), makeDef({ id: 'b' })]);
  await m.start('a');
  await m.start('b');
  const a = m.fakes.get('a')!;
  const b = m.fakes.get('b')!;
  await m.killAll();
  assert.equal(a.disposed, true);
  assert.equal(b.disposed, true);
  assert.equal(m.hasSession('a'), false);
  assert.equal(m.hasSession('b'), false);
});
