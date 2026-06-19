import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEntries, probeUsage } from './usage.js';
import type { TerminalManager } from '../terminal/TerminalManager.js';

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

test('probeUsage reports Antigravity as an explicit unsupported probe without launching agy', () => {
  // The manager must never be touched — antigravity has no usage command, so the probe short-circuits.
  const trap = new Proxy(
    {},
    {
      get() {
        throw new Error('probeUsage must not launch agy for the antigravity provider');
      },
    },
  ) as unknown as TerminalManager;

  return probeUsage(trap, 'antigravity').then((probe) => {
    assert.equal(probe.type, 'antigravity');
    assert.equal(probe.ok, false);
    assert.equal(probe.entries.length, 0);
    assert.match(probe.error ?? '', /no usage\/limit command/i);
  });
});
