import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// "What did the agents change?" — computes the real product changes a team run
// made in its workspace (the actual project, NOT the .tiger bookkeeping) by
// shelling out to git. The team never commits, so a working-tree diff against
// HEAD is exactly the set of changes the agents produced this run. Untracked
// files are listed separately (they have no HEAD baseline to diff against).
//
// Robustness choices: we read git's `--name-status` / `ls-files` / `--shortstat`
// (well-defined, newline-delimited) rather than porcelain `-z` rename parsing,
// and force `core.quotePath=false` so non-ASCII paths come back as real UTF-8.
// Everything is best-effort and never throws: a non-git workspace, a missing
// git binary, or an empty repo all degrade to a clear, honest result.
// ---------------------------------------------------------------------------

export type TeamChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'unknown';

export interface TeamChangeFile {
  /** Path relative to the workspace root. */
  path: string;
  status: TeamChangeStatus;
  /** Original path for a rename/copy. */
  oldPath?: string;
}

export interface TeamChanges {
  /** False when the workspace is not a git work tree (then `files`/`diff` are empty). */
  isGitRepo: boolean;
  /** Short HEAD sha, or null for an empty repo / non-repo. */
  head: string | null;
  /** Current branch, or null when detached / unavailable. */
  branch: string | null;
  files: TeamChangeFile[];
  /** Unified diff of tracked changes vs HEAD (bounded). Empty when there is nothing tracked-changed. */
  diff: string;
  /** True when `diff` was clipped to the size cap. */
  diffTruncated: boolean;
  summary: { files: number; insertions: number; deletions: number };
  generatedAt: string;
  /** Human-readable note when the result is degraded (no git, empty repo, …). */
  note?: string;
}

const MAX_DIFF_CHARS = 200_000;
const GIT_TIMEOUT_MS = 10_000;

interface GitResult {
  ok: boolean;
  stdout: string;
}

/** Run a git command in `cwd`, capturing stdout. Never rejects; `ok` is false on any failure. */
function runGit(cwd: string, args: string[], maxBytes = 1_000_000): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolve({ ok, stdout });
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
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < maxBytes) stdout += chunk;
      });
      child.on('error', () => {
        clearTimeout(timer);
        finish(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code === 0);
      });
    } catch {
      finish(false);
    }
  });
}

const QUOTE_OFF = ['-c', 'core.quotePath=false'];

function mapStatusLetter(letter: string): TeamChangeStatus {
  switch (letter) {
    case 'A':
      return 'added';
    case 'M':
    case 'T': // type change (e.g. file ↔ symlink) — surface as a modification
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    default:
      return 'unknown';
  }
}

/** Parse `git diff --name-status` output (newline-delimited; tab-separated fields). */
function parseNameStatus(out: string): TeamChangeFile[] {
  const files: TeamChangeFile[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    const letter = (fields[0] ?? '')[0] ?? '';
    const status = mapStatusLetter(letter);
    if ((letter === 'R' || letter === 'C') && fields.length >= 3) {
      files.push({ path: fields[2]!, oldPath: fields[1], status });
    } else if (fields[1]) {
      files.push({ path: fields[1], status });
    }
  }
  return files;
}

/** Parse `git diff --shortstat` ("N files changed, X insertions(+), Y deletions(-)"). */
function parseShortstat(out: string): { insertions: number; deletions: number } {
  const ins = /(\d+) insertion/.exec(out);
  const del = /(\d+) deletion/.exec(out);
  return { insertions: ins ? Number(ins[1]) : 0, deletions: del ? Number(del[1]) : 0 };
}

/**
 * Compute the working-tree changes in `workspace` (the real project). Best-effort and
 * never throws. The caller passes the run's workspace; `.tiger` bookkeeping is ignored
 * because git already does not track it once the project's `.gitignore` excludes it — and
 * even if it does, these are genuine changes worth surfacing.
 */
export async function computeTeamChanges(workspace: string, generatedAt: string): Promise<TeamChanges> {
  const base: TeamChanges = {
    isGitRepo: false,
    head: null,
    branch: null,
    files: [],
    diff: '',
    diffTruncated: false,
    summary: { files: 0, insertions: 0, deletions: 0 },
    generatedAt,
  };

  const insideTree = await runGit(workspace, ['rev-parse', '--is-inside-work-tree']);
  if (!insideTree.ok || insideTree.stdout.trim() !== 'true') {
    return { ...base, note: 'The team workspace is not a git repository, so changes cannot be shown as a diff.' };
  }

  const [headRes, branchRes] = await Promise.all([
    runGit(workspace, ['rev-parse', '--short', 'HEAD']),
    runGit(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  const head = headRes.ok ? headRes.stdout.trim() || null : null;
  const branch = branchRes.ok ? branchRes.stdout.trim() || null : null;

  // Diff base: against HEAD when the repo has a commit, otherwise against the (empty) index
  // so a brand-new repo still surfaces staged work.
  const diffBaseArgs = head ? ['HEAD'] : [];

  const [nameStatus, untracked, shortstat, diffRes] = await Promise.all([
    runGit(workspace, [...QUOTE_OFF, 'diff', ...diffBaseArgs, '--name-status']),
    runGit(workspace, [...QUOTE_OFF, 'ls-files', '--others', '--exclude-standard']),
    runGit(workspace, ['diff', ...diffBaseArgs, '--shortstat']),
    runGit(workspace, [...QUOTE_OFF, 'diff', ...diffBaseArgs], MAX_DIFF_CHARS + 1024),
  ]);

  const files = nameStatus.ok ? parseNameStatus(nameStatus.stdout) : [];
  if (untracked.ok) {
    for (const line of untracked.stdout.split('\n')) {
      const p = line.trim();
      if (p) files.push({ path: p, status: 'untracked' });
    }
  }

  let diff = diffRes.ok ? diffRes.stdout : '';
  let diffTruncated = false;
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS);
    diffTruncated = true;
  }

  const stat = shortstat.ok ? parseShortstat(shortstat.stdout) : { insertions: 0, deletions: 0 };

  return {
    ...base,
    isGitRepo: true,
    head,
    branch,
    files,
    diff,
    diffTruncated,
    summary: { files: files.length, insertions: stat.insertions, deletions: stat.deletions },
    generatedAt,
    note: head ? undefined : 'This repository has no commits yet; showing staged and untracked work.',
  };
}
