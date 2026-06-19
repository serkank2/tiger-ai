import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesFilter, pathMatches } from './matching.js';
import { buildVars, renderTemplate, renderPrompt, truncate } from './template.js';
import { FanInTracker } from './fanin.js';
import { KeyedDebouncer, type DebounceTimers } from './debounce.js';
import { msUntil, parseIntervalSpec } from './schedule.js';
import { normalizeConfig } from './config-loader.js';
import { isIgnoredPath } from './file-watcher.js';
import type { CueSubscription } from './types.js';

function sub(partial: Partial<CueSubscription>): CueSubscription {
  return {
    id: 'x',
    event: 'file.changed',
    target: { kind: 'queue' },
    prompt: 'hi',
    enabled: true,
    ...partial,
  };
}

// --- subscription matching ---

test('matchesFilter rejects mismatched event type', () => {
  assert.equal(matchesFilter(sub({ event: 'file.changed' }), { event: 'time.scheduled' }), false);
});

test('matchesFilter treats unset filter as wildcard', () => {
  assert.equal(matchesFilter(sub({ event: 'file.changed' }), { event: 'file.changed', filePath: '/a/b.ts' }), true);
});

test('matchesFilter honors file changeType + pathIncludes', () => {
  const s = sub({ event: 'file.changed', filter: { changeType: 'modified', pathIncludes: 'src/' } });
  assert.equal(matchesFilter(s, { event: 'file.changed', changeType: 'modified', filePath: '/repo/src/a.ts' }), true);
  assert.equal(matchesFilter(s, { event: 'file.changed', changeType: 'deleted', filePath: '/repo/src/a.ts' }), false);
  assert.equal(matchesFilter(s, { event: 'file.changed', changeType: 'modified', filePath: '/repo/test/a.ts' }), false);
});

test('matchesFilter honors agent triggeredBy', () => {
  const s = sub({ event: 'agent.completed', filter: { triggeredBy: 'team' } });
  assert.equal(matchesFilter(s, { event: 'agent.completed', extra: { triggeredBy: 'team' } }), true);
  assert.equal(matchesFilter(s, { event: 'agent.completed', extra: { triggeredBy: 'tiger' } }), false);
});

test('matchesFilter rejects disabled subscription', () => {
  assert.equal(matchesFilter(sub({ enabled: false }), { event: 'file.changed' }), false);
});

test('pathMatches: substring vs glob, case + slash insensitive', () => {
  assert.equal(pathMatches('C:\\repo\\src\\App.ts', 'src/app.ts'), true);
  assert.equal(pathMatches('/repo/src/a.ts', '*.ts'), true);
  assert.equal(pathMatches('/repo/src/a.js', '*.ts'), false);
  assert.equal(pathMatches('/repo/src/a.spec.ts', 'src/*.spec.*'), true);
});

// --- template rendering ---

test('renderTemplate substitutes vars and blanks unknowns', () => {
  assert.equal(renderTemplate('A {{ FOO }} B {{BAR}}', { FOO: '1' }), 'A 1 B ');
});

test('buildVars + renderPrompt expose documented vars', () => {
  const out = renderPrompt('{{CUE_EVENT}}|{{CUE_FILE_PATH}}|{{CUE_CHANGE_TYPE}}', {
    event: 'file.changed',
    filePath: '/a/b.ts',
    changeType: 'modified',
  });
  assert.equal(out, 'file.changed|/a/b.ts|modified');
});

test('buildVars truncates CUE_SOURCE_OUTPUT and merges extra', () => {
  const big = 'x'.repeat(5000);
  const vars = buildVars({ event: 'agent.completed', sourceOutput: big, extra: { TICKET: 'K-9' } });
  assert.ok(vars.CUE_SOURCE_OUTPUT!.length < big.length);
  assert.match(vars.CUE_SOURCE_OUTPUT!, /truncated/);
  assert.equal(vars.TICKET, 'K-9');
});

test('truncate is a no-op under the limit', () => {
  assert.equal(truncate('short', 10), 'short');
});

// --- fan-in accounting ---

test('FanInTracker fires only after all sources land, then resets', () => {
  const fan = new FanInTracker(['Build', 'Test']);
  assert.equal(fan.isTrivial, false);
  assert.equal(fan.record('build'), false); // case-insensitive
  assert.deepEqual(fan.pending(), ['test']);
  assert.equal(fan.record('test'), true);
  fan.reset();
  assert.deepEqual(fan.pending().sort(), ['build', 'test']);
});

test('FanInTracker ignores unrelated sources and is trivial when empty', () => {
  const fan = new FanInTracker(['a']);
  assert.equal(fan.record('zzz'), false);
  assert.equal(fan.isReady(), false);
  assert.equal(new FanInTracker([]).isTrivial, true);
});

// --- debounce ---

test('KeyedDebouncer collapses rapid calls per key to one trailing fire', () => {
  let now = 0;
  const scheduled: { id: number; fn: () => void; at: number }[] = [];
  let idSeq = 1;
  const timers: DebounceTimers = {
    schedule: (fn, ms) => {
      const id = idSeq++;
      scheduled.push({ id, fn, at: now + ms });
      return id;
    },
    cancel: (h) => {
      const i = scheduled.findIndex((s) => s.id === h);
      if (i >= 0) scheduled.splice(i, 1);
    },
  };
  const d = new KeyedDebouncer(500, timers);
  let fires = 0;
  d.trigger('k', () => fires++);
  d.trigger('k', () => fires++); // replaces the first
  assert.equal(d.size, 1);
  // advance: run the single pending timer
  now = 600;
  const due = scheduled.filter((s) => s.at <= now);
  assert.equal(due.length, 1);
  due[0]!.fn();
  assert.equal(fires, 1);
  assert.equal(d.size, 0);
});

// --- schedule parsing ---

test('parseIntervalSpec parses units, bare ms, and enforces a floor', () => {
  assert.equal(parseIntervalSpec('30s'), 30_000);
  assert.equal(parseIntervalSpec('5m'), 300_000);
  assert.equal(parseIntervalSpec('1h'), 3_600_000);
  assert.equal(parseIntervalSpec('250ms'), 1000); // floored to MIN_INTERVAL_MS
  assert.equal(parseIntervalSpec(2000), 2000);
  assert.equal(parseIntervalSpec('garbage'), null);
  assert.equal(parseIntervalSpec(undefined), null);
});

test('msUntil clamps past times to 0 and rejects invalid dates', () => {
  const base = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(msUntil('2026-01-01T00:00:10Z', base), 10_000);
  assert.equal(msUntil('2025-01-01T00:00:00Z', base), 0);
  assert.equal(msUntil('not-a-date', base), null);
  assert.equal(msUntil(undefined, base), null);
});

// --- config normalization ---

test('normalizeConfig keeps valid subs and reports invalid ones', () => {
  const { subscriptions, warnings } = normalizeConfig({
    subscriptions: [
      { id: 'ok', event: 'file.changed', prompt: 'go', target: { kind: 'queue' } },
      { event: 'file.changed', prompt: 'go', target: { kind: 'queue' } }, // no id
      { id: 'noprompt', event: 'file.changed', target: { kind: 'queue' } },
      { id: 'badevent', event: 'nope', prompt: 'x', target: { kind: 'queue' } },
      { id: 'badtarget', event: 'cli.trigger', prompt: 'x', target: { kind: 'nope' } },
      { id: 'ok', event: 'cli.trigger', prompt: 'dup', target: { kind: 'team' } }, // dup id
    ],
  });
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0]!.id, 'ok');
  assert.equal(subscriptions[0]!.enabled, true);
  assert.ok(warnings.length >= 4);
});

test('normalizeConfig parses filter, target options, and enabled=false', () => {
  const { subscriptions } = normalizeConfig({
    subscriptions: [
      {
        id: 'fan',
        name: 'Fan-in deploy',
        event: 'agent.completed',
        filter: { triggeredBy: 'tiger', allOf: ['build', 'test'] },
        promptFile: 'prompts/deploy.md',
        enabled: false,
        target: { kind: 'queue', provider: 'codex', priority: 5, maxAttempts: 3 },
      },
    ],
  });
  const s = subscriptions[0]!;
  assert.equal(s.enabled, false);
  assert.equal(s.promptFile, 'prompts/deploy.md');
  assert.deepEqual(s.filter?.allOf, ['build', 'test']);
  assert.equal(s.target.provider, 'codex');
  assert.equal(s.target.priority, 5);
});

// --- ignore policy ---

test('isIgnoredPath skips VCS/build dirs anywhere in the path', () => {
  assert.equal(isIgnoredPath('node_modules/foo/index.js'), true);
  assert.equal(isIgnoredPath('src/.git/HEAD'), true);
  assert.equal(isIgnoredPath('.tiger/run.json'), true);
  assert.equal(isIgnoredPath('src/app/main.ts'), false);
});
