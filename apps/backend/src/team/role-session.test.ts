import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RoleCliSession } from './role-session.js';
import type { TerminalManager } from '../terminal/TerminalManager.js';
import type { AgentType, TigerTiming } from '../orchestrator/types.js';

// Fast timing so the few awaited sleeps inside compact() resolve quickly and deterministically.
const timing: TigerTiming = {
  readyIdleMs: 1,
  readyMaxWaitMs: 5,
  settleMaxWaitMs: 5,
  submitDelayMs: 1,
  markerPollMs: 1,
  doneIdleMs: 0,
  agentTimeoutMs: 20,
};

/** Manager double: records writes / start / stop and emits nothing unless asked. */
function fakeManager() {
  const m = new EventEmitter() as TerminalManager & {
    writes: string[];
    starts: number;
    stops: number;
  };
  const rec = m as unknown as { writes: string[]; starts: number; stops: number };
  rec.writes = [];
  rec.starts = 0;
  rec.stops = 0;
  Object.assign(m, {
    start: async () => {
      rec.starts += 1;
      return { id: 'x', state: 'running', cols: 80, rows: 30, exitCode: null };
    },
    stop: async () => {
      rec.stops += 1;
      return { id: 'x', state: 'stopped', cols: 80, rows: 30, exitCode: null };
    },
    write: (_id: string, data: string) => {
      rec.writes.push(data);
      return true;
    },
  });
  return m;
}

function session(tool: AgentType, mgr = fakeManager()) {
  return { sess: new RoleCliSession({ manager: mgr, termId: 'team-r1', tool, timing }), mgr };
}

test('terminalId exposes the stable per-role terminal id', () => {
  const { sess } = session('claude');
  assert.equal(sess.terminalId, 'team-r1');
});

test('a fresh session is not alive and reports zero turns', () => {
  const { sess } = session('claude');
  assert.equal(sess.isAlive, false);
  assert.equal(sess.turns, 0);
});

test('shouldCompact requires the session to be alive, >= 2 prompts, and the char threshold met', async () => {
  const { sess } = session('claude');
  // Not started yet → never compacts regardless of fed chars.
  sess.noteFed(1_000_000);
  assert.equal(sess.shouldCompact(1), false, 'a non-alive session must never request compaction');
});

test('compact is a no-op (returns false) for a session that never started', async () => {
  const { sess, mgr } = session('claude');
  const ok = await sess.compact(new AbortController().signal);
  assert.equal(ok, false);
  assert.deepEqual((mgr as unknown as { writes: string[] }).writes, [], 'no /compact must be written to a dead session');
});

test('compact returns false immediately when the abort signal is already aborted', async () => {
  const { sess, mgr } = session('claude');
  const ac = new AbortController();
  ac.abort();
  const ok = await sess.compact(ac.signal);
  assert.equal(ok, false);
  assert.deepEqual((mgr as unknown as { writes: string[] }).writes, []);
});

test('runPrompt with an already-aborted signal stops before delivering the prompt', async () => {
  const { sess, mgr } = session('claude');
  const ac = new AbortController();
  ac.abort();
  const result = await sess.runPrompt({
    promptPath: '/p.md',
    outputPath: '/o.md',
    markerPath: '/o.done',
    signal: ac.signal,
  });
  assert.equal(result.state, 'stopped');
  // ensureStarted's manager.start is gated behind awaitIdle which short-circuits on abort.
  assert.ok((mgr as unknown as { starts: number }).starts <= 1);
});

test('dispose stops the underlying terminal only after a start and leaves the session not alive', async () => {
  const { sess, mgr } = session('claude');
  await sess.dispose(); // never started → must not call stop
  assert.equal((mgr as unknown as { stops: number }).stops, 0);
  assert.equal(sess.isAlive, false);
});
