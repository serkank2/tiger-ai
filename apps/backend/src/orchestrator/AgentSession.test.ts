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

async function runFakeWithOutput(mode: string, overrides: Partial<TigerTiming> = {}) {
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
    const result = await session.run(new AbortController().signal);
    const returnedAt = Date.now();
    const output = await fs.readFile(outputPath, 'utf8').catch(() => '');
    // The output file's last-modified time is the moment the agent stopped writing to it. A
    // correct stability gate cannot return until the file has been unchanged for >= doneIdleMs,
    // so `idleAfterLastWriteMs` is at least ~doneIdleMs for a gated run, but ~0 for a gate-less
    // run that completes on the first quiet poll (i.e. while the file is still being written).
    const stat = await fs.stat(outputPath).catch(() => null);
    const idleAfterLastWriteMs = stat ? returnedAt - stat.mtimeMs : null;
    return { result, output, idleAfterLastWriteMs };
  } finally {
    await manager.remove(termId).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runFake(mode: string, overrides: Partial<TigerTiming> = {}) {
  return (await runFakeWithOutput(mode, overrides)).result;
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

test('waits for output file stability before idle completion', async () => {
  // Acceptance criterion #1: an agent whose output file is still being written must NOT be
  // idle-completed mid-write. The `growing-idle` fake appends to the file for ~1.4s (longer than
  // the idle threshold), then writes a distinctive `final chunk` line. A correct gate keeps
  // waiting until the file settles; a gate-less implementation would complete on the first quiet
  // poll and capture a partial file. Both assertions below fail under such an implementation.
  const doneIdleMs = 300;
  const { result, output, idleAfterLastWriteMs } = await runFakeWithOutput('growing-idle', {
    doneIdleMs,
    markerPollMs: 50,
    agentTimeoutMs: 8000,
  });
  assert.equal(result.state, 'completed');
  assert.equal(result.completion, 'idle');
  // (1) The complete file was captured. `final chunk` is only written after every `partial chunk`,
  //     so a run that completed mid-write would be missing it (and the late chunks) and fail here.
  assert.match(output, /partial chunk 15\nfinal chunk\n/);
  // (2) The run did not return until the output file had been idle for ~doneIdleMs — the gate's
  //     contract. A gate-less idle path returns within a poll of the last write (gap ≈ 0ms) even
  //     if timing happened to let it capture the whole file, so this independently discriminates
  //     it. The tolerance absorbs filesystem mtime granularity and clock skew.
  assert.ok(
    idleAfterLastWriteMs !== null && idleAfterLastWriteMs >= doneIdleMs - 100,
    `expected the run to stay idle >= ${doneIdleMs - 100}ms after the final output write, but it ` +
      `returned ${idleAfterLastWriteMs}ms after it (a gate-less idle path would be ~0ms)`,
  );
});

test('fails on timeout when the agent neither outputs nor signals completion', async () => {
  const r = await runFake('hang', { doneIdleMs: 0, agentTimeoutMs: 1500 });
  assert.equal(r.state, 'failed');
  assert.match(r.error ?? '', /timed out/);
});
