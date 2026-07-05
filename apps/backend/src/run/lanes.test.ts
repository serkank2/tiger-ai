import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { prepareLane, mergeLane, cleanupLane } from './lanes.js';

// A real git repo is required to exercise worktree lanes end-to-end. These
// tests create a throwaway repo, commit a baseline, then verify the
// snapshot → isolated-work → patch-merge-back → cleanup cycle, including the
// conflict path that must NOT half-apply onto the main tree.

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
}

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-lane-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@kaplan.local');
  git(dir, 'config', 'user.name', 'Kaplan Test');
  // Keep bytes verbatim so line-ending assertions are platform-independent
  // (Windows would otherwise autocrlf \n → \r\n in the checkout).
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'root');
  return dir;
}

test('lane: snapshot → isolated edit → patch merge-back lands on the main tree', async () => {
  const repo = await makeRepo();
  await fs.writeFile(path.join(repo, 'a.txt'), 'line1\nline2\n', 'utf8');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'add a.txt');

  const lane = await prepareLane(repo, 'run-x', 'T1');
  assert.ok(lane.worktree.path !== repo);
  // The lane sees the baseline file…
  const laneFile = path.join(lane.worktree.path, 'a.txt');
  assert.equal(await fs.readFile(laneFile, 'utf8'), 'line1\nline2\n');
  // …the agent edits it AND adds a new file in the lane only.
  await fs.writeFile(laneFile, 'line1 edited\nline2\n', 'utf8');
  await fs.writeFile(path.join(lane.worktree.path, 'b.txt'), 'brand new\n', 'utf8');

  // Before merge the main tree is untouched.
  assert.equal(await fs.readFile(path.join(repo, 'a.txt'), 'utf8'), 'line1\nline2\n');

  const merged = await mergeLane(repo, lane);
  assert.equal(merged.ok, true);
  assert.deepEqual(merged.files.sort(), ['a.txt', 'b.txt']);
  // The patch is applied to the main WORKING TREE (no commit made).
  assert.equal(await fs.readFile(path.join(repo, 'a.txt'), 'utf8'), 'line1 edited\nline2\n');
  assert.equal(await fs.readFile(path.join(repo, 'b.txt'), 'utf8'), 'brand new\n');
  const head = spawnSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' }).stdout.trim().split('\n');
  assert.equal(head.length, 2, 'no new commit on the main branch');

  await cleanupLane(repo, lane);
  const worktrees = spawnSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }).stdout;
  assert.ok(!worktrees.includes(lane.worktree.path), 'worktree removed');
});

test('lane: a conflicting patch reports ok:false and leaves the main tree untouched', async () => {
  const repo = await makeRepo();
  await fs.writeFile(path.join(repo, 'shared.txt'), 'original\n', 'utf8');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'add shared.txt');

  const lane = await prepareLane(repo, 'run-x', 'T2');
  // The lane rewrites the shared line…
  await fs.writeFile(path.join(lane.worktree.path, 'shared.txt'), 'lane version\n', 'utf8');
  // …but meanwhile the MAIN tree changed the same line (another lane merged first).
  await fs.writeFile(path.join(repo, 'shared.txt'), 'main moved on\n', 'utf8');

  const merged = await mergeLane(repo, lane);
  assert.equal(merged.ok, false, 'conflict detected');
  // The main tree keeps its state — no half-applied patch.
  assert.equal(await fs.readFile(path.join(repo, 'shared.txt'), 'utf8'), 'main moved on\n');

  await cleanupLane(repo, lane);
});
