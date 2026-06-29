import { spawn } from 'node:child_process';
import { logger } from '../obs/logger.js';
import { HttpError, conflict, validationFailed } from '../http/errors.js';
import { isGitRepo } from './worktree.js';

// ---------------------------------------------------------------------------
// Git WRITE helpers — the outward, side-effecting counterpart to the read-only
// `team/changes.ts`. These are the operations behind the Team "Stage / Commit /
// Create-PR" controls: stage the working tree, commit it, and open a PR via the
// GitHub CLI (`gh`).
//
// Every invocation goes through `spawn(cmd, args, { shell: false })` with discrete
// argv tokens (never a shell string) so a commit message or PR title can never be
// shell-injected, plus a timeout guard and `windowsHide`. We deliberately do NOT
// push or force-push: `gh pr create` performs the push it needs itself, and we
// never reach for a bare `git push` (which could clobber a remote branch). Callers
// get a typed `HttpError` for actionable failures (empty message, missing `gh`,
// not a repo) instead of opaque 500s.
// ---------------------------------------------------------------------------

const log = logger.child({ mod: 'git/write' });

const GIT_TIMEOUT_MS = 30_000;
const GH_TIMEOUT_MS = 60_000;
const SAFE_STAGE_PATHS = ['.', ':(exclude).kaplan', ':(exclude).kaplan/**'] as const;

interface RunResult {
  ok: boolean;
  code: number | null;
  /** True when the binary itself could not be spawned (ENOENT etc.). */
  spawnFailed: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run an external command, capturing stdout+stderr. Never rejects; `ok` reflects
 * exit code 0 and `spawnFailed` distinguishes "binary not found" from "ran but
 * failed". Mirrors the runner style in worktree.ts / changes.ts.
 */
export type CommandRunner = (cmd: string, args: string[], cwd: string, timeoutMs: number) => Promise<RunResult>;

const defaultRunner: CommandRunner = (cmd, args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let spawnFailed = false;
    const finish = (ok: boolean, code: number | null): void => {
      if (!settled) {
        settled = true;
        resolve({ ok, code, spawnFailed, stdout, stderr });
      }
    };
    try {
      const child = spawn(cmd, args, { cwd, windowsHide: true, shell: false });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish(false, null);
      }, timeoutMs);
      timer.unref?.();
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < 1_000_000) stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < 64_000) stderr += chunk;
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === 'ENOENT') spawnFailed = true;
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

const git = (run: CommandRunner, repoDir: string, args: string[]) => run('git', args, repoDir, GIT_TIMEOUT_MS);

/** Throw a 409 if `repoDir` is not inside a git work tree. */
async function assertRepo(repoDir: string): Promise<void> {
  if (!(await isGitRepo(repoDir))) {
    throw conflict(`"${repoDir}" is not a git repository, so git operations are unavailable`);
  }
}

/** The current branch name, or null when detached / unavailable. */
export async function currentBranch(repoDir: string, run: CommandRunner = defaultRunner): Promise<string | null> {
  const res = await git(run, repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!res.ok) return null;
  const name = res.stdout.trim();
  return name && name !== 'HEAD' ? name : null;
}

/**
 * Whether the work tree has any staged or unstaged changes (tracked modifications
 * or untracked files). Uses `git status --porcelain` — empty output means clean.
 */
export async function hasStagedOrUnstagedChanges(repoDir: string, run: CommandRunner = defaultRunner): Promise<boolean> {
  const res = await git(run, repoDir, ['status', '--porcelain']);
  if (!res.ok) return false;
  return res.stdout.split('\n').some((line) => line.trim().length > 0);
}

/** Stage everything (`git add -A`). Throws `HttpError` if not a repo or git fails. */
export async function stageAll(repoDir: string, run: CommandRunner = defaultRunner): Promise<void> {
  await assertRepo(repoDir);
  const res = await git(run, repoDir, ['add', '-A', '--', ...SAFE_STAGE_PATHS]);
  if (!res.ok) {
    throw new HttpError(500, 'internal', 'git add failed', res.stderr.trim() || `exit ${res.code}`);
  }
  log.info('staged all changes', { repoDir });
}

export interface CommitResult {
  /** True when a commit was created; false for the tolerated "nothing to commit" case. */
  committed: boolean;
  /** Full sha of the new commit (only when `committed`). */
  sha: string | null;
  /** One-line `git show`-style summary of the new commit, or a human note when nothing changed. */
  summary: string;
}

/**
 * Commit the index with `message`. Rejects an empty/whitespace message with a 422.
 * Handles "nothing to commit" gracefully: returns `{ committed: false }` rather
 * than throwing a 500. Returns the new commit sha + a one-line summary on success.
 */
export async function commit(repoDir: string, message: string, run: CommandRunner = defaultRunner): Promise<CommitResult> {
  await assertRepo(repoDir);
  const trimmed = (message ?? '').trim();
  if (!trimmed) {
    throw validationFailed('a non-empty commit message is required');
  }

  const res = await git(run, repoDir, ['commit', '-m', trimmed]);
  if (!res.ok) {
    // "nothing to commit" is an expected, non-error outcome — surface it as a typed result.
    const out = `${res.stdout}\n${res.stderr}`.toLowerCase();
    if (out.includes('nothing to commit') || out.includes('no changes added to commit') || out.includes('nothing added to commit')) {
      return { committed: false, sha: null, summary: 'Nothing to commit — the working tree is clean.' };
    }
    throw new HttpError(500, 'internal', 'git commit failed', res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
  }

  const shaRes = await git(run, repoDir, ['rev-parse', 'HEAD']);
  const sha = shaRes.ok ? shaRes.stdout.trim() : null;
  const summaryRes = await git(run, repoDir, ['show', '--no-patch', '--format=%h %s', 'HEAD']);
  const summary = summaryRes.ok && summaryRes.stdout.trim() ? summaryRes.stdout.trim() : trimmed;
  log.info('created commit', { repoDir, sha });
  return { committed: true, sha, summary };
}

export interface CreatePrOptions {
  title: string;
  body?: string;
  /** Base branch for the PR (defaults to the repo's default branch when omitted). */
  base?: string;
}

export interface CreatePrResult {
  url: string;
}

/**
 * Open a pull request for the current branch via the GitHub CLI (`gh pr create`).
 *
 * Safety:
 *  - Requires `gh` to be installed AND authenticated; either gap throws an
 *    actionable `HttpError` (409 not-installed / 409 not-authenticated) instead
 *    of attempting any fallback push.
 *  - We never run a bare `git push` or any `--force` ourselves. `gh pr create`
 *    pushes the current branch as needed; that is the only push that happens.
 *  - Refuses to open a PR from a detached HEAD (no branch to push).
 *
 * `gh` is run through the same injectable runner so the missing-`gh` branch is
 * unit-testable without the binary present.
 */
export async function createPullRequest(
  repoDir: string,
  opts: CreatePrOptions,
  run: CommandRunner = defaultRunner,
): Promise<CreatePrResult> {
  await assertRepo(repoDir);

  const title = (opts.title ?? '').trim();
  if (!title) {
    throw validationFailed('a non-empty PR title is required');
  }

  const branch = await currentBranch(repoDir, run);
  if (!branch) {
    throw conflict('cannot open a PR from a detached HEAD — check out a branch first');
  }

  // Verify gh is present + authenticated before attempting any outward action.
  const authRes = await run('gh', ['auth', 'status'], repoDir, GH_TIMEOUT_MS);
  if (authRes.spawnFailed) {
    throw conflict(
      'the GitHub CLI ("gh") is not installed or not on PATH. Install it from https://cli.github.com and run "gh auth login" to enable Create PR.',
    );
  }
  if (!authRes.ok) {
    throw conflict('the GitHub CLI ("gh") is not authenticated. Run "gh auth login" to enable Create PR.');
  }

  const args = ['pr', 'create', '--title', title, '--body', opts.body ?? ''];
  if (opts.base?.trim()) {
    args.push('--base', opts.base.trim());
  }
  // `--head` pins the PR to the branch we validated above; gh pushes it as needed.
  args.push('--head', branch);

  const res = await run('gh', args, repoDir, GH_TIMEOUT_MS);
  if (res.spawnFailed) {
    throw conflict(
      'the GitHub CLI ("gh") is not installed or not on PATH. Install it from https://cli.github.com and run "gh auth login" to enable Create PR.',
    );
  }
  if (!res.ok) {
    const detail = res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`;
    // gh emits an actionable message (no commits, PR already exists, no remote, …) on stderr.
    throw validationFailed(`gh pr create failed: ${detail}`);
  }

  // gh prints the PR URL on stdout.
  const url = (res.stdout.match(/https?:\/\/\S+/) ?? [])[0] ?? res.stdout.trim();
  if (!url) {
    throw new HttpError(500, 'internal', 'gh pr create succeeded but returned no PR URL');
  }
  log.info('created pull request', { repoDir, branch, url });
  return { url };
}
