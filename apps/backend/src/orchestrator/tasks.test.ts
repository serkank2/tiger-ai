import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireLock,
  isLockStale,
  parseExecutionResult,
  parseTasks,
  releaseLock,
  summarizeTasks,
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
