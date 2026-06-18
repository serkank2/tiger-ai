import test from 'node:test';
import assert from 'node:assert/strict';
import type { UsageProbe } from '../orchestrator/usage.js';
import { classifyLimitWindow, normalizeUsageProbe, percentUsedFromEntry } from './normalize.js';

const CHECKED_AT = '2026-06-18T06:00:00.000Z';

test('percentUsedFromEntry normalizes used and left to the same consumed percentage', () => {
  assert.equal(percentUsedFromEntry({ percent: 17, metric: 'used' }), 17);
  assert.equal(percentUsedFromEntry({ percent: 83, metric: 'left' }), 17);
});

test('classifyLimitWindow recognizes canonical provider windows', () => {
  assert.equal(classifyLimitWindow('5h limit'), '5h');
  assert.equal(classifyLimitWindow('Current week (all models)'), 'weekly');
  assert.equal(classifyLimitWindow('Current session'), 'session');
});

test('normalizeUsageProbe de-duplicates duplicate windows and preserves best reset parse', () => {
  const probe: UsageProbe = {
    type: 'codex',
    ok: true,
    checkedAt: CHECKED_AT,
    raw: 'panel text',
    highlights: [],
    entries: [
      { label: '5h limit', percent: 97, metric: 'left', reset: 'resets whenever' },
      { label: '5h limit', percent: 97, metric: 'left', reset: 'resets in 3h' },
      { label: 'Weekly limit', percent: 91, metric: 'left', reset: '(resets 22:24 on 22 Jun)' },
    ],
  };

  const snapshots = normalizeUsageProbe(probe, {
    now: new Date(CHECKED_AT),
    defaultTimeZone: 'UTC',
    snapshotId: () => 'fixed',
  });

  assert.equal(snapshots.length, 2);
  const fiveHour = snapshots.find((snapshot) => snapshot.windowKey === '5h');
  assert.ok(fiveHour);
  assert.equal(fiveHour.percentUsed, 3);
  assert.equal(fiveHour.parseConfidence, 'trusted');
  assert.equal(fiveHour.resetAt, '2026-06-18T09:00:00.000Z');
  const weekly = snapshots.find((snapshot) => snapshot.windowKey === 'weekly');
  assert.ok(weekly);
  assert.equal(weekly.percentUsed, 9);
});

test('normalizeUsageProbe writes a failed probe snapshot when parsing finds no entries', () => {
  const probe: UsageProbe = {
    type: 'claude',
    ok: false,
    checkedAt: CHECKED_AT,
    raw: 'command not found',
    highlights: [],
    entries: [],
    error: 'claude unavailable',
  };

  const snapshots = normalizeUsageProbe(probe, { snapshotId: () => 'failed' });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.windowKey, 'probe');
  assert.equal(snapshots[0]?.ok, false);
  assert.equal(snapshots[0]?.error, 'claude unavailable');
});
