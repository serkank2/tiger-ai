import { spawn } from 'node:child_process';
import path from 'node:path';
import { logger } from '../obs/logger.js';

// ---------------------------------------------------------------------------
// Git worktree isolation primitive.
//
// Each agent/task can run in its own isolated working copy (a git worktree on a
// dedicated branch) so parallel runs never stomp on each other's files. This is
// the pattern vibe-kanban / agtx / Maestro use for safe parallelism: create a
// throwaway worktree off a base ref, let the agent work there, diff the result
// against the base, then merge back and remove the worktree.
//
// All git invocations go through `spawn('git', args, { shell: false })` — the
// same style as team/changes.ts — so paths and refs are passed as discrete argv
// tokens and can never be shell-injected. Paths are built with `node:path` so
// this works on Windows as well as POSIX.
// ---------------------------------------------------------------------------

const log = logger.child({ mod: 'git/worktree' });

const GIT_TIMEOUT_MS = 30_000;
const MAX_DIFF_CHARS = 200_000;

/** A managed git worktree: an isolated working copy on its own branch. */
export interface Worktree {
  /** The task this worktree belongs to (used to derive the branch + path). */
  taskId: string;
  /** Absolute path to the worktree's working directory. */
  path: string;
  /** The branch checked out in the worktree (e.g. `kaplan/<taskId>`). */
  branch: string;
  /** The ref the worktree branch was created from (a commit-ish). */
  baseRef: string;
}

export interface CreateWorktreeOptions {
  /** The source repository (any path inside its work tree). */
  repoDir: string;
  /** Identifier for the task; sanitized into the branch + directory name. */
  taskId: string;
  /** Ref to branch from. Defaults to the repo's current HEAD. */
  baseRef?: string;
  /** Where managed worktrees live. Defaults to `<repoRoot>/.kaplan/worktrees`. */
  rootDir?: string;
}

export interface RemoveWorktreeOptions {
  repoDir: string;
  /** The worktree path to remove (as returned by `createWorktree`/`listWorktrees`). */
  path: string;
  /** Pass git's `--force` up front (otherwise it is used as a fallback). */
  force?: boolean;
}

export interface WorktreeDiffOptions {
  /** The worktree working directory. */
  worktreePath: string;
  /** The ref to diff against (the base the worktree branched from). */
  baseRef: string;
}

export interface WorktreeDiff {
  /** Paths (relative to the worktree root) that differ from `baseRef`. */
  files: string[];
  /** Unified diff vs `baseRef`, bounded to a sane size. */
  diff: string;
  /** `git diff --stat` summary. */
  stat: string;
}

/** Thrown for actionable git/worktree failures (vs. tolerated/degraded cases). */
export class WorktreeError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

const QUOTE_OFF = ['-c', 'core.quotePath=false'];

/**
 * Run a git command in `cwd`, capturing stdout+stderr. Never rejects; `ok`
 * reflects exit code 0. Mirrors the runner in team/changes.ts but also keeps
 * stderr so callers can surface a real error message.
 */
function runGit(cwd: string, args: string[], maxBytes = 1_000_000): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (ok: boolean, code: number | null): void => {
      if (!settled) {
        settled = true;
        resolve({ ok, code, stdout, stderr });
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
        finish(false, null);
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
        finish(false, null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code === 0, code);
      });
    } catch {
      finish(false, null);
    }
  });
}

/** Run git and throw a `WorktreeError` on failure. */
async function runGitOrThrow(cwd: string, args: string[], what: string, maxBytes?: number): Promise<string> {
  const res = await runGit(cwd, args, maxBytes);
  if (!res.ok) {
    throw new WorktreeError(`git ${what} failed`, res.stderr.trim() || `exit ${res.code}`);
  }
  return res.stdout;
}

/**
 * Sanitize a task id into a token safe for a git ref component and a path
 * segment: only `[A-Za-z0-9._-]`, no leading/trailing dots/dashes, never empty.
 * (Git ref rules forbid `..`, leading/trailing `/`, control chars, etc.; this
 * conservative subset sidesteps all of them.)
 */
export function sanitizeTaskId(taskId: string): string {
  const cleaned = taskId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '');
  if (!cleaned) {
    throw new WorktreeError(`taskId "${taskId}" sanitizes to an empty string`);
  }
  return cleaned;
}

/** Whether `dir` is inside a git work tree. Never throws. */
export async function isGitRepo(dir: string): Promise<boolean> {
  const res = await runGit(dir, ['rev-parse', '--is-inside-work-tree']);
  return res.ok && res.stdout.trim() === 'true';
}

/** Resolve the top-level directory of the repo containing `dir`. */
async function repoToplevel(dir: string): Promise<string> {
  const out = await runGitOrThrow(dir, ['rev-parse', '--show-toplevel'], 'rev-parse --show-toplevel');
  const top = out.trim();
  if (!top) throw new WorktreeError(`could not resolve repo top-level for "${dir}"`);
  return path.resolve(top);
}

/** Resolve a ref to a full commit sha; returns null if it does not resolve. */
async function resolveRef(dir: string, ref: string): Promise<string | null> {
  const res = await runGit(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = res.stdout.trim();
  return res.ok && sha ? sha : null;
}

/** Whether a local branch exists. */
async function branchExists(dir: string, branch: string): Promise<boolean> {
  const res = await runGit(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return res.ok && res.stdout.trim().length > 0;
}

/**
 * Create an isolated worktree for `taskId` off `baseRef` (default: current HEAD).
 *
 * The worktree lives at `<rootDir|repoRoot/.kaplan/worktrees>/<taskId>` on a new
 * branch `kaplan/<taskId>`. Idempotent-ish: if a worktree already exists at the
 * target path on the expected branch it is reused; a path/branch collision that
 * does NOT match the expectation throws a clear `WorktreeError`.
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<Worktree> {
  const { repoDir } = opts;
  if (!(await isGitRepo(repoDir))) {
    throw new WorktreeError(`"${repoDir}" is not inside a git work tree`);
  }

  const taskId = sanitizeTaskId(opts.taskId);
  const branch = `kaplan/${taskId}`;
  const repoRoot = await repoToplevel(repoDir);
  const rootDir = opts.rootDir ? path.resolve(opts.rootDir) : path.join(repoRoot, '.kaplan', 'worktrees');
  const worktreePath = path.join(rootDir, taskId);

  // Resolve the base ref to a concrete commit so the returned baseRef is a stable
  // anchor for later diffs even if branches move. Default to HEAD.
  const requestedBase = opts.baseRef?.trim() || 'HEAD';
  const baseSha = await resolveRef(repoDir, requestedBase);
  if (!baseSha) {
    throw new WorktreeError(`base ref "${requestedBase}" does not resolve to a commit`);
  }

  // Reuse an existing managed worktree if it already matches what we'd create.
  const existing = (await listWorktrees(repoDir)).find((w) => path.resolve(w.path) === path.resolve(worktreePath));
  if (existing) {
    const expectedBranch = `refs/heads/${branch}`;
    if (existing.branch === branch || existing.branch === expectedBranch) {
      log.info('reusing existing worktree', { taskId, path: existing.path, branch });
      return { taskId, path: existing.path, branch, baseRef: baseSha };
    }
    throw new WorktreeError(
      `a worktree already exists at "${worktreePath}" on branch "${existing.branch}", expected "${branch}"`,
    );
  }

  // `git worktree add` creates parent dirs as needed. Use `-b` for a fresh branch,
  // or `-B`/checkout if the branch already exists from a prior aborted run.
  const addArgs = ['worktree', 'add'];
  if (await branchExists(repoDir, branch)) {
    // Branch exists but no worktree references this path: attach the existing branch.
    addArgs.push(worktreePath, branch);
  } else {
    addArgs.push('-b', branch, worktreePath, baseSha);
  }

  await runGitOrThrow(repoDir, addArgs, 'worktree add');
  log.info('created worktree', { taskId, path: worktreePath, branch, baseRef: baseSha });

  return { taskId, path: path.resolve(worktreePath), branch, baseRef: baseSha };
}

/**
 * Remove a managed worktree and prune stale administrative refs. Tolerant: if
 * the worktree is already gone this resolves without error. Falls back to
 * `--force` when a plain remove is refused (e.g. dirty/locked worktree).
 */
export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
  const { repoDir } = opts;
  const target = path.resolve(opts.path);

  if (!(await isGitRepo(repoDir))) {
    // Nothing we can do via git; treat as already-removed.
    log.warn('removeWorktree: repoDir is not a git repo, skipping', { repoDir, path: target });
    return;
  }

  const removeArgs = ['worktree', 'remove'];
  if (opts.force) removeArgs.push('--force');
  removeArgs.push(target);

  let res = await runGit(repoDir, removeArgs);
  if (!res.ok && !opts.force) {
    // Retry with --force (dirty working tree, untracked files, lock, …).
    res = await runGit(repoDir, ['worktree', 'remove', '--force', target]);
  }

  // Always prune so a manually-deleted directory's bookkeeping is cleaned up.
  await runGit(repoDir, ['worktree', 'prune']);

  if (!res.ok) {
    // Tolerate the common "already removed / not a working tree" case; otherwise log.
    const stderr = res.stderr.toLowerCase();
    const alreadyGone = stderr.includes('is not a working tree') || stderr.includes('no such') || stderr.includes('not found');
    if (!alreadyGone) {
      log.warn('worktree remove reported an error (pruned anyway)', { path: target, detail: res.stderr.trim() });
    }
  }
  log.info('removed worktree', { path: target });
}

/** Parse `git worktree list --porcelain` into `Worktree[]`. */
function parsePorcelainList(out: string, repoRoot: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let cur: { path?: string; branch?: string; head?: string } = {};
  const flush = (): void => {
    if (cur.path) {
      const branchRef = cur.branch ?? '';
      const branch = branchRef.replace(/^refs\/heads\//, '') || (cur.head ? `(detached:${cur.head.slice(0, 12)})` : '(bare)');
      // Derive taskId from a managed path under `.kaplan/worktrees/<taskId>`.
      const base = path.basename(cur.path);
      worktrees.push({ taskId: base, path: path.resolve(cur.path), branch, baseRef: cur.head ?? '' });
    }
    cur = {};
  };
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      cur.path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim();
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim();
    }
  }
  flush();
  void repoRoot;
  return worktrees;
}

/** List all worktrees registered in `repoDir`'s repository. Empty array if not a repo. */
export async function listWorktrees(repoDir: string): Promise<Worktree[]> {
  if (!(await isGitRepo(repoDir))) return [];
  const res = await runGit(repoDir, ['worktree', 'list', '--porcelain']);
  if (!res.ok) return [];
  let repoRoot = repoDir;
  try {
    repoRoot = await repoToplevel(repoDir);
  } catch {
    /* keep repoDir */
  }
  return parsePorcelainList(res.stdout, repoRoot);
}

/**
 * Diff a worktree's current state against its base ref. Uses the same
 * name-status / stat / unified-diff trio as team/changes.ts, plus untracked
 * files (which have no baseline to diff). The diff is `git diff <baseRef>`,
 * i.e. base-vs-working-tree, capturing everything the agent changed.
 */
export async function worktreeDiff(opts: WorktreeDiffOptions): Promise<WorktreeDiff> {
  const { worktreePath, baseRef } = opts;
  if (!(await isGitRepo(worktreePath))) {
    throw new WorktreeError(`"${worktreePath}" is not inside a git work tree`);
  }

  const [nameStatus, untracked, statRes, diffRes] = await Promise.all([
    runGit(worktreePath, [...QUOTE_OFF, 'diff', baseRef, '--name-only']),
    runGit(worktreePath, [...QUOTE_OFF, 'ls-files', '--others', '--exclude-standard']),
    runGit(worktreePath, ['diff', baseRef, '--stat']),
    runGit(worktreePath, [...QUOTE_OFF, 'diff', baseRef], MAX_DIFF_CHARS + 1024),
  ]);

  const files = new Set<string>();
  if (nameStatus.ok) {
    for (const line of nameStatus.stdout.split('\n')) {
      const p = line.replace(/\r$/, '').trim();
      if (p) files.add(p);
    }
  }
  if (untracked.ok) {
    for (const line of untracked.stdout.split('\n')) {
      const p = line.replace(/\r$/, '').trim();
      if (p) files.add(p);
    }
  }

  let diff = diffRes.ok ? diffRes.stdout : '';
  if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS);

  return {
    files: [...files].sort(),
    diff,
    stat: statRes.ok ? statRes.stdout.trim() : '',
  };
}
