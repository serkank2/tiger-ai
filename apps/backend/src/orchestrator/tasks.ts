import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  EXECUTION_STATUSES,
  REVIEW_STATUSES,
  type ExecutionStatus,
  type ReviewStatus,
  type TaskRecord,
  type TaskSummary,
} from './types.js';

const TASK_HEADER = /^##\s+(TASK-[A-Za-z0-9_-]+)\s*:?\s*(.*)$/;
const ANY_HEADING = /^#{2,3}\s+/;

function isHeadingLine(line: string, level: 2 | 3, field?: string): boolean {
  const re = level === 2 ? /^##\s+/ : /^###\s+/;
  if (!re.test(line)) return false;
  if (!field) return true;
  const name = line.replace(re, '').replace(/:\s*$/, '').trim().toLowerCase();
  return name === field.toLowerCase();
}

/** Read the value lines under a `### Field` heading within a task block (joined, trimmed). */
function getField(blockLines: string[], field: string): string {
  const head = blockLines.findIndex((l) => isHeadingLine(l, 3, field));
  if (head === -1) return '';
  const out: string[] = [];
  for (let i = head + 1; i < blockLines.length; i++) {
    const line = blockLines[i]!;
    if (ANY_HEADING.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

function firstLine(s: string): string {
  const line = s.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return line ?? '';
}

function toExecutionStatus(v: string): ExecutionStatus {
  const x = firstLine(v).toLowerCase();
  return (EXECUTION_STATUSES as string[]).includes(x) ? (x as ExecutionStatus) : 'not_started';
}
function toReviewStatus(v: string): ReviewStatus {
  const x = firstLine(v).toLowerCase();
  return (REVIEW_STATUSES as string[]).includes(x) ? (x as ReviewStatus) : 'pending';
}

/** Parse the merged tasks.md file into structured task records (with block offsets). */
export function parseTasks(content: string): TaskRecord[] {
  const lines = content.split('\n');
  // Locate task header line indices.
  const headers: { line: number; id: string; title: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TASK_HEADER.exec(lines[i]!);
    if (m) headers.push({ line: i, id: m[1]!, title: (m[2] ?? '').trim() });
  }

  // Char offset of the start of each line, for block start/end positions.
  const lineOffsets: number[] = [];
  let off = 0;
  for (const l of lines) {
    lineOffsets.push(off);
    off += l.length + 1; // +1 for the split '\n'
  }

  const records: TaskRecord[] = [];
  for (let h = 0; h < headers.length; h++) {
    const startLine = headers[h]!.line;
    const endLine = h + 1 < headers.length ? headers[h + 1]!.line : lines.length;
    const blockLines = lines.slice(startLine, endLine);
    const start = lineOffsets[startLine]!;
    const end = endLine < lines.length ? lineOffsets[endLine]! : content.length;
    records.push({
      id: headers[h]!.id,
      title: headers[h]!.title,
      executionStatus: toExecutionStatus(getField(blockLines, 'Execution Status')),
      assignedAgent: firstLine(getField(blockLines, 'Assigned Agent')) || '-',
      startedAt: firstLine(getField(blockLines, 'Started At')) || '-',
      completedAt: firstLine(getField(blockLines, 'Completed At')) || '-',
      reviewStatus: toReviewStatus(getField(blockLines, 'Review Status')),
      reviewNotes: getField(blockLines, 'Review Notes') || '-',
      start,
      end,
    });
  }
  return records;
}

export interface TaskFieldUpdate {
  executionStatus?: ExecutionStatus;
  assignedAgent?: string;
  startedAt?: string;
  completedAt?: string;
  reviewStatus?: ReviewStatus;
  reviewNotes?: string;
}

const FIELD_HEADINGS: Record<keyof TaskFieldUpdate, string> = {
  executionStatus: 'Execution Status',
  assignedAgent: 'Assigned Agent',
  startedAt: 'Started At',
  completedAt: 'Completed At',
  reviewStatus: 'Review Status',
  reviewNotes: 'Review Notes',
};

/** Replace (or append) one `### Field` value within a block's lines. */
function setFieldLines(blockLines: string[], field: string, value: string): string[] {
  const head = blockLines.findIndex((l) => isHeadingLine(l, 3, field));
  if (head === -1) {
    // Field missing — append it at the end of the block.
    const trimmed = [...blockLines];
    while (trimmed.length && trimmed[trimmed.length - 1]!.trim() === '') trimmed.pop();
    trimmed.push('', `### ${field}`, value, '');
    return trimmed;
  }
  // Find the end of the value region (next heading or end of block).
  let valEnd = head + 1;
  while (valEnd < blockLines.length && !ANY_HEADING.test(blockLines[valEnd]!)) valEnd++;
  const hasFollowing = valEnd < blockLines.length;
  const replacement = hasFollowing ? [value, ''] : [value];
  return [...blockLines.slice(0, head + 1), ...replacement, ...blockLines.slice(valEnd)];
}

/**
 * Surgically update the status fields of one task in the tasks.md content, preserving
 * the agent-authored Description / Acceptance Criteria / Dependencies untouched.
 * Returns the new content (unchanged if the task id is not found).
 */
export function updateTaskFields(content: string, taskId: string, update: TaskFieldUpdate): string {
  const lines = content.split('\n');
  const headerIdx = lines.findIndex((l) => {
    const m = TASK_HEADER.exec(l);
    return !!m && m[1] === taskId;
  });
  if (headerIdx === -1) return content;
  let endIdx = headerIdx + 1;
  while (endIdx < lines.length && !TASK_HEADER.test(lines[endIdx]!)) endIdx++;

  let blockLines = lines.slice(headerIdx, endIdx);
  for (const key of Object.keys(update) as (keyof TaskFieldUpdate)[]) {
    const value = update[key];
    if (value === undefined) continue;
    blockLines = setFieldLines(blockLines, FIELD_HEADINGS[key], String(value));
  }
  return [...lines.slice(0, headerIdx), ...blockLines, ...lines.slice(endIdx)].join('\n');
}

/** Aggregate counts + a compact item list for the UI. */
export function summarizeTasks(records: TaskRecord[]): TaskSummary {
  const byExecution: Record<ExecutionStatus, number> = {
    not_started: 0,
    in_progress: 0,
    done: 0,
    blocked: 0,
  };
  const byReview: Record<ReviewStatus, number> = {
    pending: 0,
    reviewing: 0,
    approved: 0,
    needs_fix: 0,
    fixed: 0,
  };
  for (const r of records) {
    byExecution[r.executionStatus]++;
    byReview[r.reviewStatus]++;
  }
  return {
    total: records.length,
    byExecution,
    byReview,
    items: records.map((r) => ({
      id: r.id,
      title: r.title,
      executionStatus: r.executionStatus,
      reviewStatus: r.reviewStatus,
      assignedAgent: r.assignedAgent,
    })),
  };
}

// ---------------------------------------------------------------------------
// Atomic task locking (executing-plan/locks/<TASK>.lock). Exclusive create ('wx')
// guarantees only one claimer wins, and leaves the documented lock artifact on disk.
// ---------------------------------------------------------------------------

export interface LockInfo {
  taskId: string;
  agentId: string;
  agentType: string;
  pid?: number;
}

export interface AcquireLockOptions {
  /** If a lock is held but stale (owner PID dead or older than this), reclaim it. 0 disables TTL. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  nowMs?: number;
}

function lockBody(info: LockInfo): string {
  return [
    `Task ID: ${info.taskId}`,
    `Agent ID: ${info.agentId}`,
    `Agent Type: ${info.agentType}`,
    `Created: ${new Date().toISOString()}`,
    `Process ID: ${info.pid ?? process.pid}`,
    '',
  ].join('\n');
}

function parseLockMeta(body: string): { pid?: number; createdMs?: number } {
  const pidM = /Process ID:\s*(\d+)/.exec(body);
  const createdM = /Created:\s*(.+)/.exec(body);
  const pid = pidM && pidM[1] ? Number(pidM[1]) : undefined;
  const createdMs = createdM && createdM[1] ? Date.parse(createdM[1].trim()) : NaN;
  return { pid, createdMs: Number.isNaN(createdMs) ? undefined : createdMs };
}

/** Is a PID currently alive? (signal 0 probes existence; EPERM means it exists but is not ours.) */
function pidAlive(pid?: number): boolean {
  if (pid === undefined || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** A lock is stale if it is gone, its owner process is dead, or it exceeds the TTL. */
export async function isLockStale(lockFile: string, ttlMs: number, nowMs = Date.now()): Promise<boolean> {
  const body = await fs.readFile(lockFile, 'utf8').catch(() => null);
  if (body == null) return true; // already gone — effectively free
  const { pid, createdMs } = parseLockMeta(body);
  if (pid !== undefined && !pidAlive(pid)) return true; // crashed owner
  if (ttlMs > 0 && createdMs !== undefined && nowMs - createdMs > ttlMs) return true; // expired
  return false;
}

/**
 * Try to claim a task lock via atomic exclusive create. Returns true if acquired, false if held
 * by a live owner. A stale lock (dead owner PID or older than ttlMs) is reclaimed and re-acquired.
 */
export async function acquireLock(
  lockFile: string,
  info: LockInfo,
  opts: AcquireLockOptions = {},
): Promise<boolean> {
  await fs.mkdir(path.dirname(lockFile), { recursive: true });

  const tryCreate = async (): Promise<import('node:fs/promises').FileHandle | null> => {
    try {
      return await fs.open(lockFile, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return null;
      throw err;
    }
  };

  let fh = await tryCreate();
  if (!fh) {
    const ttl = opts.ttlMs ?? 0;
    if (await isLockStale(lockFile, ttl, opts.nowMs)) {
      await fs.unlink(lockFile).catch(() => {}); // reclaim
      fh = await tryCreate();
    }
    if (!fh) return false; // held by a live owner
  }
  try {
    await fh.writeFile(lockBody(info), 'utf8');
  } finally {
    await fh.close();
  }
  return true;
}

/** Release a task lock (best-effort; missing lock / double-release is fine). */
export async function releaseLock(lockFile: string): Promise<void> {
  await fs.unlink(lockFile).catch(() => {});
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

async function shouldReclaimClaimFile(file: string, lockFile: string | null, ttlMs: number, nowMs = Date.now()): Promise<boolean> {
  if (lockFile && (await pathExists(lockFile))) return isLockStale(lockFile, ttlMs, nowMs);
  return isFileOlderThan(file, ttlMs, nowMs);
}

// ---------------------------------------------------------------------------
// Per-task files: each task is its own file `<TASK-ID>__<execStatus>.md` under merged-tasks/tasks/.
// The execution status lives in the FILENAME (so it's visible at a glance and claimable by an atomic
// rename), while review status + the task spec live in the file content. This lets the executor
// claim/track one task without loading the whole list.
// ---------------------------------------------------------------------------

const TASK_FILE_RE = /^(TASK-[A-Za-z0-9_-]+)__(not_started|in_progress|done|blocked)\.md$/;

export function taskFileName(id: string, status: ExecutionStatus): string {
  return `${id}__${status}.md`;
}
export function parseTaskFileName(name: string): { id: string; status: ExecutionStatus } | null {
  const m = TASK_FILE_RE.exec(name);
  return m ? { id: m[1]!, status: m[2]! as ExecutionStatus } : null;
}

function recordFromFile(id: string, status: ExecutionStatus, content: string): TaskRecord {
  const b = parseTasks(content)[0];
  return {
    id,
    title: b?.title ?? id,
    executionStatus: status,
    assignedAgent: b?.assignedAgent ?? '-',
    startedAt: b?.startedAt ?? '-',
    completedAt: b?.completedAt ?? '-',
    reviewStatus: b?.reviewStatus ?? 'pending',
    reviewNotes: b?.reviewNotes ?? '-',
    start: 0,
    end: content.length,
  };
}

/** True if the per-task directory already holds at least one task file. */
export async function hasTaskFiles(dir: string): Promise<boolean> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.some((n) => TASK_FILE_RE.test(n));
}

/** List all per-task records (execution status from filename, the rest from content). */
export async function listTaskRecords(dir: string): Promise<TaskRecord[]> {
  const names = (await fs.readdir(dir).catch(() => [] as string[])).sort();
  const out: TaskRecord[] = [];
  for (const name of names) {
    const p = parseTaskFileName(name);
    if (!p) continue;
    const content = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '');
    out.push(recordFromFile(p.id, p.status, content));
  }
  return out;
}

/** Split a merged tasks.md into per-task files (idempotent — never clobbers an existing task file). */
export async function splitTasksToFiles(content: string, dir: string): Promise<number> {
  await fs.mkdir(dir, { recursive: true });
  const existing = await fs.readdir(dir).catch(() => [] as string[]);
  const haveIds = new Set(existing.map((n) => parseTaskFileName(n)?.id).filter(Boolean));
  let written = 0;
  for (const r of parseTasks(content)) {
    if (haveIds.has(r.id)) continue;
    const block = content.slice(r.start, r.end).trim() + '\n';
    await fs.writeFile(path.join(dir, taskFileName(r.id, r.executionStatus)), block, 'utf8');
    written++;
  }
  return written;
}

/** Find the file currently representing a task id (any status). */
async function findTaskFile(dir: string, id: string): Promise<string | null> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.find((n) => parseTaskFileName(n)?.id === id) ?? null;
}

/** Read a task's full block content (for composing the agent prompt). */
export async function readTaskBlock(dir: string, id: string): Promise<string> {
  const name = await findTaskFile(dir, id);
  if (!name) return `(task ${id})`;
  return (await fs.readFile(path.join(dir, name), 'utf8').catch(() => '')).trim() || `(task ${id})`;
}

/** Read-modify-write a task file's content fields (by id). */
async function patchTaskFileContent(dir: string, id: string, fields: TaskFieldUpdate): Promise<void> {
  const name = await findTaskFile(dir, id);
  if (!name) return;
  const fp = path.join(dir, name);
  const content = await fs.readFile(fp, 'utf8').catch(() => null);
  if (content == null) return;
  await fs.writeFile(fp, updateTaskFields(content, id, fields), 'utf8');
}

/** Rename a task file to a new execution status (the atomic status transition). */
export async function setTaskFileStatus(dir: string, id: string, status: ExecutionStatus): Promise<void> {
  const name = await findTaskFile(dir, id);
  if (!name) return;
  const to = taskFileName(id, status);
  if (name === to) return;
  await fs.rename(path.join(dir, name), path.join(dir, to)).catch(() => {});
}

export interface ReclaimStaleTaskClaimsOptions {
  ttlMs: number;
  locksDir?: string;
  nowMs?: number;
}

/**
 * Reset abandoned in_progress task files so the atomic rename queue can claim them again.
 * A claim is abandoned when its lock is stale (dead owner or TTL) or, for legacy claims that
 * predate lock files, when the in_progress file itself is older than the TTL.
 */
export async function reclaimStaleTaskClaims(
  dir: string,
  opts: ReclaimStaleTaskClaimsOptions,
): Promise<TaskRecord[]> {
  const names = (await fs.readdir(dir).catch(() => [] as string[])).sort();
  const reclaimed: TaskRecord[] = [];
  for (const name of names) {
    const p = parseTaskFileName(name);
    if (!p || p.status !== 'in_progress') continue;
    const file = path.join(dir, name);
    const lockFile = opts.locksDir ? queueLockFile(opts.locksDir, p.id) : null;
    if (!(await shouldReclaimClaimFile(file, lockFile, opts.ttlMs, opts.nowMs))) continue;

    const to = path.join(dir, taskFileName(p.id, 'not_started'));
    try {
      await fs.rename(file, to);
    } catch {
      continue;
    }
    await patchTaskFileContent(dir, p.id, {
      executionStatus: 'not_started',
      assignedAgent: '-',
      startedAt: '-',
      completedAt: '-',
    });
    if (lockFile) await releaseLock(lockFile);
    const content = await fs.readFile(to, 'utf8').catch(() => '');
    reclaimed.push(recordFromFile(p.id, 'not_started', content));
  }
  return reclaimed;
}

export interface ClaimTaskLockOptions {
  locksDir: string;
  agentType: string;
  ttlMs: number;
  nowMs?: number;
}

/**
 * Atomically claim the next not_started task: rename it to in_progress (the rename is the lock — if
 * another claimer won, the rename fails and we try the next). Records the assignee + start time in
 * the file content. Returns the claimed task record + its block, or null when none remain.
 */
export async function claimNextTaskFile(
  dir: string,
  agentLabel: string,
  nowIso: string,
  lock?: ClaimTaskLockOptions,
): Promise<{ record: TaskRecord; block: string } | null> {
  const names = (await fs.readdir(dir).catch(() => [] as string[])).sort();
  for (const name of names) {
    const p = parseTaskFileName(name);
    if (!p || p.status !== 'not_started') continue;
    const from = path.join(dir, name);
    const to = path.join(dir, taskFileName(p.id, 'in_progress'));
    const lockOpts = lock;
    const lockFile = lockOpts ? queueLockFile(lockOpts.locksDir, p.id) : null;
    if (lockOpts && lockFile) {
      const locked = await acquireLock(
        lockFile,
        { taskId: p.id, agentId: agentLabel, agentType: lockOpts.agentType },
        { ttlMs: lockOpts.ttlMs, nowMs: lockOpts.nowMs },
      );
      if (!locked) continue;
    }
    try {
      await fs.rename(from, to);
    } catch {
      if (lockFile) await releaseLock(lockFile);
      continue; // already claimed by someone else
    }
    await patchTaskFileContent(dir, p.id, { executionStatus: 'in_progress', assignedAgent: agentLabel, startedAt: nowIso });
    const content = await fs.readFile(to, 'utf8').catch(() => '');
    return { record: recordFromFile(p.id, 'in_progress', content), block: content.trim() };
  }
  return null;
}

/** Finalize a task: rename to done/blocked and stamp the completion time in the content. */
export async function finishTaskFile(
  dir: string,
  id: string,
  status: ExecutionStatus,
  nowIso: string,
): Promise<void> {
  await setTaskFileStatus(dir, id, status);
  await patchTaskFileContent(dir, id, { executionStatus: status, completedAt: nowIso });
}

/** Update a task's review status in its file content. */
export async function reviewTaskFile(dir: string, id: string, reviewStatus: ReviewStatus): Promise<void> {
  await patchTaskFileContent(dir, id, { reviewStatus });
}

/** Parse an agent's self-reported execution result (`EXECUTION_RESULT: done|blocked: reason`). */
export function parseExecutionResult(text: string): { status: 'done' | 'blocked'; reason: string } | null {
  const re = /EXECUTION_RESULT\s*:\s*(done|blocked)\b[ \t]*[:-]?[ \t]*(.*)/gi;
  let m: RegExpExecArray | null;
  let last: { status: 'done' | 'blocked'; reason: string } | null = null;
  while ((m = re.exec(text))) {
    last = { status: m[1]!.toLowerCase() as 'done' | 'blocked', reason: (m[2] ?? '').trim() };
  }
  return last;
}
