import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { StageId } from '../orchestrator/types.js';
import { query, withTransaction } from '../db/pool.js';
import type {
  QueueEvent,
  QueueJob,
  QueueJobConfigSnapshot,
  QueueJobPatch,
  QueueLimitSnapshot,
  QueueProvider,
  QueueRepository,
  QueueRepositoryTx,
  QueueRule,
  QueueRuleProvider,
  QueueStep,
  QueueStepPatch,
  QueueTargetPayload,
  QueueTargetType,
} from './types.js';

type JsonValue = Record<string, unknown> | null;

interface QueueJobRow extends RowDataPacket {
  id: string;
  position: number;
  status: QueueJob['status'];
  priority: number;
  provider: QueueProvider;
  workspace_path: string;
  project_name: string | null;
  prompt: string;
  config_snapshot: string | QueueJobConfigSnapshot | null;
  target_type: QueueTargetType | null;
  target_payload: string | QueueTargetPayload | null;
  target_ref: string | Record<string, unknown> | null;
  title: string | null;
  body: string | null;
  failure_kind: string | null;
  history_archived_at: Date | string | null;
  attempts: number;
  max_attempts: number;
  blocked_reason: string | null;
  resume_after: Date | string | null;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  current_step: StageId | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface QueueStepRow extends RowDataPacket {
  id: string;
  job_id: string;
  step_key: StageId;
  position: number;
  status: QueueStep['status'];
  attempts: number;
  error: string | null;
  checkpoint: string | Record<string, unknown> | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface QueueEventRow extends RowDataPacket {
  id: string;
  job_id: string | null;
  type: string;
  message: string;
  payload: string | Record<string, unknown> | null;
  created_at: Date | string;
}

interface QueueRuleRow extends RowDataPacket {
  id: string;
  name: string;
  enabled: number | boolean;
  provider: QueueRuleProvider;
  window_key: string;
  metric: 'percent_used';
  operator: QueueRule['operator'];
  threshold: string | number;
  action: QueueRule['action'];
  config: string | JsonValue;
  created_at: Date | string;
  updated_at: Date | string;
}

interface LimitSnapshotRow extends RowDataPacket {
  provider: Exclude<QueueProvider, 'mixed'>;
  window_key?: string | null;
  percent_used?: number | string | null;
  usage_percent?: number | string | null;
  reset_at?: Date | string | null;
  checked_at?: Date | string | null;
  created_at?: Date | string | null;
}

const MYSQL_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)$/;

function parseDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  const trimmed = value.trim();
  const mysqlDateTime = MYSQL_DATETIME_RE.exec(trimmed);
  if (mysqlDateTime) return new Date(`${mysqlDateTime[1]}T${mysqlDateTime[2]}Z`);
  return new Date(trimmed);
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return parseDate(value).toISOString();
}

function json<T>(value: string | T | null | undefined, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function jsonParam(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function mysqlDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

function mapJob(row: QueueJobRow): QueueJob {
  return {
    id: row.id,
    position: row.position,
    status: row.status,
    priority: row.priority,
    provider: row.provider,
    workspacePath: row.workspace_path,
    projectName: row.project_name,
    prompt: row.prompt,
    configSnapshot: json<QueueJobConfigSnapshot>(row.config_snapshot, {}),
    targetType: row.target_type,
    targetPayload: json<QueueTargetPayload | null>(row.target_payload, null),
    targetRef: json<Record<string, unknown> | null>(row.target_ref, null),
    title: row.title,
    body: row.body,
    failureKind: row.failure_kind,
    historyArchivedAt: iso(row.history_archived_at),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    blockedReason: row.blocked_reason,
    resumeAfter: iso(row.resume_after),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: iso(row.lease_expires_at),
    currentStep: row.current_step,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function mapStep(row: QueueStepRow): QueueStep {
  return {
    id: row.id,
    jobId: row.job_id,
    stepKey: row.step_key,
    position: row.position,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    checkpoint: json<Record<string, unknown> | null>(row.checkpoint, null),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function mapEvent(row: QueueEventRow): QueueEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    type: row.type,
    message: row.message,
    payload: json<Record<string, unknown> | null>(row.payload, null),
    createdAt: iso(row.created_at)!,
  };
}

function mapRule(row: QueueRuleRow): QueueRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === true || row.enabled === 1,
    provider: row.provider,
    windowKey: row.window_key,
    metric: row.metric,
    operator: row.operator,
    threshold: Number(row.threshold),
    action: row.action,
    config: json<Record<string, unknown> | null>(row.config, null),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function isMissingLimitTable(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR';
}

type Queryable = PoolConnection | null;

class MysqlQueueRepositoryTx implements QueueRepositoryTx {
  constructor(private readonly conn: Queryable) {}

  async nextPosition(): Promise<number> {
    const rows = await this.select<RowDataPacket[]>('SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM queue_jobs');
    return Number((rows[0] as { next_position?: unknown } | undefined)?.next_position ?? 1);
  }

  async insertJob(job: QueueJob): Promise<void> {
    await this.execute(
      `INSERT INTO queue_jobs (
        id, position, status, priority, provider, workspace_path, project_name, prompt, config_snapshot,
        target_type, target_payload, target_ref, title, body, failure_kind, history_archived_at,
        attempts, max_attempts, blocked_reason, resume_after, lease_owner, lease_expires_at, current_step,
        started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        job.id,
        job.position,
        job.status,
        job.priority,
        job.provider,
        job.workspacePath,
        job.projectName,
        job.prompt,
        jsonParam(job.configSnapshot),
        job.targetType ?? null,
        jsonParam(job.targetPayload),
        jsonParam(job.targetRef),
        job.title ?? null,
        job.body ?? null,
        job.failureKind ?? null,
        mysqlDate(job.historyArchivedAt),
        job.attempts,
        job.maxAttempts,
        job.blockedReason,
        mysqlDate(job.resumeAfter),
        job.leaseOwner,
        mysqlDate(job.leaseExpiresAt),
        job.currentStep,
        mysqlDate(job.startedAt),
        mysqlDate(job.completedAt),
        mysqlDate(job.createdAt),
        mysqlDate(job.updatedAt),
      ],
    );
  }

  async insertStep(step: QueueStep): Promise<void> {
    await this.execute(
      `INSERT INTO queue_steps (
        id, job_id, step_key, position, status, attempts, error, checkpoint, started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        step.id,
        step.jobId,
        step.stepKey,
        step.position,
        step.status,
        step.attempts,
        step.error,
        jsonParam(step.checkpoint),
        mysqlDate(step.startedAt),
        mysqlDate(step.completedAt),
        mysqlDate(step.createdAt),
        mysqlDate(step.updatedAt),
      ],
    );
  }

  async insertEvent(event: QueueEvent): Promise<void> {
    await this.execute(
      'INSERT INTO queue_events (id, job_id, type, message, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [event.id, event.jobId, event.type, event.message, jsonParam(event.payload), mysqlDate(event.createdAt)],
    );
    if (event.type.startsWith('prompt.')) {
      await this.insertPromptHistoryEvent(event);
    }
  }

  async getJob(id: string): Promise<QueueJob | null> {
    const rows = await this.select<QueueJobRow[]>('SELECT * FROM queue_jobs WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async listJobs(): Promise<QueueJob[]> {
    const rows = await this.select<QueueJobRow[]>('SELECT * FROM queue_jobs ORDER BY position ASC, created_at ASC');
    return rows.map(mapJob);
  }

  /**
   * Lock and return dispatchable jobs (status queued/retrying, past any resume_after,
   * with no live lease) ordered for dispatch. Uses `FOR UPDATE SKIP LOCKED` so two
   * schedulers running concurrently never lease the same row: the second scheduler
   * skips any candidate the first has already locked inside its own transaction.
   *
   * Must be called inside `transaction()`; outside a transaction the row locks are
   * released immediately and offer no protection.
   */
  async lockDispatchableJobs(now: string): Promise<QueueJob[]> {
    const mysqlNow = mysqlDate(now);
    const rows = await this.select<QueueJobRow[]>(
      `SELECT * FROM queue_jobs
         WHERE status IN ('queued', 'retrying')
           AND (resume_after IS NULL OR resume_after <= ?)
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         ORDER BY priority DESC, position ASC, created_at ASC
         FOR UPDATE SKIP LOCKED`,
      [mysqlNow, mysqlNow],
    );
    return rows.map(mapJob);
  }

  /**
   * Lock running jobs whose lease has expired (or whose owner matches `owner`, used on
   * startup recovery). Verifying lease_expires_at < now before reclaiming ensures a
   * scheduler that is still actively refreshing its lease cannot have its job stolen.
   * Returns the locked rows so the caller can reset them inside the same transaction.
   */
  async lockReclaimableJobs(now: string, owner: string): Promise<QueueJob[]> {
    const mysqlNow = mysqlDate(now);
    const rows = await this.select<QueueJobRow[]>(
      `SELECT * FROM queue_jobs
         WHERE status = 'running'
           AND (lease_owner = ? OR lease_expires_at IS NULL OR lease_expires_at <= ?)
         ORDER BY position ASC, created_at ASC
         FOR UPDATE SKIP LOCKED`,
      [owner, mysqlNow],
    );
    return rows.map(mapJob);
  }

  async listSteps(jobId: string): Promise<QueueStep[]> {
    const rows = await this.select<QueueStepRow[]>('SELECT * FROM queue_steps WHERE job_id = ? ORDER BY position ASC', [jobId]);
    return rows.map(mapStep);
  }

  async listStepsForJobs(jobIds: string[]): Promise<QueueStep[]> {
    if (jobIds.length === 0) return [];
    const placeholders = jobIds.map(() => '?').join(', ');
    const rows = await this.select<QueueStepRow[]>(
      `SELECT * FROM queue_steps WHERE job_id IN (${placeholders}) ORDER BY job_id ASC, position ASC`,
      jobIds,
    );
    return rows.map(mapStep);
  }

  async listEvents(limit = 120): Promise<QueueEvent[]> {
    const requested = Number.isFinite(limit) ? Math.trunc(limit) : 120;
    const bounded = Math.max(1, Math.min(500, requested));
    const rows = await this.select<QueueEventRow[]>('SELECT * FROM queue_events ORDER BY created_at DESC, id DESC LIMIT ?', [bounded]);
    return rows.map(mapEvent);
  }

  async listRules(): Promise<QueueRule[]> {
    const rows = await this.select<QueueRuleRow[]>('SELECT * FROM queue_rules ORDER BY created_at ASC');
    return rows.map(mapRule);
  }

  async getLatestLimitSnapshot(provider: Exclude<QueueProvider, 'mixed'>): Promise<QueueLimitSnapshot | null> {
    const primary = `
      SELECT provider, window_key, percent_used, reset_at, checked_at, created_at
      FROM limit_snapshots
      WHERE provider = ? AND percent_used IS NOT NULL
      ORDER BY checked_at DESC, created_at DESC
      LIMIT 1
    `;
    const fallback = `
      SELECT provider, window_key, usage_percent, reset_at, checked_at, created_at
      FROM limit_snapshots
      WHERE provider = ? AND usage_percent IS NOT NULL
      ORDER BY checked_at DESC, created_at DESC
      LIMIT 1
    `;
    try {
      const rows = await this.select<LimitSnapshotRow[]>(primary, [provider]);
      return rows[0] ? mapLimitSnapshot(rows[0]) : null;
    } catch (err) {
      if (!isMissingLimitTable(err)) throw err;
    }
    try {
      const rows = await this.select<LimitSnapshotRow[]>(fallback, [provider]);
      return rows[0] ? mapLimitSnapshot(rows[0]) : null;
    } catch (err) {
      if (!isMissingLimitTable(err)) throw err;
      return null;
    }
  }

  async getLatestLimitSnapshotsByWindow(provider: Exclude<QueueProvider, 'mixed'>): Promise<QueueLimitSnapshot[]> {
    // Latest snapshot per window_key for the provider. Pull recent rows ordered newest-first and
    // keep the first row seen per window in JS — robust across MySQL versions without depending on
    // window functions, and the per-window winner is whichever was checked most recently.
    const primary = `
      SELECT provider, window_key, percent_used, reset_at, checked_at, created_at
      FROM limit_snapshots
      WHERE provider = ? AND percent_used IS NOT NULL
      ORDER BY checked_at DESC, created_at DESC
    `;
    const fallback = `
      SELECT provider, window_key, usage_percent, reset_at, checked_at, created_at
      FROM limit_snapshots
      WHERE provider = ? AND usage_percent IS NOT NULL
      ORDER BY checked_at DESC, created_at DESC
    `;
    const pickLatestPerWindow = (rows: LimitSnapshotRow[]): QueueLimitSnapshot[] => {
      const seen = new Set<string>();
      const out: QueueLimitSnapshot[] = [];
      for (const row of rows) {
        const snapshot = mapLimitSnapshot(row);
        if (seen.has(snapshot.windowKey)) continue;
        seen.add(snapshot.windowKey);
        out.push(snapshot);
      }
      return out;
    };
    try {
      const rows = await this.select<LimitSnapshotRow[]>(primary, [provider]);
      return pickLatestPerWindow(rows);
    } catch (err) {
      if (!isMissingLimitTable(err)) throw err;
    }
    try {
      const rows = await this.select<LimitSnapshotRow[]>(fallback, [provider]);
      return pickLatestPerWindow(rows);
    } catch (err) {
      if (!isMissingLimitTable(err)) throw err;
      return [];
    }
  }

  async updateJob(id: string, patch: QueueJobPatch): Promise<void> {
    const pairs: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      pairs.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.position !== undefined) add('position', patch.position);
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.priority !== undefined) add('priority', patch.priority);
    if (patch.provider !== undefined) add('provider', patch.provider);
    if (patch.workspacePath !== undefined) add('workspace_path', patch.workspacePath);
    if (patch.projectName !== undefined) add('project_name', patch.projectName);
    if (patch.prompt !== undefined) add('prompt', patch.prompt);
    if (patch.configSnapshot !== undefined) {
      pairs.push('config_snapshot = ?');
      values.push(jsonParam(patch.configSnapshot));
    }
    if (patch.targetType !== undefined) add('target_type', patch.targetType);
    if (patch.targetPayload !== undefined) {
      pairs.push('target_payload = ?');
      values.push(jsonParam(patch.targetPayload));
    }
    if (patch.targetRef !== undefined) {
      pairs.push('target_ref = ?');
      values.push(jsonParam(patch.targetRef));
    }
    if (patch.title !== undefined) add('title', patch.title);
    if (patch.body !== undefined) add('body', patch.body);
    if (patch.failureKind !== undefined) add('failure_kind', patch.failureKind);
    if (patch.historyArchivedAt !== undefined) add('history_archived_at', mysqlDate(patch.historyArchivedAt));
    if (patch.attempts !== undefined) add('attempts', patch.attempts);
    if (patch.maxAttempts !== undefined) add('max_attempts', patch.maxAttempts);
    if (patch.blockedReason !== undefined) add('blocked_reason', patch.blockedReason);
    if (patch.resumeAfter !== undefined) add('resume_after', mysqlDate(patch.resumeAfter));
    if (patch.leaseOwner !== undefined) add('lease_owner', patch.leaseOwner);
    if (patch.leaseExpiresAt !== undefined) add('lease_expires_at', mysqlDate(patch.leaseExpiresAt));
    if (patch.currentStep !== undefined) add('current_step', patch.currentStep);
    if (patch.startedAt !== undefined) add('started_at', mysqlDate(patch.startedAt));
    if (patch.completedAt !== undefined) add('completed_at', mysqlDate(patch.completedAt));
    if (patch.updatedAt !== undefined) add('updated_at', mysqlDate(patch.updatedAt));
    if (pairs.length === 0) return;
    values.push(id);
    await this.execute(`UPDATE queue_jobs SET ${pairs.join(', ')} WHERE id = ?`, values);
  }

  async deleteJob(id: string): Promise<boolean> {
    // queue_steps cascades (FK ON DELETE CASCADE); queue_events keep their rows (ON DELETE SET NULL).
    const result = await this.execute('DELETE FROM queue_jobs WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async updateStep(jobId: string, stepKey: StageId, patch: QueueStepPatch): Promise<void> {
    const pairs: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      pairs.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.attempts !== undefined) add('attempts', patch.attempts);
    if (patch.error !== undefined) add('error', patch.error);
    if (patch.checkpoint !== undefined) {
      pairs.push('checkpoint = ?');
      values.push(jsonParam(patch.checkpoint));
    }
    if (patch.startedAt !== undefined) add('started_at', mysqlDate(patch.startedAt));
    if (patch.completedAt !== undefined) add('completed_at', mysqlDate(patch.completedAt));
    if (patch.updatedAt !== undefined) add('updated_at', mysqlDate(patch.updatedAt));
    if (pairs.length === 0) return;
    values.push(jobId, stepKey);
    await this.execute(`UPDATE queue_steps SET ${pairs.join(', ')} WHERE job_id = ? AND step_key = ?`, values);
  }

  async replacePositions(ids: string[], now: string): Promise<void> {
    // Build the full target ordering: explicitly requested ids first, then the
    // remaining jobs in their existing order. We then apply every new position
    // in a single bulk UPDATE (CASE/WHEN) instead of one statement per row.
    const trailing = await this.select<QueueJobRow[]>(
      ids.length
        ? `SELECT id FROM queue_jobs WHERE id NOT IN (${ids.map(() => '?').join(', ')}) ORDER BY position ASC, created_at ASC`
        : 'SELECT id FROM queue_jobs ORDER BY position ASC, created_at ASC',
      ids,
    );
    const ordered = [...ids, ...trailing.map((row) => row.id)];
    if (ordered.length === 0) return;

    const mysqlNow = mysqlDate(now);
    const cases: string[] = [];
    const caseParams: unknown[] = [];
    ordered.forEach((id, index) => {
      cases.push('WHEN ? THEN ?');
      caseParams.push(id, index + 1);
    });
    const placeholders = ordered.map(() => '?').join(', ');
    await this.execute(
      `UPDATE queue_jobs
         SET position = CASE id ${cases.join(' ')} END,
             updated_at = ?
       WHERE id IN (${placeholders})`,
      [...caseParams, mysqlNow, ...ordered],
    );
  }

  async upsertRule(rule: QueueRule): Promise<void> {
    await this.execute(
      `INSERT INTO queue_rules (
        id, name, enabled, provider, window_key, metric, operator, threshold, action, config, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        enabled = VALUES(enabled),
        provider = VALUES(provider),
        window_key = VALUES(window_key),
        metric = VALUES(metric),
        operator = VALUES(operator),
        threshold = VALUES(threshold),
        action = VALUES(action),
        config = VALUES(config),
        updated_at = VALUES(updated_at)`,
      [
        rule.id,
        rule.name,
        rule.enabled ? 1 : 0,
        rule.provider,
        rule.windowKey,
        rule.metric,
        rule.operator,
        rule.threshold,
        rule.action,
        jsonParam(rule.config),
        mysqlDate(rule.createdAt),
        mysqlDate(rule.updatedAt),
      ],
    );
  }

  async deleteRule(id: string): Promise<boolean> {
    const result = await this.execute('DELETE FROM queue_rules WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  private async select<T extends RowDataPacket[]>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T> {
    if (this.conn) {
      const [rows] = await this.conn.query<T>(sql, params as unknown[]);
      return rows;
    }
    return query<T>(sql, params);
  }

  private async execute(sql: string, params: ReadonlyArray<unknown> = []): Promise<ResultSetHeader> {
    if (this.conn) {
      const [result] = await this.conn.query<ResultSetHeader>(sql, params as unknown[]);
      return result;
    }
    return query<ResultSetHeader>(sql, params);
  }

  private async insertPromptHistoryEvent(event: QueueEvent): Promise<void> {
    const payload = event.payload ?? {};
    try {
      await this.execute(
        `INSERT INTO prompt_history_events
          (id, project_id, kind, input_text, output_text, generation_id, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.id,
          typeof payload.projectId === 'string' ? payload.projectId : null,
          event.type,
          typeof payload.inputText === 'string' ? payload.inputText : null,
          typeof payload.outputText === 'string' ? payload.outputText : null,
          null,
          jsonParam({ ...payload, queueEventMessage: event.message }),
          mysqlDate(event.createdAt),
        ],
      );
    } catch (err) {
      if (!isMissingLimitTable(err)) throw err;
    }
  }
}

function mapLimitSnapshot(row: LimitSnapshotRow): QueueLimitSnapshot {
  const percent = row.percent_used ?? row.usage_percent ?? null;
  return {
    provider: row.provider,
    windowKey: row.window_key ?? 'any',
    percentUsed: percent == null ? null : Number(percent),
    resetAt: iso(row.reset_at),
    checkedAt: iso(row.checked_at ?? row.created_at) ?? new Date().toISOString(),
  };
}

export class MysqlQueueRepository extends MysqlQueueRepositoryTx implements QueueRepository {
  constructor() {
    super(null);
  }

  transaction<T>(fn: (tx: QueueRepositoryTx) => Promise<T>): Promise<T> {
    return withTransaction((conn) => fn(new MysqlQueueRepositoryTx(conn)));
  }
}
