import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedConcurrency, drainPool, runPool } from './worker-pool.js';

test('boundedConcurrency clamps to a positive integer', () => {
  assert.equal(boundedConcurrency(4), 4);
  assert.equal(boundedConcurrency(0), 1);
  assert.equal(boundedConcurrency(-3), 1);
  assert.equal(boundedConcurrency(2.9), 2);
  assert.equal(boundedConcurrency(Number.NaN), 1);
});

test('runPool never exceeds the concurrency limit', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  let active = 0;
  let peak = 0;
  await runPool(items, 4, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
  });
  assert.ok(peak <= 4, `peak ${peak} exceeded limit 4`);
});

test('runPool processes every item exactly once', async () => {
  const items = Array.from({ length: 13 }, (_, i) => i);
  const seen: number[] = [];
  await runPool(items, 3, async (item) => {
    seen.push(item);
  });
  assert.deepEqual(seen.sort((a, b) => a - b), items);
});

test('drainPool caps concurrency while draining a shared queue', async () => {
  // 20 work items but only 4 workers may run at once.
  let remaining = 20;
  let active = 0;
  let peak = 0;
  let processed = 0;
  await drainPool({
    limit: 4,
    claim: async () => (remaining > 0 ? remaining-- : null),
    process: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      processed += 1;
      active -= 1;
    },
  });
  assert.equal(processed, 20);
  assert.ok(peak <= 4, `peak ${peak} exceeded limit 4`);
});

test('drainPool stops claiming once shouldStop is true', async () => {
  let claimed = 0;
  let stop = false;
  await drainPool({
    limit: 2,
    claim: async () => {
      claimed += 1;
      if (claimed >= 3) stop = true;
      return claimed;
    },
    process: async () => {},
    shouldStop: () => stop,
  });
  // Workers stop claiming after the flag flips; the queue is infinite, so this must terminate.
  assert.ok(claimed >= 3);
});
