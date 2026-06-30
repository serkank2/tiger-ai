import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FindingStatus, FindingsSummary } from './types.js';
import { acquireLock, isLockStale, releaseLock } from './tasks.js';

export type { FindingStatus, FindingsSummary };

// ---------------------------------------------------------------------------
// Review findings as a claimable work queue. Task review runs in two phases:
//   FIND — review agents report problems as `## FINDING` blocks in their logs.
//   FIX  — the orchestrator splits those into one file per finding
//          (findings/<FINDING-ID>__<status>.md), and fix agents claim them by an
//          atomic rename (open -> fixing) and resolve them one at a time, so two
//          agents never fix the same finding.
// ---------------------------------------------------------------------------

const FINDING_FILE_RE = /^(FINDING-[A-Za-z0-9_-]+)__(open|fixing|fixed|wontfix)\.md$/;

export interface FindingRecord {
  id: string;
  status: FindingStatus;
  title: string;
  relatedTask?: string;
}

export function findingFileName(id: string, status: FindingStatus): string {
  return `${id}__${status}.md`;
}
export function parseFindingFileName(name: string): { id: string; status: FindingStatus } | null {
  const m = FINDING_FILE_RE.exec(name);
  return m ? { id: m[1]!, status: m[2]! as FindingStatus } : null;
}

function queueLockFile(locksDir: string, id: string): string {
  return path.join(locksDir, `${id}.lock`);
}

async function pathExists(file: string): Promise<boolean> {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
}

async function isFileOlderThan(file: string, ttlMs: number, nowMs = Date.now()): Promise<boolean> {
  if (ttlMs <= 0) return false;
  const st = await fs.stat(file).catch(() => null);
  return !!st && nowMs - st.mtimeMs > ttlMs;
}

async function shouldReclaimClaimFile(
  file: string,
  lockFile: string | null,
  ttlMs: number,
  nowMs = Date.now(),
): Promise<boolean> {
  if (lockFile && (await pathExists(lockFile))) return isLockStale(lockFile, ttlMs, nowMs);
  return isFileOlderThan(file, ttlMs, nowMs);
}

/** Extract `## FINDING…` blocks from a review log. A lone "No findings." yields nothing. */
export function parseFindingBlocks(content: string): { title: string; relatedTask?: string; body: string }[] {
  const lines = content.split(/\r?\n/);
  const heads: number[] = [];
  for (let i = 0; i < lines.length; i++) if (/^##\s+FINDING\b/i.test(lines[i]!)) heads.push(i);
  const out: { title: string; relatedTask?: string; body: string }[] = [];
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h]!;
    const end = h + 1 < heads.length ? heads[h + 1]! : lines.length;
    const body = lines.slice(start, end).join('\n').trim();
    const title =
      lines[start]!.replace(/^##\s+/, '')
        .replace(/^FINDING[:\s-]*/i, '')
        .trim() || 'finding';
    const rel = /related task[:\s]*\**\s*(TASK-[A-Za-z0-9_-]+)/i.exec(body);
    out.push({ title, relatedTask: rel?.[1], body });
  }
  return out;
}

/** Collect findings from review logs and write one file per finding with a globally unique id. */
export async function splitFindingsToFiles(
  logs: { label: string; content: string }[],
  dir: string,
): Promise<FindingRecord[]> {
  await fs.mkdir(dir, { recursive: true });
  const recs: FindingRecord[] = [];
  let n = 0;
  for (const log of logs) {
    for (const f of parseFindingBlocks(log.content)) {
      n++;
      const id = `FINDING-${String(n).padStart(3, '0')}`;
      const header =
        `# ${id}\n\n_Reported by ${log.label}` + `${f.relatedTask ? ` · related task ${f.relatedTask}` : ''}._\n\n`;
      await fs.writeFile(path.join(dir, findingFileName(id, 'open')), header + f.body + '\n', 'utf8');
      recs.push({ id, status: 'open', title: f.title, relatedTask: f.relatedTask });
    }
  }
  return recs;
}

async function findFindingFile(dir: string, id: string): Promise<string | null> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.find((x) => parseFindingFileName(x)?.id === id) ?? null;
}

export async function hasFindings(dir: string): Promise<boolean> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.some((x) => FINDING_FILE_RE.test(x));
}

export async function listFindings(dir: string): Promise<FindingRecord[]> {
  const names = (await fs.readdir(dir).catch(() => [] as string[])).sort();
  const out: FindingRecord[] = [];
  for (const name of names) {
    const p = parseFindingFileName(name);
    if (!p) continue;
    const content = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '');
    const rel = /related task (TASK-[A-Za-z0-9_-]+)/i.exec(content);
    const titleM = /^#{1,2}\s+(FINDING[^\n]*)/im.exec(content);
    out.push({ id: p.id, status: p.status, title: (titleM?.[1] ?? p.id).trim(), relatedTask: rel?.[1] });
  }
  return out;
}

export function summarizeFindings(recs: FindingRecord[]): FindingsSummary {
  const s: FindingsSummary = { total: recs.length, open: 0, fixing: 0, fixed: 0, wontfix: 0 };
  for (const r of recs) s[r.status]++;
  return s;
}

/** Read a finding's full block (for the fix agent's prompt). */
export async function readFindingBlock(dir: string, id: string): Promise<string> {
  const name = await findFindingFile(dir, id);
  if (!name) return `(finding ${id})`;
  return (await fs.readFile(path.join(dir, name), 'utf8').catch(() => '')).trim() || `(finding ${id})`;
}

export interface ReclaimStaleFindingsOptions {
  ttlMs: number;
  locksDir?: string;
  nowMs?: number;
}

/** Reset abandoned fixing findings so the atomic rename queue can claim them again. */
export async function reclaimStaleFindings(dir: string, opts: ReclaimStaleFindingsOptions): Promise<FindingRecord[]> {
  const names = (await fs.readdir(dir).catch(() => [] as string[])).sort();
  const reclaimed: FindingRecord[] = [];
  for (const name of names) {
    const p = parseFindingFileName(name);
    if (!p || p.status !== 'fixing') continue;
    const file = path.join(dir, name);
    const lockFile = opts.locksDir ? queueLockFile(opts.locksDir, p.id) : null;
    if (!(await shouldReclaimClaimFile(file, lockFile, opts.ttlMs, opts.nowMs))) continue;

    const to = path.join(dir, findingFileName(p.id, 'open'));
    try {
      await fs.rename(file, to);
    } catch {
      continue;
    }
    if (lockFile) await releaseLock(lockFile);
    const content = await fs.readFile(to, 'utf8').catch(() => '');
    const rel = /related task (TASK-[A-Za-z0-9_-]+)/i.exec(content);
    const titleM = /^#{1,2}\s+(FINDING[^\n]*)/im.exec(content);
    reclaimed.push({ id: p.id, status: 'open', title: (titleM?.[1] ?? p.id).trim(), relatedTask: rel?.[1] });
  }
  return reclaimed;
}

export interface ClaimFindingLockOptions {
  locksDir: string;
  agentId: string;
  agentType: string;
  ttlMs: number;
  nowMs?: number;
}

/** Atomically claim the next open finding (rename open -> fixing). Returns null when none remain. */
export async function claimNextFinding(
  dir: string,
  lock?: ClaimFindingLockOptions,
): Promise<{ id: string; block: string } | null> {
  const names = (await fs.readdir(dir).catch(() => [] as string[])).sort();
  for (const name of names) {
    const p = parseFindingFileName(name);
    if (!p || p.status !== 'open') continue;
    const from = path.join(dir, name);
    const to = path.join(dir, findingFileName(p.id, 'fixing'));
    const lockOpts = lock;
    const lockFile = lockOpts ? queueLockFile(lockOpts.locksDir, p.id) : null;
    if (lockOpts && lockFile) {
      const locked = await acquireLock(
        lockFile,
        { taskId: p.id, agentId: lockOpts.agentId, agentType: lockOpts.agentType },
        { ttlMs: lockOpts.ttlMs, nowMs: lockOpts.nowMs },
      );
      if (!locked) continue;
    }
    try {
      await fs.rename(from, to);
    } catch {
      if (lockFile) await releaseLock(lockFile);
      continue; // claimed by someone else
    }
    const content = await fs.readFile(to, 'utf8').catch(() => '');
    return { id: p.id, block: content.trim() };
  }
  return null;
}

/** Resolve a finding by renaming it to its final status. */
export async function finishFinding(dir: string, id: string, status: FindingStatus): Promise<void> {
  const name = await findFindingFile(dir, id);
  if (!name) return;
  const to = findingFileName(id, status);
  if (name === to) return;
  await fs.rename(path.join(dir, name), path.join(dir, to)).catch(() => {});
}

/**
 * Parse a fix agent's self-reported result: `FIX_RESULT: fixed|wontfix: reason`.
 *
 * Like {@link parseExecutionResult}, the contract requires the marker as the FINAL line, so we
 * anchor to the start of a line (tolerating leading list/quote markers) and take the LAST match.
 * Anchoring prevents the prompt's own `FIX_RESULT: …` instruction text — when echoed mid-line — from
 * being misread as a genuine self-report.
 */
export function parseFixResult(text: string): { status: 'fixed' | 'wontfix'; reason?: string } | null {
  const re = /^[ \t>*-]*FIX_RESULT\s*:\s*(fixed|wontfix)\s*(?::\s*(.*))?$/gim;
  let m: RegExpExecArray | null;
  let last: { status: 'fixed' | 'wontfix'; reason?: string } | null = null;
  while ((m = re.exec(text))) {
    last = { status: m[1]!.toLowerCase() as 'fixed' | 'wontfix', reason: m[2]?.trim() || undefined };
  }
  return last;
}

/**
 * Parse a FIND-phase review agent's sentinel self-report: `REVIEW_RESULT: clean|findings`.
 *
 * The orchestrator uses presence of this sentinel as the completion gate for the FIND phase: a
 * review that crashes, times out, or emits malformed output never writes it, so its partition must
 * be treated as needs-attention rather than auto-approved. Anchored to line start and last-match
 * (same contract as the other self-reports) so the prompt's own echoed instruction is not misread.
 */
export function parseReviewResult(text: string): { status: 'clean' | 'findings' } | null {
  const re = /^[ \t>*-]*REVIEW_RESULT\s*:\s*(clean|findings)\b.*$/gim;
  let m: RegExpExecArray | null;
  let last: { status: 'clean' | 'findings' } | null = null;
  while ((m = re.exec(text))) {
    last = { status: m[1]!.toLowerCase() as 'clean' | 'findings' };
  }
  return last;
}
