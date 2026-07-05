import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from '../http/errors.js';
import {
  commit,
  createPullRequest,
  currentBranch,
  hasStagedOrUnstagedChanges,
  stageAll,
  type CommandRunner,
} from './write.js';

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function gitAvailable(): boolean {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-gitwrite-'));
}

async function initRepo(dir: string): Promise<void> {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(dir, 'README.md'), 'init\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'initial']);
}

test('stageAll + commit happy path returns a sha and summary', async (t) => {
  if (!gitAvailable()) return t.skip('git not available');
  const dir = await tmpDir();
  try {
    await initRepo(dir);
    await fs.writeFile(path.join(dir, 'feature.ts'), 'export const x = 1;\n', 'utf8');

    assert.equal(await hasStagedOrUnstagedChanges(dir), true);
    await stageAll(dir);

    const result = await commit(dir, 'add feature');
    assert.equal(result.committed, true);
    assert.ok(result.sha && /^[0-9a-f]{40}$/.test(result.sha), 'returns a full sha');
    assert.match(result.summary, /add feature/);
    assert.equal(await hasStagedOrUnstagedChanges(dir), false);

    const branch = await currentBranch(dir);
    assert.ok(branch, 'has a branch after commit');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('stageAll does not stage managed .tiger worktree files even without an ignore rule', async (t) => {
  if (!gitAvailable()) return t.skip('git not available');
  const dir = await tmpDir();
  try {
    await initRepo(dir);
    await fs.mkdir(path.join(dir, '.tiger', 'worktrees', 'TASK-001'), { recursive: true });
    await fs.writeFile(path.join(dir, '.tiger', 'worktrees', 'TASK-001', 'internal.txt'), 'internal\n', 'utf8');
    await fs.writeFile(path.join(dir, 'feature.ts'), 'export const y = 2;\n', 'utf8');

    await stageAll(dir);

    const staged = git(dir, ['diff', '--cached', '--name-only']);
    assert.match(staged, /feature\.ts/);
    assert.doesNotMatch(staged, /\.tiger\//);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('stageAll git add dry-run pathspec excludes managed .tiger worktree files', async (t) => {
  if (!gitAvailable()) return t.skip('git not available');
  const dir = await tmpDir();
  const addArgs: string[][] = [];
  try {
    await initRepo(dir);
    const dryRun: CommandRunner = async (cmd, args, cwd, timeoutMs) => {
      if (cmd === 'git' && args[0] === 'add') {
        addArgs.push(args);
        const r = spawnSync(cmd, ['add', '--dry-run', ...args.slice(1)], { cwd, encoding: 'utf8', timeout: timeoutMs });
        return {
          ok: r.status === 0,
          code: r.status,
          spawnFailed: false,
          stdout: r.stdout ?? '',
          stderr: r.stderr ?? '',
        };
      }
      const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs });
      return { ok: r.status === 0, code: r.status, spawnFailed: false, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };

    await fs.mkdir(path.join(dir, '.tiger', 'worktrees', 'TASK-001'), { recursive: true });
    await fs.writeFile(path.join(dir, '.tiger', 'worktrees', 'TASK-001', 'internal.txt'), 'internal\n', 'utf8');
    await fs.writeFile(path.join(dir, 'feature.ts'), 'export const z = 3;\n', 'utf8');

    await stageAll(dir, dryRun);

    assert.deepEqual(addArgs, [
      ['add', '-A', '--', '.', ':(exclude).tiger', ':(exclude).tiger/**', ':(exclude).kaplan', ':(exclude).kaplan/**'],
    ]);
    assert.equal(git(dir, ['diff', '--cached', '--name-only']), '');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('commit rejects an empty message with a 422 HttpError', async (t) => {
  if (!gitAvailable()) return t.skip('git not available');
  const dir = await tmpDir();
  try {
    await initRepo(dir);
    await assert.rejects(
      () => commit(dir, '   '),
      (err: unknown) => err instanceof HttpError && err.status === 422 && err.code === 'validation_failed',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('commit handles "nothing to commit" gracefully (no throw)', async (t) => {
  if (!gitAvailable()) return t.skip('git not available');
  const dir = await tmpDir();
  try {
    await initRepo(dir);
    await stageAll(dir); // nothing to stage — working tree is clean
    const result = await commit(dir, 'noop');
    assert.equal(result.committed, false);
    assert.equal(result.sha, null);
    assert.match(result.summary, /nothing to commit/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('git-write helpers reject a non-repo directory with a 409 HttpError', async (t) => {
  if (!gitAvailable()) return t.skip('git not available');
  const dir = await tmpDir();
  try {
    const isConflict = (err: unknown): boolean => err instanceof HttpError && err.status === 409;
    await assert.rejects(() => stageAll(dir), isConflict);
    await assert.rejects(() => commit(dir, 'msg'), isConflict);
    await assert.rejects(() => createPullRequest(dir, { title: 'x' }), isConflict);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createPullRequest throws a typed error when gh is missing (injected runner)', async (t) => {
  if (!gitAvailable()) return t.skip('git not available');
  const dir = await tmpDir();
  try {
    await initRepo(dir);
    // Simulate `gh` not being installed: any `gh` invocation reports spawnFailed.
    const noGh: CommandRunner = async (cmd, args, cwd, timeoutMs) => {
      if (cmd === 'gh') return { ok: false, code: null, spawnFailed: true, stdout: '', stderr: '' };
      // Delegate git to the real runner so repo/branch checks still pass.
      const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs });
      return { ok: r.status === 0, code: r.status, spawnFailed: false, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    await assert.rejects(
      () => createPullRequest(dir, { title: 'My PR' }, noGh),
      (err: unknown) => err instanceof HttpError && err.status === 409 && /gh/i.test(err.message),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
