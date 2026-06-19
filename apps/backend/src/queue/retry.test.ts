import test from 'node:test';
import assert from 'node:assert/strict';
import { canRetry, planRetry, retryBackoffMs } from './retry.js';

test('retryBackoffMs grows exponentially and is capped', () => {
  const opts = { baseMs: 1_000, factor: 2, maxMs: 10_000 };
  assert.equal(retryBackoffMs(1, opts), 1_000);
  assert.equal(retryBackoffMs(2, opts), 2_000);
  assert.equal(retryBackoffMs(3, opts), 4_000);
  assert.equal(retryBackoffMs(4, opts), 8_000);
  // 16_000 would exceed the cap.
  assert.equal(retryBackoffMs(5, opts), 10_000);
  assert.equal(retryBackoffMs(50, opts), 10_000);
});

test('retryBackoffMs never returns a negative delay', () => {
  assert.equal(retryBackoffMs(0, { baseMs: 1_000 }), 1_000);
  assert.ok(retryBackoffMs(1) >= 0);
});

test('canRetry enforces the attempts cap', () => {
  assert.equal(canRetry(0, 3), true);
  assert.equal(canRetry(2, 3), true);
  assert.equal(canRetry(3, 3), false);
  assert.equal(canRetry(4, 3), false);
  // maxAttempts is floored at 1.
  assert.equal(canRetry(0, 0), true);
  assert.equal(canRetry(1, 0), false);
});

test('planRetry schedules a backed-off retry until the cap, then fails terminally', () => {
  const now = '2026-06-19T00:00:00.000Z';
  const first = planRetry(1, 3, now, { baseMs: 1_000, factor: 2, maxMs: 60_000 });
  assert.equal(first.retry, true);
  if (first.retry) {
    assert.equal(first.resumeAfter, '2026-06-19T00:00:01.000Z');
    // resumeAfter is strictly in the future, so the job is not hot-loopable.
    assert.ok(new Date(first.resumeAfter).getTime() > new Date(now).getTime());
  }

  const second = planRetry(2, 3, now, { baseMs: 1_000, factor: 2, maxMs: 60_000 });
  assert.equal(second.retry, true);
  if (second.retry) assert.equal(second.resumeAfter, '2026-06-19T00:00:02.000Z');

  const terminal = planRetry(3, 3, now);
  assert.equal(terminal.retry, false);
});
