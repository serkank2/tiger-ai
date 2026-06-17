import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TerminalManager } from '../terminal/TerminalManager.js';
import { AgentSession } from './AgentSession.js';
import type { TigerTiming } from './types.js';

// Integration tests for the completion-detection loop. They drive a real PTY (node-pty) running a
// fake CLI, so they validate launch → readiness → instruction → marker/exit/idle/timeout end to end
// without the cost or nondeterminism of the real Claude/Codex CLIs.

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');

function timing(overrides: Partial<TigerTiming> = {}): TigerTiming {
  return {
    readyIdleMs: 300,
    readyMaxWaitMs: 4000,
    doneIdleMs: 60000,
    markerPollMs: 150,
    agentTimeoutMs: 10000,
    settleMaxWaitMs: 2000,
    submitDelayMs: 200,
    ...overrides,
  };
}

async function runFake(mode: string, overrides: Partial<TigerTiming> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-agent-'));
  const manager = new TerminalManager();
  const termId = `run-${mode}`;
  const outputPath = path.join(dir, 'out.md');
  const markerPath = path.join(dir, 'run.done');
  const now = new Date().toISOString();
  manager.upsertDefinition({
    id: termId,
    name: termId,
    groupId: null,
    cwd: dir,
    // Custom shell = node running the fake directly, so the PTY's process IS the fake (clean exit).
    shell: {
      kind: 'custom',
      path: process.execPath,
      args: [FAKE, '--out', outputPath, '--marker', markerPath, '--mode', mode],
    },
    protected: true,
    createdAt: now,
    updatedAt: now,
  });
  const session = new AgentSession({
    manager,
    termId,
    label: termId,
    command: '(fake)',
    cwd: dir,
    promptPath: path.join(dir, 'prompt.md'),
    outputPath,
    markerPath,
    timing: timing(overrides),
  });
  try {
    return await session.run(new AbortController().signal);
  } finally {
    await manager.remove(termId).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test('completes via the .done marker (primary trigger)', async () => {
  const r = await runFake('marker');
  assert.equal(r.state, 'completed');
  assert.equal(r.completion, 'marker');
});

test('completes via exit when output exists but no marker was written', async () => {
  const r = await runFake('exit');
  assert.equal(r.state, 'completed');
  assert.equal(r.completion, 'exit');
});

test('fails when the CLI exits without producing valid output', async () => {
  const r = await runFake('missing');
  assert.equal(r.state, 'failed');
});

test('completes via the output-idle fallback when no marker and no exit', async () => {
  const r = await runFake('idle', { doneIdleMs: 700, agentTimeoutMs: 15000 });
  assert.equal(r.state, 'completed');
  assert.equal(r.completion, 'idle');
});

test('fails on timeout when the agent neither outputs nor signals completion', async () => {
  const r = await runFake('hang', { doneIdleMs: 0, agentTimeoutMs: 1500 });
  assert.equal(r.state, 'failed');
  assert.match(r.error ?? '', /timed out/);
});
