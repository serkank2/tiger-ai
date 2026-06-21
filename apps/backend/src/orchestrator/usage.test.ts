import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEntries, probeUsage } from './usage.js';
import type { TerminalManager } from '../terminal/TerminalManager.js';

// A minimal in-memory TerminalManager double for probeUsage. It emits an `exit` event right after
// `start()` so probeUsage's idle-wait loops return immediately (keeping these tests fast), then
// serves the supplied buffer text as the captured PTY scrollback.
function makeFakeManager(buffer: string): { manager: TerminalManager; started: boolean } {
  const handlers: Record<string, Array<(arg: unknown) => void>> = {};
  const state = { started: false, id: '' };
  const emit = (name: string, arg: unknown) => (handlers[name] ?? []).forEach((fn) => fn(arg));
  const manager = {
    on(name: string, fn: (arg: unknown) => void) {
      (handlers[name] ??= []).push(fn);
    },
    off(name: string, fn: (arg: unknown) => void) {
      handlers[name] = (handlers[name] ?? []).filter((f) => f !== fn);
    },
    upsertDefinition(def: { id: string }) {
      state.id = def.id;
    },
    async start() {
      state.started = true;
      // Signal the probe's waitIdle loops to return without waiting out the full timeouts.
      emit('exit', { id: state.id });
    },
    write() {},
    getBuffer() {
      return buffer;
    },
    async remove() {},
  } as unknown as TerminalManager;
  // Expose `started` via a getter so callers observe the latest value.
  return {
    manager,
    get started() {
      return state.started;
    },
  } as { manager: TerminalManager; started: boolean };
}

// Fixtures mirror the real (ANSI-stripped) panels captured from claude /usage and codex /status,
// including the fragmented line-wrapping and TUI noise the scraper produces.

const CLAUDE = `
Settings
  Status   Config
Stats
Session
Total
cost:
$0.0000
Current
session
████████▌
 17% used
Resets 5:20am (Europe/Istanbul)
Current
week
(all
models)
█████████████████████
 42% used
Resets Jun 18, 9pm (Europe/Istanbul)
What's contributing to your limits usage?
76% of your usage was at >150k context
Explore                         1%
`;

const CODEX = `
gpt-5.5 default
›
 /status
5h limit:
[███████████████████░] 97% left
 (resets 06:38)
›
 /status
Weekly limit:
[██████████████████░░] 91% left
(resets 22:24 on 22 Jun)
`;

test('parseEntries extracts Claude session/week usage with labels and resets', () => {
  const entries = parseEntries(CLAUDE);
  assert.equal(entries.length, 2); // the "76% of your usage" / "Explore 1%" lines are not used/left figures
  assert.deepEqual(
    entries.map((e) => ({ label: e.label, percent: e.percent, metric: e.metric })),
    [
      { label: 'Current session', percent: 17, metric: 'used' },
      { label: 'Current week (all models)', percent: 42, metric: 'used' },
    ],
  );
  assert.match(entries[0]!.reset ?? '', /5:20am/);
  assert.match(entries[1]!.reset ?? '', /Jun 18/);
});

test('parseEntries extracts Codex limits (percent left) ignoring /status noise', () => {
  const entries = parseEntries(CODEX);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => ({ label: e.label, percent: e.percent, metric: e.metric })),
    [
      { label: '5h limit', percent: 97, metric: 'left' },
      { label: 'Weekly limit', percent: 91, metric: 'left' },
    ],
  );
  assert.match(entries[0]!.reset ?? '', /06:38/);
});

test('parseEntries de-duplicates identical figures', () => {
  const dup = `5h limit:\n97% left\n5h limit:\n97% left`;
  assert.equal(parseEntries(dup).length, 1);
});

test('probeUsage best-effort probes Antigravity and returns a clear message when agy exposes no usage', async () => {
  // Antigravity is now probed best-effort: agy IS launched, but if the captured panel has no
  // parseable "N% used/left" figure (e.g. agy has no /usage command in this version), the probe
  // returns ok:false with a human-readable reason rather than fabricating usage or hard-failing.
  const fake = makeFakeManager('Antigravity\nType a message...\nUnknown command: /usage');

  const probe = await probeUsage(fake.manager, 'antigravity');
  assert.equal(fake.started, true, 'best-effort probe must attempt to launch agy');
  assert.equal(probe.type, 'antigravity');
  assert.equal(probe.ok, false);
  assert.equal(probe.entries.length, 0);
  assert.match(probe.error ?? '', /could not read antigravity usage/i);
  assert.match(probe.error ?? '', /agy may not expose a usage command/i);
});

test('probeUsage parses Antigravity usage when agy does expose a usage panel', async () => {
  // If a future agy build renders a parseable used/left panel, the existing parser applies unchanged.
  const fake = makeFakeManager('Weekly limit:\n42% used\nResets Jun 28');

  const probe = await probeUsage(fake.manager, 'antigravity');
  assert.equal(probe.type, 'antigravity');
  assert.equal(probe.ok, true);
  assert.equal(probe.entries.length, 1);
  assert.equal(probe.entries[0]!.percent, 42);
  assert.equal(probe.entries[0]!.metric, 'used');
});
