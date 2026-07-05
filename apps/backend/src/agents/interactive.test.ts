import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  runInteractiveTurn,
  resolvePtyCommand,
  cleanInteractiveOutput,
  type InteractivePty,
  type InteractivePtySpawn,
} from './interactive.js';
import { defaultTigerConfig } from '../orchestrator/config.js';
import type { AgentEvent } from './events.js';

const cfg = defaultTigerConfig();
// ESC built at runtime so this source file stays ASCII-clean (no raw control bytes).
const ESC = String.fromCharCode(27);

/** A controllable fake PTY: capture writes, push data/exit, observe kill. */
function fakePty() {
  let dataCb: ((d: string) => void) | null = null;
  let exitCb: ((e: { exitCode: number }) => void) | null = null;
  const writes: string[] = [];
  let killed = false;
  const pty: InteractivePty = {
    write: (data) => writes.push(data),
    onData: (cb) => {
      dataCb = cb;
      return { dispose: () => (dataCb = null) };
    },
    onExit: (cb) => {
      exitCb = cb;
      return { dispose: () => (exitCb = null) };
    },
    kill: () => {
      killed = true;
    },
  };
  return {
    pty,
    writes,
    emitData: (d: string) => dataCb?.(d),
    emitExit: (code: number) => exitCb?.({ exitCode: code }),
    wasKilled: () => killed,
  };
}

async function scratch(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-int-'));
}

const baseOpts = (dir: string, spawn: InteractivePtySpawn, events: AgentEvent[] = []) => ({
  provider: 'claude' as const,
  tool: cfg.cli.claude,
  prompt: 'Do the task.',
  allowDangerous: false,
  cwd: dir,
  scratchDir: dir,
  hardTimeoutMs: 10_000,
  pollMs: 20,
  seedDelayMs: 10,
  submitDelayMs: 10,
  ptySpawn: spawn,
  onEvent: (e: AgentEvent) => events.push(e),
});

test('interactive: seeds the brief, streams output, and completes when the result file appears', async () => {
  const dir = await scratch();
  const fake = fakePty();
  const events: AgentEvent[] = [];
  const controller = runInteractiveTurn(baseOpts(dir, () => fake.pty, events));

  // The brief is seeded into the PTY (after a short delay), with the result-file contract.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(fake.writes[0]!.includes('Do the task.'));
  assert.ok(fake.writes[0]!.includes('KAPLAN_RESULT_FILE') || fake.writes[0]!.includes('interactive-result.json'));
  // …then a SEPARATE Enter is sent to submit the paste (not part of the brief write).
  assert.ok(fake.writes.slice(1).includes('\r'), 'submit Enter sent separately after the brief');

  // TUI output (with ANSI colour codes) streams out as plain text — coalesced
  // and emitted on the ~200ms flush, so wait for it.
  fake.emitData(ESC + '[32mworking done' + ESC + '[0m\r\n');
  await new Promise((r) => setTimeout(r, 260));
  const streamed = events.find((e) => e.type === 'text' && e.text?.includes('working done'));
  assert.ok(streamed, 'TUI text streamed as an agent event');
  assert.ok(!streamed?.text?.includes(ESC), 'ANSI stripped from streamed text');

  // The agent writes its structured result → the turn completes on the next poll.
  await fs.writeFile(path.join(dir, 'interactive-result.json'), '{"status":"done","summary":"finished it"}', 'utf8');
  const report = await controller.promise;
  assert.equal(report.state, 'completed');
  assert.equal(report.result?.summary, 'finished it');
  assert.ok(fake.wasKilled(), 'PTY torn down on completion');
});

test('interactive: auto-answers the first-run "trust this directory?" dialog with Enter', async () => {
  const dir = await scratch();
  const fake = fakePty();
  // Large seed delay so the brief isn't seeded before the trust prompt arrives
  // (auto-answering only runs until the brief is seeded).
  const controller = runInteractiveTurn({ ...baseOpts(dir, () => fake.pty), seedDelayMs: 5000 });
  await new Promise((r) => setTimeout(r, 40)); // let the PTY spawn + onData register
  fake.emitData('  Do you trust the contents of this directory?\r\n  1. Yes, continue\r\n  2. No, quit');
  assert.ok(fake.writes.includes('\r'), 'a bare Enter was sent to accept the highlighted "Yes, continue" default');
  // The brief has NOT been pasted yet (still clearing the dialog).
  assert.ok(!fake.writes.some((w) => w.includes('Do the task.')));
  controller.abort('cleanup');
  await controller.promise;
});

test('interactive: user keystrokes route into the live PTY', async () => {
  const dir = await scratch();
  const fake = fakePty();
  const controller = runInteractiveTurn(baseOpts(dir, () => fake.pty));
  await new Promise((r) => setTimeout(r, 50));
  const before = fake.writes.length;
  controller.write('/compact\r');
  assert.equal(fake.writes.at(-1), '/compact\r');
  assert.ok(fake.writes.length > before);
  controller.abort('cleanup');
  await controller.promise;
});

test('interactive: user "complete" without a result file still resolves as done', async () => {
  const dir = await scratch();
  const fake = fakePty();
  const controller = runInteractiveTurn(baseOpts(dir, () => fake.pty));
  await new Promise((r) => setTimeout(r, 50));
  controller.complete();
  const report = await controller.promise;
  assert.equal(report.state, 'completed');
  assert.match(report.result?.summary ?? '', /user/i);
});

test('cleanInteractiveOutput strips OSC titles + spinner glyphs and collapses repaints', () => {
  const BEL = String.fromCharCode(7);
  const spinner = String.fromCharCode(0x280b); // ⠋
  const noisy = [
    ESC + ']0;' + spinner + ' yetisio' + BEL, // OSC window-title (the "0;… yetisio" spam)
    spinner + spinner + spinner, // a pure-spinner animation line
    '  Working (7s)  ',
    '  Working (7s)  ', // duplicate repaint of the same status line
    ESC + '[32mI edited main.ts' + ESC + '[0m',
  ].join('\n');
  const cleaned = cleanInteractiveOutput(noisy);
  assert.ok(!cleaned.includes('yetisio'), 'OSC title payload removed');
  assert.ok(!/[⠀-⣿]/.test(cleaned), 'spinner glyphs removed');
  assert.ok(cleaned.includes('I edited main.ts'), 'real assistant text kept');
  assert.equal((cleaned.match(/Working \(7s\)/g) ?? []).length, 1, 'duplicate repaint collapsed to one');
});

test('resolvePtyCommand passes an absolute executable through unchanged (node-pty has no PATH search)', () => {
  // process.execPath is an absolute path with a known extension on every OS —
  // the resolver must return it verbatim with the args preserved (this is the
  // fix for interactive "Cannot create process, error code: 2" on Windows).
  const env = { PATH: process.env.PATH ?? '', Path: process.env.Path ?? '' } as Record<string, string>;
  const out = resolvePtyCommand(process.execPath, ['--version'], env);
  assert.equal(out.command, process.execPath);
  assert.deepEqual(out.args, ['--version']);
});

test('interactive: a non-zero PTY exit with no result file fails the turn', async () => {
  const dir = await scratch();
  const fake = fakePty();
  const controller = runInteractiveTurn(baseOpts(dir, () => fake.pty));
  await new Promise((r) => setTimeout(r, 50));
  fake.emitExit(1);
  const report = await controller.promise;
  assert.equal(report.state, 'failed');
  assert.match(report.error ?? '', /exited with code 1/);
});
