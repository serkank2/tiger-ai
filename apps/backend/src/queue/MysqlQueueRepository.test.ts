import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KAPLAN_DB_NAME =
  process.env.KAPLAN_DB_QUEUE_TEST_NAME?.trim() ||
  process.env.KAPLAN_DB_TEST_NAME?.trim() ||
  'kaplan_queue_repository_test';
process.env.KAPLAN_DB_CONNECT_RETRIES ??= '0';
process.env.KAPLAN_DB_CONNECT_RETRY_DELAY_MS ??= '1';
process.env.KAPLAN_DB_CONNECT_MAX_DELAY_MS ??= '1';

test('MysqlQueueRepository preserves UTC resetAt and resumeAfter across MySQL persistence', async (t) => {
  const poolModule = await import('../db/pool.js');
  const migrateModule = await import('../db/migrate.js');
  const repositoryModule = await import('./MysqlQueueRepository.js');
  const serviceModule = await import('../services/QueueService.js');

  try {
    await migrateModule.migrate(await poolModule.getDbPool());
  } catch (err) {
    await poolModule.closeDbPool();
    t.skip(`MySQL integration unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const snapshotId = `queue-repository-utc-${process.pid}-${Date.now()}`;
  const prompt = `UTC queue test prompt ${snapshotId}`;
  const resetAt = '2099-06-18T15:00:00.000Z';
  const checkedAt = '2099-06-18T12:00:00.000Z';
  let jobId: string | null = null;

  try {
    await poolModule.query('DELETE FROM queue_events');
    await poolModule.query('DELETE FROM queue_jobs');
    await poolModule.query("DELETE FROM prompt_history_events WHERE input_text LIKE 'UTC queue test prompt %'");
    await poolModule.query("DELETE FROM limit_snapshots WHERE id LIKE 'queue-repository-utc-%'");
    await poolModule.query(
      `INSERT INTO limit_snapshots (
        id, provider, window_key, label, percent_used, metric_raw, reset_text, reset_at,
        ok, error, raw_panel, parse_confidence, checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshotId,
        'claude',
        '5h',
        'Claude 5h',
        90,
        JSON.stringify({ percent: 90, metric: 'used' }),
        'resets at 18:00',
        migrateModule.toMysqlDate(resetAt),
        1,
        null,
        'test panel',
        'trusted',
        migrateModule.toMysqlDate(checkedAt),
      ],
    );

    const repo = new repositoryModule.MysqlQueueRepository();
    const latest = await repo.getLatestLimitSnapshot('claude');

    assert.ok(latest);
    assert.equal(latest.resetAt, resetAt);

    const service = new serviceModule.QueueService(repo);
    const job = await service.enqueue({ prompt, provider: 'claude', projectName: 'UTC queue test' });
    jobId = job.id;

    const blocked = await service.leaseNext('utc-queue-test', 60_000);

    assert.equal(blocked.kind, 'blocked');
    assert.equal(blocked.kind === 'blocked' ? blocked.decision.resumeAfter : null, resetAt);
    assert.equal(blocked.kind === 'blocked' ? blocked.job.resumeAfter : null, resetAt);
    assert.equal((await repo.getJob(job.id))?.resumeAfter, resetAt);
  } finally {
    if (jobId) {
      await poolModule.query('DELETE FROM queue_events WHERE job_id = ?', [jobId]).catch(() => {});
      await poolModule.query('DELETE FROM queue_jobs WHERE id = ?', [jobId]).catch(() => {});
    }
    await poolModule.query('DELETE FROM prompt_history_events WHERE input_text = ?', [prompt]).catch(() => {});
    await poolModule.query('DELETE FROM limit_snapshots WHERE id = ?', [snapshotId]).catch(() => {});
    await poolModule.closeDbPool();
  }
});
