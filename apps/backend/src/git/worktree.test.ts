import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isGitRepo,
  createWorktree,
  removeWorktree,
  listWorktrees,
  worktreeDiff,
  sanitizeTaskId,
  WorktreeError,
} from './worktree.js';

// Skip the whole suite gracefully if git isn't on PATH (CI sandboxes, etc.).
const GIT_AVAILABLE = (() => {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

/** Create a throwaway git repo with one commit; returns its path. */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kaplan-wt-'));
  git(dir, 'init', '-q');
  // Local identity so commits succeed without global config.
  git(dir, 'config', 'user.email', 'test@kaplan.local');
  git(dir, 'config', 'user.name', 'Kaplan Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'README.md'), '# base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

test('sanitizeTaskId produces ref-safe tokens and rejects empties', () => {
  assert.equal(sanitizeTaskId('Task 123'), 'Task-123');
  assert.equal(sanitizeTaskId('feature/foo@bar'), 'feature-foo-bar');
  assert.equal(sanitizeTaskId('..dots..'), 'dots');
  assert.throws(() => sanitizeTaskId('///'), WorktreeError);
});

test('isGitRepo distinguishes a repo from a plain dir', { skip: !GIT_AVAILABLE }, async () => {
  const repo = makeRepo();
  const plain = mkdtempSync(path.join(tmpdir(), 'kaplan-plain-'));
  try {
    assert.equal(await isGitRepo(repo), true);
    assert.equal(await isGitRepo(plain), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test('createWorktree on a non-repo throws WorktreeError', { skip: !GIT_AVAILABLE }, async () => {
  const plain = mkdtempSync(path.join(tmpdir(), 'kaplan-plain-'));
  try {
    await assert.rejects(() => createWorktree({ repoDir: plain, taskId: 't1' }), WorktreeError);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test('full lifecycle: create -> isolate -> diff -> remove', { skip: !GIT_AVAILABLE }, async () => {
  const repo = makeRepo();
  try {
    const wt = await createWorktree({ repoDir: repo, taskId: 'task-42' });

    // Path + branch exist and are named as expected.
    assert.equal(wt.branch, 'kaplan/task-42');
    assert.ok(existsSync(wt.path), 'worktree path should exist on disk');
    assert.ok(/^[0-9a-f]{7,40}$/.test(wt.baseRef), 'baseRef should be a resolved sha');
    assert.equal(await isGitRepo(wt.path), true);

    // listWorktrees sees both the main worktree and ours.
    const list = await listWorktrees(repo);
    assert.ok(
      list.some((w) => path.resolve(w.path) === path.resolve(wt.path) && w.branch === 'kaplan/task-42'),
      'listWorktrees should include the new worktree',
    );

    // Isolation: a new file in the worktree must NOT appear in the source repo.
    const isolated = path.join(wt.path, 'agent-output.txt');
    writeFileSync(isolated, 'hello from the agent\n');
    assert.equal(existsSync(path.join(repo, 'agent-output.txt')), false, 'change must not leak into source repo');

    // A tracked modification too, so the diff has both tracked + untracked content.
    writeFileSync(path.join(wt.path, 'README.md'), '# base\nmodified by agent\n');

    const diff = await worktreeDiff({ worktreePath: wt.path, baseRef: wt.baseRef });
    assert.ok(diff.files.includes('agent-output.txt'), 'untracked new file should be reported');
    assert.ok(diff.files.includes('README.md'), 'modified tracked file should be reported');
    assert.ok(diff.diff.includes('modified by agent'), 'unified diff should contain the change');
    assert.ok(diff.stat.length > 0, 'stat summary should be non-empty');

    // Idempotent-ish: re-creating returns the same worktree, not an error.
    const again = await createWorktree({ repoDir: repo, taskId: 'task-42' });
    assert.equal(path.resolve(again.path), path.resolve(wt.path));
    assert.equal(again.branch, wt.branch);

    // Remove (force, since the worktree is dirty) and assert cleanup.
    await removeWorktree({ repoDir: repo, path: wt.path, force: true });
    assert.equal(existsSync(wt.path), false, 'worktree dir should be gone after remove');
    const afterList = await listWorktrees(repo);
    assert.ok(
      !afterList.some((w) => path.resolve(w.path) === path.resolve(wt.path)),
      'removed worktree should no longer be listed',
    );

    // Tolerant: removing an already-removed worktree does not throw.
    await removeWorktree({ repoDir: repo, path: wt.path });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('createWorktree honors a custom rootDir and baseRef', { skip: !GIT_AVAILABLE }, async () => {
  const repo = makeRepo();
  const root = mkdtempSync(path.join(tmpdir(), 'kaplan-root-'));
  try {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    const wt = await createWorktree({ repoDir: repo, taskId: 'custom', baseRef: head, rootDir: root });
    assert.equal(path.resolve(path.dirname(wt.path)), path.resolve(root), 'worktree should live under rootDir');
    assert.equal(wt.baseRef, head);
    assert.ok(existsSync(path.join(wt.path, 'README.md')));
    // Normalize line endings: git may apply autocrlf on checkout (Windows).
    assert.equal(readFileSync(path.join(wt.path, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), '# base\n');
    await removeWorktree({ repoDir: repo, path: wt.path, force: true });
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
