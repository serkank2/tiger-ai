import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireLock,
  claimNextTaskFile,
  finishTaskFile,
  hasTaskFiles,
  isLockStale,
  listTaskRecords,
  parseExecutionResult,
  parseTaskFileName,
  parseTasks,
  reclaimStaleTaskClaims,
  releaseLock,
  reviewTaskFile,
  splitTasksToFiles,
  summarizeTasks,
  taskFileName,
  updateTaskFields,
} from './tasks.js';

const SAMPLE = `# Final Tasks

## TASK-001: Set up the backend

### Description
Create the Express server and the WebSocket layer.

### Acceptance Criteria
- Server starts
- WS connects

### Dependencies
- None

### Execution Status
not_started

### Assigned Agent
-

### Started At
-

### Completed At
-

### Review Status
pending

### Review Notes
-

## TASK-002: Build the frontend

### Description
Create the Nuxt SPA.

### Acceptance Criteria
- Page renders

### Dependencies
- TASK-001

### Execution Status
done

### Assigned Agent
codex-01

### Started At
2026-01-01T00:00:00.000Z

### Completed At
2026-01-01T01:00:00.000Z

### Review Status
approved

### Review Notes
Looks good.
`;

test('parseTasks reads ids, titles, and status fields', () => {
  const tasks = parseTasks(SAMPLE);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]!.id, 'TASK-001');
  assert.equal(tasks[0]!.title, 'Set up the backend');
  assert.equal(tasks[0]!.executionStatus, 'not_started');
  assert.equal(tasks[0]!.reviewStatus, 'pending');
  assert.equal(tasks[1]!.executionStatus, 'done');
  assert.equal(tasks[1]!.assignedAgent, 'codex-01');
  assert.equal(tasks[1]!.reviewStatus, 'approved');
});

test('updateTaskFields changes only the target task and preserves description', () => {
  const next = updateTaskFields(SAMPLE, 'TASK-001', {
    executionStatus: 'in_progress',
    assignedAgent: 'claude-01',
    startedAt: '2026-02-02T00:00:00.000Z',
  });
  const tasks = parseTasks(next);
  assert.equal(tasks[0]!.executionStatus, 'in_progress');
  assert.equal(tasks[0]!.assignedAgent, 'claude-01');
  assert.equal(tasks[0]!.startedAt, '2026-02-02T00:00:00.000Z');
  // TASK-002 untouched
  assert.equal(tasks[1]!.executionStatus, 'done');
  // Agent-authored content preserved
  assert.match(next, /Create the Express server and the WebSocket layer\./);
});

test('updateTaskFields is a no-op for an unknown task id', () => {
  const next = updateTaskFields(SAMPLE, 'TASK-999', { executionStatus: 'done' });
  assert.equal(next, SAMPLE);
});

test('summarizeTasks aggregates by execution and review status', () => {
  const summary = summarizeTasks(parseTasks(SAMPLE));
  assert.equal(summary.total, 2);
  assert.equal(summary.byExecution.not_started, 1);
  assert.equal(summary.byExecution.done, 1);
  assert.equal(summary.byReview.pending, 1);
  assert.equal(summary.byReview.approved, 1);
});

test('parseExecutionResult extracts the last reported result', () => {
  assert.deepEqual(parseExecutionResult('blah\nEXECUTION_RESULT: done\nmore'), { status: 'done', reason: '' });
  assert.deepEqual(parseExecutionResult('EXECUTION_RESULT: blocked: missing dependency'), {
    status: 'blocked',
    reason: 'missing dependency',
  });
  assert.equal(parseExecutionResult('nothing here'), null);
});

test('parseExecutionResult anchors to line start so an echoed instruction is not misread (#5)', () => {
  // The prompt text itself contains "EXECUTION_RESULT: done" mid-sentence; that must not parse.
  assert.equal(
    parseExecutionResult('As the final line of your log write one of: EXECUTION_RESULT: done or blocked.'),
    null,
  );
  // A genuine marker on its own line (optionally with a list/quote prefix) is parsed.
  assert.deepEqual(parseExecutionResult('# Log\n> EXECUTION_RESULT: done'), { status: 'done', reason: '' });
  // When the agent echoes the instruction AND then writes a real final line, the real one wins.
  assert.deepEqual(
    parseExecutionResult('Write EXECUTION_RESULT: done when finished.\n\nEXECUTION_RESULT: blocked: stuck'),
    { status: 'blocked', reason: 'stuck' },
  );
});

test('acquireLock is exclusive and releasable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-lock-'));
  try {
    const lock = path.join(dir, 'TASK-001.lock');
    assert.equal(await acquireLock(lock, { taskId: 'TASK-001', agentId: 'claude-01', agentType: 'claude' }), true);
    assert.equal(await acquireLock(lock, { taskId: 'TASK-001', agentId: 'codex-01', agentType: 'codex' }), false);
    const body = await fs.readFile(lock, 'utf8');
    assert.match(body, /Agent ID: claude-01/);
    await releaseLock(lock);
    assert.equal(await acquireLock(lock, { taskId: 'TASK-001', agentId: 'codex-01', agentType: 'codex' }), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a live owner lock is not reclaimed, but a dead-PID lock is', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-stale-'));
  try {
    const lock = path.join(dir, 'TASK-002.lock');
    // Lock owned by THIS (alive) process — not stale, cannot be reclaimed.
    await acquireLock(lock, { taskId: 'TASK-002', agentId: 'claude-01', agentType: 'claude' });
    assert.equal(await isLockStale(lock, 0), false);
    assert.equal(
      await acquireLock(lock, { taskId: 'TASK-002', agentId: 'codex-01', agentType: 'codex' }, { ttlMs: 60_000 }),
      false,
    );

    // Overwrite with a dead PID → stale → reclaimable.
    const dead = [
      'Task ID: TASK-002',
      'Agent ID: ghost',
      'Agent Type: claude',
      `Created: ${new Date().toISOString()}`,
      'Process ID: 2147483646',
      '',
    ].join('\n');
    await fs.writeFile(lock, dead, 'utf8');
    assert.equal(await isLockStale(lock, 0), true);
    assert.equal(
      await acquireLock(lock, { taskId: 'TASK-002', agentId: 'codex-02', agentType: 'codex' }, { ttlMs: 60_000 }),
      true,
    );
    assert.match(await fs.readFile(lock, 'utf8'), /Agent ID: codex-02/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('per-task files: split, list, claim-by-rename, finish, review', () => {
  return (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-taskfiles-'));
    try {
      // Split the merged file into per-task files; status comes from the filename.
      const n = await splitTasksToFiles(SAMPLE, dir);
      assert.equal(n, 2);
      assert.equal(taskFileName('TASK-001', 'not_started'), 'TASK-001__not_started.md');
      assert.deepEqual(parseTaskFileName('TASK-001__not_started.md'), { id: 'TASK-001', status: 'not_started' });
      assert.equal(await hasTaskFiles(dir), true);

      let recs = await listTaskRecords(dir);
      assert.equal(recs.length, 2);
      assert.equal(recs.find((r) => r.id === 'TASK-001')!.executionStatus, 'not_started');
      assert.equal(recs.find((r) => r.id === 'TASK-002')!.executionStatus, 'done'); // SAMPLE marks it done

      // Splitting again is idempotent (no clobber).
      assert.equal(await splitTasksToFiles(SAMPLE, dir), 0);

      // Claim renames the only not_started task to in_progress and records the assignee.
      const claimed = await claimNextTaskFile(dir, 'claude-01', '2026-02-02T00:00:00.000Z');
      assert.equal(claimed?.record.id, 'TASK-001');
      assert.match(claimed!.block, /Set up the backend/);
      assert.equal(
        await fs
          .stat(path.join(dir, 'TASK-001__in_progress.md'))
          .then(() => true)
          .catch(() => false),
        true,
      );

      // No not_started left → next claim returns null.
      assert.equal(await claimNextTaskFile(dir, 'codex-01', '2026-02-02T00:00:00.000Z'), null);

      // Finish + review update filename + content.
      await finishTaskFile(dir, 'TASK-001', 'done', '2026-02-02T01:00:00.000Z');
      await reviewTaskFile(dir, 'TASK-001', 'approved');
      recs = await listTaskRecords(dir);
      const t1 = recs.find((r) => r.id === 'TASK-001')!;
      assert.equal(t1.executionStatus, 'done');
      assert.equal(t1.reviewStatus, 'approved');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  })();
});

test('stale in_progress task files are reclaimed, claimed again, and completed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-task-reclaim-'));
  const locksDir = path.join(dir, 'locks');
  try {
    await splitTasksToFiles(SAMPLE, dir);

    const claimed = await claimNextTaskFile(dir, 'claude-01', '2026-02-02T00:00:00.000Z', {
      locksDir,
      agentType: 'claude',
      ttlMs: 60_000,
    });
    assert.equal(claimed?.record.id, 'TASK-001');
    assert.match(claimed!.block, /Create the Express server/);

    await fs.writeFile(
      path.join(locksDir, 'TASK-001.lock'),
      [
        'Task ID: TASK-001',
        'Agent ID: claude-01',
        'Agent Type: claude',
        'Created: 2020-01-01T00:00:00.000Z',
        `Process ID: ${process.pid}`,
        '',
      ].join('\n'),
      'utf8',
    );

    const reclaimed = await reclaimStaleTaskClaims(dir, {
      locksDir,
      ttlMs: 1000,
      nowMs: Date.parse('2026-01-01T00:00:00.000Z'),
    });
    assert.deepEqual(
      reclaimed.map((r) => r.id),
      ['TASK-001'],
    );
    assert.equal(
      await fs
        .stat(path.join(dir, 'TASK-001__not_started.md'))
        .then(() => true)
        .catch(() => false),
      true,
    );
    assert.equal(
      await fs
        .stat(path.join(dir, 'TASK-001__in_progress.md'))
        .then(() => true)
        .catch(() => false),
      false,
    );
    assert.match(await fs.readFile(path.join(dir, 'TASK-001__not_started.md'), 'utf8'), /Create the Express server/);

    const next = await claimNextTaskFile(dir, 'codex-01', '2026-02-02T01:00:00.000Z', {
      locksDir,
      agentType: 'codex',
      ttlMs: 1000,
    });
    assert.equal(next?.record.id, 'TASK-001');
    await finishTaskFile(dir, 'TASK-001', 'done', '2026-02-02T02:00:00.000Z');
    await releaseLock(path.join(locksDir, 'TASK-001.lock'));

    const taskFiles = (await fs.readdir(dir)).filter((name) => name.startsWith('TASK-001__'));
    assert.deepEqual(taskFiles, ['TASK-001__done.md']);
    const t1 = (await listTaskRecords(dir)).find((r) => r.id === 'TASK-001')!;
    assert.equal(t1.executionStatus, 'done');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('fresh in_progress task files are not reclaimed or double-claimed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-task-fresh-'));
  const locksDir = path.join(dir, 'locks');
  try {
    await splitTasksToFiles(SAMPLE, dir);
    await claimNextTaskFile(dir, 'claude-01', '2026-02-02T00:00:00.000Z', {
      locksDir,
      agentType: 'claude',
      ttlMs: 60_000,
    });

    const reclaimed = await reclaimStaleTaskClaims(dir, { locksDir, ttlMs: 60_000, nowMs: Date.now() });
    assert.equal(reclaimed.length, 0);
    assert.equal(
      await fs
        .stat(path.join(dir, 'TASK-001__in_progress.md'))
        .then(() => true)
        .catch(() => false),
      true,
    );
    assert.equal(await claimNextTaskFile(dir, 'codex-01', '2026-02-02T00:10:00.000Z'), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a lock older than the TTL is stale', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-ttl-'));
  try {
    const lock = path.join(dir, 'TASK-003.lock');
    const old = [
      'Task ID: TASK-003',
      'Agent ID: claude-01',
      'Agent Type: claude',
      'Created: 2020-01-01T00:00:00.000Z',
      `Process ID: ${process.pid}`,
      '',
    ].join('\n');
    await fs.writeFile(lock, old, 'utf8');
    // Even though the PID is alive, the age exceeds the TTL.
    assert.equal(await isLockStale(lock, 1000, Date.parse('2026-01-01T00:00:00.000Z')), true);
    assert.equal(await isLockStale(lock, 0, Date.parse('2026-01-01T00:00:00.000Z')), false); // TTL disabled
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
