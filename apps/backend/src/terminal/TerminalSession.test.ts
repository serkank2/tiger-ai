import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TerminalSession } from './TerminalSession.js';
import { TerminalManager } from './TerminalManager.js';
import type { TerminalDefinition } from '../store/types.js';

function makeDef(over: Partial<TerminalDefinition> & Pick<TerminalDefinition, 'id' | 'cwd'>): TerminalDefinition {
  return {
    name: 'test-term',
    groupId: null,
    shell: { kind: 'system-default' },
    autostart: false,
    protected: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** Two distinct existing directories so cwd changes are observable. */
async function makeDirs(): Promise<{ a: string; b: string; cleanup: () => Promise<void> }> {
  const a = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-term-a-'));
  const b = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-term-b-'));
  return {
    a,
    b,
    cleanup: async () => {
      await fs.rm(a, { recursive: true, force: true });
      await fs.rm(b, { recursive: true, force: true });
    },
  };
}

test('editing a STOPPED session applies immediately and is not deferred', async () => {
  const { a, b, cleanup } = await makeDirs();
  try {
    const defA = makeDef({ id: 't1', cwd: a, initialCommand: 'echo first' });
    const session = new TerminalSession(defA);

    assert.equal(session.getEffectiveDefinition().cwd, a);

    const defB = makeDef({ id: 't1', cwd: b, initialCommand: 'echo second' });
    const result = session.updateDefinition(defB);

    // Not running → applies right away, no restart needed.
    assert.equal(result.deferred, false);
    assert.equal(session.getEffectiveDefinition().cwd, b);
    assert.equal(session.getEffectiveDefinition().initialCommand, 'echo second');
  } finally {
    await cleanup();
  }
});

test('the session stores a copy so external in-place mutation cannot leak in', async () => {
  const { a, b, cleanup } = await makeDirs();
  try {
    const def = makeDef({ id: 't2', cwd: a });
    const session = new TerminalSession(def);

    // Simulate the HTTP PUT route mutating the shared state object in place.
    def.cwd = b;

    assert.equal(session.getEffectiveDefinition().cwd, a, 'effective def must be decoupled from the source object');
  } finally {
    await cleanup();
  }
});

test('editing a RUNNING session is deferred and promoted on restart', async (t) => {
  const { a, b, cleanup } = await makeDirs();
  let session: TerminalSession | undefined;
  try {
    const defA = makeDef({ id: 't3', cwd: a, initialCommand: undefined });
    session = new TerminalSession(defA);

    let status;
    try {
      status = await session.start();
    } catch (err) {
      // This is the ONLY test that exercises the running-edit guard (AC#1): an edit to a live
      // session must defer without touching the active pty. A pty spawn failure must NOT silently
      // pass the suite — otherwise a CI/sandbox runner with no usable node-pty backend would report
      // green while leaving this guard completely unverified, masking a potential regression.
      // Default: let the failure surface. An operator who knowingly runs without a pty can opt into
      // skipping via KAPLAN_ALLOW_PTY_SKIP, which still records a visible skip (never a silent pass).
      await session.dispose().catch(() => {});
      session = undefined;
      if (process.env.KAPLAN_ALLOW_PTY_SKIP) {
        t.skip(`pty unavailable and KAPLAN_ALLOW_PTY_SKIP set: ${String(err)}`);
        return;
      }
      throw err;
    }
    assert.equal(status.state, 'running');
    const livePid = status.pid;

    // Edit while running: must defer, must NOT mutate the live/effective definition, and must
    // NOT inject the newly edited initial command into the active session.
    const defB = makeDef({ id: 't3', cwd: b, initialCommand: 'echo SHOULD_RUN_ON_RESTART_ONLY' });
    const result = session.updateDefinition(defB);

    assert.equal(result.deferred, true, 'editing a running terminal must report a deferred change');
    assert.equal(session.getEffectiveDefinition().cwd, a, 'live effective cwd must be unchanged');
    assert.equal(
      session.getEffectiveDefinition().initialCommand,
      undefined,
      'the edited initial command must not be applied to the running session',
    );
    assert.equal(session.getStatus().state, 'running', 'the live pty must stay running across an edit');
    assert.equal(session.getStatus().pid, livePid, 'the live pty must not be respawned by an edit');

    // Restarting promotes the deferred definition.
    const after = await session.restart();
    assert.equal(after.state, 'running');
    assert.equal(session.getEffectiveDefinition().cwd, b, 'restart must adopt the deferred cwd');
    assert.equal(
      session.getEffectiveDefinition().initialCommand,
      'echo SHOULD_RUN_ON_RESTART_ONLY',
      'restart must adopt the deferred initial command',
    );
  } finally {
    if (session) await session.dispose().catch(() => {});
    await cleanup();
  }
});

test('TerminalManager.upsertDefinition reports no deferral when nothing is running', async () => {
  const { a, b, cleanup } = await makeDirs();
  try {
    const manager = new TerminalManager();
    const defA = makeDef({ id: 't4', cwd: a });
    manager.setDefinitions([defA]);

    // No live session has been created → the edit applies immediately, not deferred.
    const defB = makeDef({ id: 't4', cwd: b });
    const result = manager.upsertDefinition(defB);

    assert.equal(result.deferred, false);
    assert.equal(manager.getDefinition('t4')?.cwd, b);
  } finally {
    await cleanup();
  }
});
