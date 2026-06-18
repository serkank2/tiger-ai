import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskBoard } from './task-board.js';

async function tmpRunDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-taskboard-'));
}

test('TaskBoard creates per-role folders and enqueues tasks with FIFO ids', async () => {
  const dir = await tmpRunDir();
  try {
    const board = new TaskBoard(dir);
    await board.init(['developer', 'tester']);

    for (const status of ['todo', 'in-progress', 'done']) {
      const stat = await fs.stat(path.join(board.agentDir('developer'), status));
      assert.ok(stat.isDirectory(), `developer/${status} exists`);
    }

    const t1 = await board.enqueue({ roleId: 'developer', title: 'First', body: 'do A', fromRoleId: 'lead', createdAt: '2020-01-01T00:00:00.000Z' });
    const t2 = await board.enqueue({ roleId: 'developer', title: 'Second', body: 'do B', fromRoleId: 'lead', createdAt: '2020-01-01T00:00:01.000Z' });
    assert.equal(t1.id, 'TASK-0001');
    assert.equal(t2.id, 'TASK-0002');

    const todo = await board.listTodo('developer');
    assert.deepEqual(todo.map((t) => t.id), ['TASK-0001', 'TASK-0002']);
    assert.equal(todo[0]?.fromRoleId, 'lead');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TaskBoard claims FIFO, completes, and tracks counts', async () => {
  const dir = await tmpRunDir();
  try {
    const board = new TaskBoard(dir);
    await board.enqueue({ roleId: 'developer', title: 'A', body: 'a', createdAt: '2020-01-01T00:00:00.000Z' });
    await board.enqueue({ roleId: 'developer', title: 'B', body: 'b', createdAt: '2020-01-01T00:00:01.000Z' });

    // Claim the oldest first (FIFO).
    const claimed = await board.claimNext('developer', '2020-01-01T00:01:00.000Z');
    assert.equal(claimed?.id, 'TASK-0001');
    assert.equal(claimed?.status, 'in-progress');

    let counts = await board.counts('developer');
    assert.deepEqual(counts, { todo: 1, inProgress: 1, done: 0 });

    // The claimed task left the todo queue.
    assert.deepEqual((await board.listTodo('developer')).map((t) => t.id), ['TASK-0002']);

    await board.complete(claimed!, '2020-01-01T00:02:00.000Z');
    counts = await board.counts('developer');
    assert.deepEqual(counts, { todo: 1, inProgress: 0, done: 1 });

    // Next claim returns the remaining task.
    const next = await board.claimNext('developer', '2020-01-01T00:03:00.000Z');
    assert.equal(next?.id, 'TASK-0002');

    assert.equal(await board.claimNext('developer', '2020-01-01T00:04:00.000Z'), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TaskBoard reports when every queue is clear and requeues failed work', async () => {
  const dir = await tmpRunDir();
  try {
    const board = new TaskBoard(dir);
    await board.init(['developer', 'reviewer']);
    assert.equal(await board.allQueuesClear(['developer', 'reviewer']), true);

    await board.enqueue({ roleId: 'developer', title: 'A', body: 'a', createdAt: '2020-01-01T00:00:00.000Z' });
    assert.equal(await board.allQueuesClear(['developer', 'reviewer']), false);

    const claimed = await board.claimNext('developer', '2020-01-01T00:01:00.000Z');
    assert.equal(await board.allQueuesClear(['developer', 'reviewer']), false); // still in-progress

    // A failed turn returns the task to the queue.
    await board.requeue(claimed!);
    assert.deepEqual((await board.listTodo('developer')).map((t) => t.id), ['TASK-0001']);
    assert.deepEqual(await board.counts('developer'), { todo: 1, inProgress: 0, done: 0 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
