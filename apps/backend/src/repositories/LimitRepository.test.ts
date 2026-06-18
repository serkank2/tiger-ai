import test from 'node:test';
import assert from 'node:assert/strict';
import type { LimitSnapshot } from '../limits/types.js';

process.env.KAPLAN_DB_NAME = process.env.KAPLAN_DB_TEST_NAME?.trim() || 'kaplan_limit_repository_test';
process.env.KAPLAN_DB_CONNECT_RETRIES ??= '0';
process.env.KAPLAN_DB_CONNECT_RETRY_DELAY_MS ??= '1';
process.env.KAPLAN_DB_CONNECT_MAX_DELAY_MS ??= '1';

test('MySqlLimitRepository preserves UTC resetAt and checkedAt across MySQL persistence', async (t) => {
  const poolModule = await import('../db/pool.js');
  const migrateModule = await import('../db/migrate.js');
  const repositoryModule = await import('./LimitRepository.js');

  try {
    await migrateModule.migrate(await poolModule.getDbPool());
  } catch (err) {
    await poolModule.closeDbPool();
    t.skip(`MySQL integration unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const repo = new repositoryModule.MySqlLimitRepository();
  const snapshot: LimitSnapshot = {
    id: `limit-repository-utc-roundtrip-${process.pid}`,
    provider: 'claude',
    windowKey: '5h',
    label: '5h limit',
    percentUsed: 90,
    metricRaw: { percent: 90, metric: 'used' },
    resetText: 'resets at 17:00',
    resetAt: '2026-06-18T14:00:00.000Z',
    ok: true,
    rawPanel: 'test panel',
    parseConfidence: 'trusted',
    checkedAt: '2026-06-18T12:34:56.789Z',
  };

  try {
    await poolModule.query('DELETE FROM limit_snapshots WHERE id = ?', [snapshot.id]);
    await repo.insertSnapshots([snapshot]);

    const loaded = await repo.load(10);
    const roundTripped = loaded.snapshots.find((item) => item.id === snapshot.id);

    assert.ok(roundTripped);
    assert.equal(roundTripped.resetAt, snapshot.resetAt);
    assert.equal(roundTripped.checkedAt, snapshot.checkedAt);
  } finally {
    await poolModule.query('DELETE FROM limit_snapshots WHERE id = ?', [snapshot.id]).catch(() => {});
    await poolModule.closeDbPool();
  }
});
