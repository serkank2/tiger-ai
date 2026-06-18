import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResetText } from './resetParse.js';

const NOW = new Date('2026-06-18T06:00:00.000Z');

test('parseResetText parses relative reset text', () => {
  const parsed = parseResetText('resets in 3h 20m', { now: NOW, defaultTimeZone: 'UTC' });
  assert.equal(parsed.resetAt, '2026-06-18T09:20:00.000Z');
  assert.equal(parsed.parseConfidence, 'trusted');
  assert.equal(parsed.kind, 'relative');
});

test('parseResetText parses clock reset text with an explicit timezone', () => {
  const parsed = parseResetText('Resets at 5pm (Europe/Istanbul)', { now: NOW, defaultTimeZone: 'UTC' });
  assert.equal(parsed.resetAt, '2026-06-18T14:00:00.000Z');
  assert.equal(parsed.parseConfidence, 'trusted');
  assert.equal(parsed.kind, 'clock');
});

test('parseResetText rolls same-day clocks forward when already passed', () => {
  const parsed = parseResetText('Resets 5:20am (Europe/Istanbul)', { now: NOW, defaultTimeZone: 'UTC' });
  assert.equal(parsed.resetAt, '2026-06-19T02:20:00.000Z');
  assert.equal(parsed.kind, 'clock');
});

test('parseResetText parses month date forms with timezone', () => {
  const parsed = parseResetText('Resets Jun 18, 9pm (Europe/Istanbul)', { now: NOW, defaultTimeZone: 'UTC' });
  assert.equal(parsed.resetAt, '2026-06-18T18:00:00.000Z');
  assert.equal(parsed.kind, 'date');
});

test('parseResetText parses time-on-date forms', () => {
  const parsed = parseResetText('(resets 22:24 on 22 Jun)', { now: NOW, defaultTimeZone: 'UTC' });
  assert.equal(parsed.resetAt, '2026-06-22T22:24:00.000Z');
  assert.equal(parsed.kind, 'date');
});

test('parseResetText marks unparseable reset text as unknown', () => {
  const parsed = parseResetText('resets whenever the provider says so', { now: NOW, defaultTimeZone: 'UTC' });
  assert.equal(parsed.resetAt, null);
  assert.equal(parsed.parseConfidence, 'unknown');
  assert.equal(parsed.kind, 'unknown');
});
