import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createWorktree, removeWorktree, type Worktree } from '../git/worktree.js';
import { logger } from '../obs/logger.js';

// ---------------------------------------------------------------------------
// Build lanes — worktree isolation for parallel build items.
//
// A lane is a throwaway git worktree that receives a SNAPSHOT of the main
// workspace's current state (HEAD + uncommitted changes + untracked files),
// runs one build item, and hands its work back as a PATCH applied onto the
// main working tree. The patch model preserves both v2 invariants the merge
// path must never break: Kaplan NEVER commits on the user's branch, and the
// Changes panel stays a plain working-tree diff. Lane-local commits are fine —
// the branch is torn down afterwards.
//
// Conflict policy: `git apply --check` first; a patch that no longer applies
// (two lanes touched the same lines) is NOT force-merged — the caller re-runs
// that item sequentially in the main workspace instead.
// ---------------------------------------------------------------------------

const log = logger.child({ mod: 'run/lanes' });

const GIT_TIMEOUT_MS = 60_000;

export interface BuildLane {
  itemId: string;
  worktree: Worktree;
  /** The lane-local commit that captured the main workspace snapshot. */
  snapshotSha: string;
}

export interface LaneMergeResult {
  ok: boolean;
  /** Files the lane changed (relative paths). */
  files: string[];
  /** Failure detail when `ok` is false (patch conflict, git error). */
  detail?: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run git with argv discipline (no shell); never rejects. */
function runGit(cwd: string, args: string[], input?: string, maxBytes = 5_000_000): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolve({ ok, stdout, stderr });
      }
    };
    try {
      const child = spawn('git', args, { cwd, windowsHide: true, shell: false });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish(false);
      }, GIT_TIMEOUT_MS);
      timer.unref?.();
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < maxBytes) stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < 64_000) stderr += chunk;
      });
      child.on('error', () => {
        clearTimeout(timer);
        finish(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code === 0);
      });
      if (input !== undefined) child.stdin?.write(input);
      child.stdin?.end();
    } catch {
      finish(false);
    }
  });
}

/**
 * Create the lane for a build item and seed it with the main workspace's
 * current state: the worktree branches from HEAD, then the main tree's
 * uncommitted tracked diff is applied and untracked files are copied over, so
 * every lane starts from the exact state a sequential build would see.
 */
export async function prepareLane(workspace: string, runId: string, itemId: string): Promise<BuildLane> {
  const worktree = await createWorktree({ repoDir: workspace, taskId: `${runId}-${itemId}` });

  // Uncommitted tracked changes (staged + unstaged vs HEAD) → apply in the lane.
  const tracked = await runGit(workspace, ['-c', 'core.quotePath=false', 'diff', '--binary', 'HEAD']);
  if (tracked.ok && tracked.stdout.trim()) {
    const applied = await runGit(worktree.path, ['apply', '--binary', '--whitespace=nowarn'], tracked.stdout);
    if (!applied.ok) {
      log.warn('lane snapshot: tracked diff did not apply cleanly', { itemId, detail: applied.stderr.trim() });
    }
  }

  // Untracked files (no HEAD baseline) → plain copy.
  const untracked = await runGit(workspace, [
    '-c',
    'core.quotePath=false',
    'ls-files',
    '--others',
    '--exclude-standard',
  ]);
  if (untracked.ok) {
    for (const line of untracked.stdout.split('\n')) {
      const rel = line.replace(/\r$/, '').trim();
      if (!rel) continue;
      const from = path.join(workspace, rel);
      const to = path.join(worktree.path, rel);
      try {
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.copyFile(from, to);
      } catch {
        /* deleted-in-flight or unreadable — the lane simply starts without it */
      }
    }
  }

  // Commit the snapshot so the lane's own work is exactly snapshot..HEAD later.
  await runGit(worktree.path, ['add', '-A']);
  await runGit(worktree.path, ['commit', '--allow-empty', '--no-verify', '-m', 'kaplan: lane baseline snapshot']);
  const sha = await runGit(worktree.path, ['rev-parse', 'HEAD']);
  const snapshotSha = sha.stdout.trim();
  if (!sha.ok || !snapshotSha) {
    await cleanupLane(workspace, { itemId, worktree, snapshotSha: '' }).catch(() => {});
    throw new Error(`lane ${itemId}: could not commit the baseline snapshot`);
  }
  return { itemId, worktree, snapshotSha };
}

/**
 * Collect the lane's work and apply it onto the MAIN working tree as a patch
 * (no commit on the user's branch). Returns `ok: false` on a patch conflict —
 * the main tree is left untouched in that case.
 */
export async function mergeLane(workspace: string, lane: BuildLane): Promise<LaneMergeResult> {
  // Commit everything the agent did so untracked files are diffable.
  await runGit(lane.worktree.path, ['add', '-A']);
  await runGit(lane.worktree.path, ['commit', '--allow-empty', '--no-verify', '-m', `kaplan: ${lane.itemId} result`]);

  const names = await runGit(lane.worktree.path, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--name-only',
    lane.snapshotSha,
    'HEAD',
  ]);
  const files = names.stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter(Boolean);
  if (files.length === 0) return { ok: true, files: [] };

  const patch = await runGit(lane.worktree.path, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--binary',
    lane.snapshotSha,
    'HEAD',
  ]);
  if (!patch.ok) return { ok: false, files, detail: `lane diff failed: ${patch.stderr.trim()}` };

  // Dry-run first: a conflicting patch must not half-apply onto the main tree.
  const check = await runGit(workspace, ['apply', '--check', '--binary', '--whitespace=nowarn'], patch.stdout);
  if (!check.ok) return { ok: false, files, detail: `patch conflict: ${check.stderr.trim().slice(0, 500)}` };

  const applied = await runGit(workspace, ['apply', '--binary', '--whitespace=nowarn'], patch.stdout);
  if (!applied.ok) return { ok: false, files, detail: `patch apply failed: ${applied.stderr.trim().slice(0, 500)}` };
  return { ok: true, files };
}

/** Tear the lane down: remove the worktree and delete its throwaway branch. */
export async function cleanupLane(workspace: string, lane: BuildLane): Promise<void> {
  await removeWorktree({ repoDir: workspace, path: lane.worktree.path, force: true }).catch(() => {});
  await runGit(workspace, ['branch', '-D', lane.worktree.branch]);
}
