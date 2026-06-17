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
