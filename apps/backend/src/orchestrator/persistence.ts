import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { nanoid } from 'nanoid';
import type {
  AgentRun,
  AgentRunState,
  AgentType,
  ExecutionStatus,
  FindingStatus,
  ReviewStatus,
  StageId,
  StageRunConfig,
  StageStatus,
  TaskRecord,
} from './types.js';
import { toAgentTypeOr } from './types.js';
import type { FindingRecord } from './findings.js';

export type ExecutionOwnerType = 'manual' | 'queue';
export type ExecutionRunStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export type PersistedStageStatus = StageStatus | 'interrupted';
export type PersistedAgentStatus = AgentRunState | 'interrupted';

export interface ExecutionOwner {
  type: ExecutionOwnerType;
  id: string;
}

export interface LeaseAcquireInput {
  workspace: string;
  tigerRoot: string;
  owner: ExecutionOwner;
  ttlMs: number;
}

export interface LeaseConflict {
  leaseOwner: string;
  leaseExpiresAt: string | null;
  runId?: string;
}

export type LeaseAcquireResult =
  | { ok: true; runId: string; leaseOwner: string; leaseExpiresAt: string }
  | { ok: false; conflict: LeaseConflict };

export interface StagePersistenceInput {
  workspace: string;
  runId: string;
  stageId: StageId;
  status: PersistedStageStatus;
  cfg?: StageRunConfig;
  message?: string;
  owner: ExecutionOwner;
  ttlMs: number;
  startedAt?: string;
  endedAt?: string;
}

export interface AgentPersistenceInput {
  workspace: string;
  runId: string;
  run: AgentRun;
  owner: ExecutionOwner;
  ttlMs: number;
}

export interface ArtifactInput {
  workspace: string;
  runId: string;
  stageId: StageId;
  agentRunId?: string;
  kind: string;
  absPath: string;
  relPath: string;
  checksumSha256?: string | null;
  sizeBytes?: number | null;
}

export interface TaskPersistenceInput {
  workspace: string;
  task: TaskRecord;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  attemptsDelta?: number;
}

export interface FindingPersistenceInput {
  workspace: string;
  finding: FindingRecord;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  attemptsDelta?: number;
}

export interface PersistedStageRecord {
  runId: string;
  stageId: StageId;
  status: PersistedStageStatus;
  message?: string;
  attempts: number;
  config?: StageRunConfig;
  startedAt?: string;
  endedAt?: string;
  runs: PersistedAgentRunRecord[];
}

export interface PersistedAgentRunRecord {
  runId: string;
  id: string;
  terminalId: string;
  stage: StageId;
  type: AgentType;
  index: number;
  label: string;
  outputPath: string;
  outputRel: string;
  markerPath: string;
  promptPath: string;
  command: string;
  state: PersistedAgentStatus;
  completion?: 'marker' | 'idle' | 'exit';
  exitCode?: number | null;
  error?: string;
  taskId?: string;
  startedAt?: string;
  endedAt?: string;
  attempts: number;
}

export interface PersistedProjectState {
  stages: Partial<Record<StageId, PersistedStageRecord>>;
}

export interface ReconcileResult {
  interruptedRuns: number;
  interruptedStages: number;
  interruptedAgents: number;
  reclaimedTasks: number;
  reclaimedFindings: number;
}

export interface ExecutionPersistence {
  init(): Promise<void>;
  acquireRunLease(input: LeaseAcquireInput): Promise<LeaseAcquireResult>;
  refreshRunLease(runId: string, owner: ExecutionOwner, ttlMs: number): Promise<void>;
  finishRun(runId: string, status: ExecutionRunStatus, message?: string): Promise<void>;
  startStage(input: StagePersistenceInput): Promise<void>;
  finishStage(input: StagePersistenceInput): Promise<void>;
  recordAgentRun(input: AgentPersistenceInput): Promise<void>;
  recordArtifact(input: ArtifactInput): Promise<void>;
  recordTasks(input: TaskPersistenceInput[]): Promise<void>;
  recordTaskClaim(input: TaskPersistenceInput): Promise<void>;
  recordTaskFinish(input: TaskPersistenceInput): Promise<void>;
  recordFindings(input: FindingPersistenceInput[]): Promise<void>;
  recordFindingClaim(input: FindingPersistenceInput): Promise<void>;
  recordFindingFinish(input: FindingPersistenceInput): Promise<void>;
  loadProjectState(workspace: string): Promise<PersistedProjectState | null>;
  reconcileOnBoot(input: { workspace: string; owner: ExecutionOwner; ttlMs: number }): Promise<ReconcileResult>;
}

export class NoopExecutionPersistence implements ExecutionPersistence {
  async init(): Promise<void> {}
  async acquireRunLease(input: LeaseAcquireInput): Promise<LeaseAcquireResult> {
    const leaseOwner = ownerKey(input.owner);
    return { ok: true, runId: nanoid(), leaseOwner, leaseExpiresAt: leaseExpiresAt(input.ttlMs) };
  }
  async refreshRunLease(): Promise<void> {}
  async finishRun(): Promise<void> {}
  async startStage(): Promise<void> {}
  async finishStage(): Promise<void> {}
  async recordAgentRun(): Promise<void> {}
  async recordArtifact(): Promise<void> {}
  async recordTasks(): Promise<void> {}
  async recordTaskClaim(): Promise<void> {}
  async recordTaskFinish(): Promise<void> {}
  async recordFindings(): Promise<void> {}
  async recordFindingClaim(): Promise<void> {}
  async recordFindingFinish(): Promise<void> {}
  async loadProjectState(): Promise<PersistedProjectState | null> {
    return null;
  }
  async reconcileOnBoot(): Promise<ReconcileResult> {
    return zeroReconcile();
  }
}

export interface MySqlExecutionPersistenceOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  charset?: string;
  connectionLimit?: number;
  connectRetries?: number;
  connectRetryDelayMs?: number;
  connectMaxDelayMs?: number;
}

const MIGRATION_ID = '20260618_tiger_execution_checkpoints';
const WORKSPACE_LEASE_MIGRATION_ID = '20260618_tiger_execution_workspace_leases';

const EXECUTION_WORKSPACE_LEASE_STATEMENT = `CREATE TABLE IF NOT EXISTS execution_workspace_leases (
  workspace_hash CHAR(64) NOT NULL PRIMARY KEY,
  workspace_path VARCHAR(1024) NOT NULL,
  run_id VARCHAR(64) NULL,
  lease_owner VARCHAR(191) NULL,
  lease_expires_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_execution_workspace_leases_path (workspace_path(191)),
  INDEX idx_execution_workspace_leases_run (run_id),
  CONSTRAINT fk_execution_workspace_leases_run FOREIGN KEY (run_id) REFERENCES execution_runs(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    id VARCHAR(128) NOT NULL PRIMARY KEY,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS execution_runs (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    workspace_path VARCHAR(1024) NOT NULL,
    tiger_root VARCHAR(1024) NOT NULL,
    owner_type VARCHAR(32) NOT NULL,
    owner_id VARCHAR(191) NOT NULL,
    status VARCHAR(32) NOT NULL,
    attempts INT NOT NULL DEFAULT 1,
    lease_owner VARCHAR(191) NULL,
    lease_expires_at DATETIME(3) NULL,
    started_at DATETIME(3) NULL,
    ended_at DATETIME(3) NULL,
    last_error TEXT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_execution_runs_workspace_status (workspace_path(191), status),
    INDEX idx_execution_runs_lease (lease_owner, lease_expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS run_stages (
    id VARCHAR(128) NOT NULL PRIMARY KEY,
    workspace_path VARCHAR(1024) NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    stage_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    config_json JSON NULL,
    message TEXT NULL,
    lease_owner VARCHAR(191) NULL,
    lease_expires_at DATETIME(3) NULL,
    started_at DATETIME(3) NULL,
    ended_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_run_stages_workspace_stage (workspace_path(191), stage_id),
    INDEX idx_run_stages_run (run_id),
    CONSTRAINT fk_run_stages_run FOREIGN KEY (run_id) REFERENCES execution_runs(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    workspace_path VARCHAR(1024) NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    stage_id VARCHAR(64) NOT NULL,
    terminal_id VARCHAR(64) NOT NULL,
    agent_type VARCHAR(16) NOT NULL,
    agent_index INT NOT NULL,
    label VARCHAR(64) NOT NULL,
    task_id VARCHAR(128) NULL,
    status VARCHAR(32) NOT NULL,
    command_text TEXT NOT NULL,
    output_path VARCHAR(2048) NOT NULL,
    output_rel VARCHAR(1024) NOT NULL,
    marker_path VARCHAR(2048) NOT NULL,
    prompt_path VARCHAR(2048) NOT NULL,
    completion VARCHAR(32) NULL,
    exit_code INT NULL,
    error TEXT NULL,
    attempts INT NOT NULL DEFAULT 0,
    lease_owner VARCHAR(191) NULL,
    lease_expires_at DATETIME(3) NULL,
    started_at DATETIME(3) NULL,
    ended_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_agent_runs_workspace_stage (workspace_path(191), stage_id),
    INDEX idx_agent_runs_run_stage (run_id, stage_id),
    INDEX idx_agent_runs_task (workspace_path(191), task_id),
    CONSTRAINT fk_agent_runs_run FOREIGN KEY (run_id) REFERENCES execution_runs(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS tasks (
    workspace_path VARCHAR(1024) NOT NULL,
    task_id VARCHAR(128) NOT NULL,
    title TEXT NOT NULL,
    execution_status VARCHAR(32) NOT NULL,
    assigned_agent VARCHAR(128) NOT NULL,
    review_status VARCHAR(32) NOT NULL,
    review_notes TEXT NULL,
    attempts INT NOT NULL DEFAULT 0,
    lease_owner VARCHAR(191) NULL,
    lease_expires_at DATETIME(3) NULL,
    started_at DATETIME(3) NULL,
    completed_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (workspace_path(191), task_id),
    INDEX idx_tasks_status (workspace_path(191), execution_status),
    INDEX idx_tasks_lease (lease_owner, lease_expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS findings (
    workspace_path VARCHAR(1024) NOT NULL,
    finding_id VARCHAR(128) NOT NULL,
    title TEXT NOT NULL,
    related_task_id VARCHAR(128) NULL,
    status VARCHAR(32) NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    lease_owner VARCHAR(191) NULL,
    lease_expires_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (workspace_path(191), finding_id),
    INDEX idx_findings_status (workspace_path(191), status),
    INDEX idx_findings_lease (lease_owner, lease_expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    workspace_path VARCHAR(1024) NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    stage_id VARCHAR(64) NOT NULL,
    agent_run_id VARCHAR(64) NULL,
    kind VARCHAR(64) NOT NULL,
    abs_path VARCHAR(2048) NOT NULL,
    rel_path VARCHAR(1024) NOT NULL,
    checksum_sha256 CHAR(64) NULL,
    size_bytes BIGINT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_artifacts_workspace_stage (workspace_path(191), stage_id),
    INDEX idx_artifacts_run (run_id),
    INDEX idx_artifacts_agent (agent_run_id),
    CONSTRAINT fk_artifacts_run FOREIGN KEY (run_id) REFERENCES execution_runs(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

export const EXECUTION_CHECKPOINT_MIGRATION = {
  id: MIGRATION_ID,
  statements: MIGRATION_STATEMENTS.slice(1),
};

export const EXECUTION_WORKSPACE_LEASE_MIGRATION = {
  id: WORKSPACE_LEASE_MIGRATION_ID,
  statements: [EXECUTION_WORKSPACE_LEASE_STATEMENT],
};

export class MySqlExecutionPersistence implements ExecutionPersistence {
  private pool: Pool | null = null;
  private initialized = false;

  constructor(private readonly options: MySqlExecutionPersistenceOptions | Pool) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    const options = this.options;
    if (isPool(options)) {
      this.pool = options;
      await this.migrate();
      this.initialized = true;
      return;
    }
    const dbName = quoteIdentifier(options.database);
    await withRetries(
      async () => {
        const admin = await mysql.createConnection({
          host: options.host,
          port: options.port,
          user: options.user,
          password: options.password,
          charset: options.charset ?? 'utf8mb4',
        });
        try {
          await admin.query(`CREATE DATABASE IF NOT EXISTS ${dbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        } finally {
          await admin.end();
        }
      },
      options.connectRetries ?? 1,
      options.connectRetryDelayMs ?? 500,
      options.connectMaxDelayMs ?? 5000,
    );
    this.pool = mysql.createPool({
      host: options.host,
      port: options.port,
      user: options.user,
      password: options.password,
      database: options.database,
      charset: options.charset ?? 'utf8mb4',
      connectionLimit: options.connectionLimit ?? 10,
    });
    await this.migrate();
    this.initialized = true;
  }

  async acquireRunLease(input: LeaseAcquireInput): Promise<LeaseAcquireResult> {
    await this.init();
    const leaseOwner = ownerKey(input.owner);
    const runId = nanoid();
    const expires = leaseExpiresAt(input.ttlMs);
    const now = new Date();
    const workspaceHash = workspaceLeaseHash(input.workspace);
    return this.transaction(async (conn) => {
      await conn.execute<ResultSetHeader>(
        `INSERT INTO execution_workspace_leases (workspace_hash, workspace_path)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE workspace_path = VALUES(workspace_path)`,
        [workspaceHash, input.workspace],
      );
      const [leaseRows] = await conn.execute<WorkspaceLeaseRow[]>(
        `SELECT run_id, lease_owner, lease_expires_at
         FROM execution_workspace_leases
         WHERE workspace_hash = ?
         FOR UPDATE`,
        [workspaceHash],
      );
      const workspaceLease = leaseRows[0];
      if (
        workspaceLease?.run_id &&
        workspaceLease.lease_owner &&
        workspaceLease.lease_owner !== leaseOwner &&
        leaseIsActive(workspaceLease.lease_expires_at, now)
      ) {
        return {
          ok: false,
          conflict: {
            runId: workspaceLease.run_id,
            leaseOwner: workspaceLease.lease_owner,
            leaseExpiresAt: dateIso(workspaceLease.lease_expires_at),
          },
        };
      }

      const [activeRows] = await conn.execute<ActiveLeaseRow[]>(
        `SELECT id, lease_owner, lease_expires_at
         FROM execution_runs
         WHERE workspace_path = ?
           AND status = 'running'
           AND (lease_expires_at IS NULL OR lease_expires_at > ?)
         ORDER BY updated_at DESC
         LIMIT 1`,
        [input.workspace, now],
      );
      const active = activeRows[0];
      if (active && active.lease_owner && active.lease_owner !== leaseOwner) {
        await conn.execute<ResultSetHeader>(
          `UPDATE execution_workspace_leases
           SET run_id = ?, lease_owner = ?, lease_expires_at = ?
           WHERE workspace_hash = ?`,
          [active.id, active.lease_owner, sqlDate(dateIso(active.lease_expires_at)), workspaceHash],
        );
        return {
          ok: false,
          conflict: {
            runId: active.id,
            leaseOwner: active.lease_owner,
            leaseExpiresAt: dateIso(active.lease_expires_at),
          },
        };
      }

      await conn.execute<ResultSetHeader>(
        `INSERT INTO execution_runs
          (id, workspace_path, tiger_root, owner_type, owner_id, status, attempts, lease_owner, lease_expires_at, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', 1, ?, ?, ?)`,
        [
          runId,
          input.workspace,
          input.tigerRoot,
          input.owner.type,
          input.owner.id,
          leaseOwner,
          sqlDate(expires),
          now,
        ],
      );
      await conn.execute<ResultSetHeader>(
        `UPDATE execution_workspace_leases
         SET run_id = ?, lease_owner = ?, lease_expires_at = ?
         WHERE workspace_hash = ?`,
        [runId, leaseOwner, sqlDate(expires), workspaceHash],
      );
      return { ok: true, runId, leaseOwner, leaseExpiresAt: expires };
    });
  }

  async refreshRunLease(runId: string, owner: ExecutionOwner, ttlMs: number): Promise<void> {
    const leaseOwner = ownerKey(owner);
    const expires = leaseExpiresAt(ttlMs);
    await this.exec(
      `UPDATE execution_runs SET lease_owner = ?, lease_expires_at = ? WHERE id = ?`,
      [leaseOwner, sqlDate(expires), runId],
    );
    await this.exec(
      `UPDATE execution_workspace_leases
       SET lease_owner = ?, lease_expires_at = ?
       WHERE run_id = ?`,
      [leaseOwner, sqlDate(expires), runId],
    );
  }

  async finishRun(runId: string, status: ExecutionRunStatus, message?: string): Promise<void> {
    await this.exec(
      `UPDATE execution_runs
       SET status = ?, ended_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = ?
      WHERE id = ?`,
      [status, new Date(), message ?? null, runId],
    );
    await this.exec(
      `UPDATE execution_workspace_leases
       SET run_id = NULL, lease_owner = NULL, lease_expires_at = NULL
       WHERE run_id = ?`,
      [runId],
    );
  }

  async startStage(input: StagePersistenceInput): Promise<void> {
    await this.recordStage(input, true);
  }

  async finishStage(input: StagePersistenceInput): Promise<void> {
    await this.recordStage(input, false);
  }

  async recordAgentRun(input: AgentPersistenceInput): Promise<void> {
    const run = input.run;
    const expires = leaseExpiresAt(input.ttlMs);
    await this.exec(
      `INSERT INTO agent_runs
        (id, workspace_path, run_id, stage_id, terminal_id, agent_type, agent_index, label, task_id, status,
         command_text, output_path, output_rel, marker_path, prompt_path, completion, exit_code, error, attempts,
         lease_owner, lease_expires_at, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         task_id = VALUES(task_id),
         completion = VALUES(completion),
         exit_code = VALUES(exit_code),
         error = VALUES(error),
         attempts = VALUES(attempts),
         lease_owner = VALUES(lease_owner),
         lease_expires_at = VALUES(lease_expires_at),
         started_at = VALUES(started_at),
         ended_at = VALUES(ended_at)`,
      [
        run.id,
        input.workspace,
        input.runId,
        run.stage,
        run.terminalId,
        run.type,
        run.index,
        run.label,
        run.taskId ?? null,
        run.state,
        run.command,
        run.outputPath,
        run.outputRel,
        run.markerPath,
        run.promptPath,
        run.completion ?? null,
        run.exitCode ?? null,
        run.error ?? null,
        run.attempts,
        isTerminalState(run.state) ? ownerKey(input.owner) : null,
        isTerminalState(run.state) ? sqlDate(expires) : null,
        sqlDate(run.startedAt),
        sqlDate(run.endedAt),
      ],
    );
  }

  async recordArtifact(input: ArtifactInput): Promise<void> {
    const id = artifactId(input);
    await this.exec(
      `INSERT INTO artifacts
        (id, workspace_path, run_id, stage_id, agent_run_id, kind, abs_path, rel_path, checksum_sha256, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        checksum_sha256 = VALUES(checksum_sha256),
        size_bytes = VALUES(size_bytes),
        rel_path = VALUES(rel_path)`,
      [
        id,
        input.workspace,
        input.runId,
        input.stageId,
        input.agentRunId ?? null,
        input.kind,
        input.absPath,
        input.relPath,
        input.checksumSha256 ?? null,
        input.sizeBytes ?? null,
      ],
    );
  }

  async recordTasks(input: TaskPersistenceInput[]): Promise<void> {
    for (const item of input) await this.upsertTask(item, 0);
  }

  async recordTaskClaim(input: TaskPersistenceInput): Promise<void> {
    await this.upsertTask(input, input.attemptsDelta ?? 1);
  }

  async recordTaskFinish(input: TaskPersistenceInput): Promise<void> {
    await this.upsertTask({ ...input, leaseOwner: null, leaseExpiresAt: null }, input.attemptsDelta ?? 0);
  }

  async recordFindings(input: FindingPersistenceInput[]): Promise<void> {
    for (const item of input) await this.upsertFinding(item, 0);
  }

  async recordFindingClaim(input: FindingPersistenceInput): Promise<void> {
    await this.upsertFinding(input, input.attemptsDelta ?? 1);
  }

  async recordFindingFinish(input: FindingPersistenceInput): Promise<void> {
    await this.upsertFinding({ ...input, leaseOwner: null, leaseExpiresAt: null }, input.attemptsDelta ?? 0);
  }

  async loadProjectState(workspace: string): Promise<PersistedProjectState | null> {
    await this.init();
    const stages = await this.rows<StageRow[]>(
      `SELECT run_id, stage_id, status, attempts, config_json, message, started_at, ended_at, updated_at
       FROM run_stages
       WHERE workspace_path = ?
       ORDER BY updated_at ASC`,
      [workspace],
    );
    if (stages.length === 0) return null;
    const latest = new Map<StageId, StageRow>();
    for (const row of stages) latest.set(row.stage_id as StageId, row);
    const runIds = [...new Set([...latest.values()].map((r) => r.run_id))];
    const agents = runIds.length
      ? await this.rows<AgentRow[]>(
          `SELECT *
           FROM agent_runs
           WHERE workspace_path = ? AND run_id IN (${runIds.map(() => '?').join(',')})
           ORDER BY agent_index ASC, created_at ASC`,
          [workspace, ...runIds],
        )
      : [];
    const agentsByKey = new Map<string, PersistedAgentRunRecord[]>();
    for (const row of agents) {
      const key = `${row.run_id}:${row.stage_id}`;
      const list = agentsByKey.get(key) ?? [];
      list.push(agentFromRow(row));
      agentsByKey.set(key, list);
    }
    const out: PersistedProjectState = { stages: {} };
    for (const row of latest.values()) {
      const stageId = row.stage_id as StageId;
      out.stages[stageId] = {
        runId: row.run_id,
        stageId,
        status: row.status as PersistedStageStatus,
        message: row.message ?? undefined,
        attempts: row.attempts,
        config: parseJson<StageRunConfig>(row.config_json),
        startedAt: dateIso(row.started_at) ?? undefined,
        endedAt: dateIso(row.ended_at) ?? undefined,
        runs: agentsByKey.get(`${row.run_id}:${row.stage_id}`) ?? [],
      };
    }
    return out;
  }

  async reconcileOnBoot(input: { workspace: string; owner: ExecutionOwner; ttlMs: number }): Promise<ReconcileResult> {
    await this.init();
    const now = new Date();
    const runs = await this.rows<ActiveLeaseRow[]>(
      `SELECT id, lease_owner, lease_expires_at
       FROM execution_runs
       WHERE workspace_path = ? AND status = 'running'`,
      [input.workspace],
    );
    const staleRunIds = runs
      .filter((r) => leaseIsStale(r.lease_owner, dateIso(r.lease_expires_at), ownerKey(input.owner)))
      .map((r) => r.id);
    let interruptedRuns = 0;
    let interruptedStages = 0;
    let interruptedAgents = 0;
    if (staleRunIds.length > 0) {
      const ph = staleRunIds.map(() => '?').join(',');
      interruptedRuns = (
        await this.exec(
          `UPDATE execution_runs
           SET status = 'interrupted', ended_at = ?, lease_owner = NULL, lease_expires_at = NULL,
               last_error = 'Interrupted by backend restart before completion.'
           WHERE id IN (${ph}) AND status = 'running'`,
          [now, ...staleRunIds],
        )
      ).affectedRows;
      interruptedStages = (
        await this.exec(
          `UPDATE run_stages
           SET status = 'interrupted', ended_at = ?, lease_owner = NULL, lease_expires_at = NULL,
               message = COALESCE(message, 'Interrupted by backend restart before completion.')
           WHERE run_id IN (${ph}) AND status = 'running'`,
          [now, ...staleRunIds],
        )
      ).affectedRows;
      interruptedAgents = (
        await this.exec(
          `UPDATE agent_runs
           SET status = 'interrupted', ended_at = ?, lease_owner = NULL, lease_expires_at = NULL,
               error = COALESCE(error, 'Interrupted by backend restart before completion.')
           WHERE run_id IN (${ph}) AND status IN ('pending', 'starting', 'waiting_ready', 'running')`,
          [now, ...staleRunIds],
        )
      ).affectedRows;
      await this.exec(
        `UPDATE execution_workspace_leases
         SET run_id = NULL, lease_owner = NULL, lease_expires_at = NULL
         WHERE run_id IN (${ph})`,
        staleRunIds,
      );
    }
    const reclaimedTasks = (
      await this.exec(
        `UPDATE tasks
         SET execution_status = 'not_started', assigned_agent = '-', started_at = NULL, completed_at = NULL,
             lease_owner = NULL, lease_expires_at = NULL
         WHERE workspace_path = ? AND execution_status = 'in_progress'
           AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
        [input.workspace, now],
      )
    ).affectedRows;
    const reclaimedFindings = (
      await this.exec(
        `UPDATE findings
         SET status = 'open', lease_owner = NULL, lease_expires_at = NULL
         WHERE workspace_path = ? AND status = 'fixing'
           AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
        [input.workspace, now],
      )
    ).affectedRows;
    return { interruptedRuns, interruptedStages, interruptedAgents, reclaimedTasks, reclaimedFindings };
  }

  private async migrate(): Promise<void> {
    await this.exec(MIGRATION_STATEMENTS[0]!, []);
    await this.applyMigration(MIGRATION_ID, MIGRATION_STATEMENTS.slice(1));
    await this.applyMigration(WORKSPACE_LEASE_MIGRATION_ID, [EXECUTION_WORKSPACE_LEASE_STATEMENT]);
  }

  private async applyMigration(id: string, statements: string[]): Promise<void> {
    const existing = await this.rows<{ id: string }[] & RowDataPacket[]>(
      `SELECT id FROM schema_migrations WHERE id = ?`,
      [id],
    );
    if (existing.length > 0) return;
    for (const statement of statements) await this.exec(statement, []);
    await this.exec(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)`, [id, new Date()]);
  }

  private async transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
    const conn = await this.pool!.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  private async recordStage(input: StagePersistenceInput, starting: boolean): Promise<void> {
    const id = stageRecordId(input.runId, input.stageId);
    const expires = leaseExpiresAt(input.ttlMs);
    await this.exec(
      `INSERT INTO run_stages
        (id, workspace_path, run_id, stage_id, status, attempts, config_json, message, lease_owner,
         lease_expires_at, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         attempts = ${starting ? 'attempts + 1' : 'attempts'},
         config_json = COALESCE(VALUES(config_json), config_json),
         message = VALUES(message),
         lease_owner = VALUES(lease_owner),
         lease_expires_at = VALUES(lease_expires_at),
         started_at = COALESCE(VALUES(started_at), started_at),
         ended_at = VALUES(ended_at)`,
      [
        id,
        input.workspace,
        input.runId,
        input.stageId,
        input.status,
        starting ? 1 : 0,
        input.cfg ? JSON.stringify(input.cfg) : null,
        input.message ?? null,
        input.status === 'running' ? ownerKey(input.owner) : null,
        input.status === 'running' ? sqlDate(expires) : null,
        sqlDate(input.startedAt),
        sqlDate(input.endedAt),
      ],
    );
  }

  private async upsertTask(input: TaskPersistenceInput, attemptsDelta: number): Promise<void> {
    const t = input.task;
    await this.exec(
      `INSERT INTO tasks
        (workspace_path, task_id, title, execution_status, assigned_agent, review_status, review_notes, attempts,
         lease_owner, lease_expires_at, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         execution_status = VALUES(execution_status),
         assigned_agent = VALUES(assigned_agent),
         review_status = VALUES(review_status),
         review_notes = VALUES(review_notes),
         attempts = attempts + ?,
         lease_owner = VALUES(lease_owner),
         lease_expires_at = VALUES(lease_expires_at),
         started_at = VALUES(started_at),
         completed_at = VALUES(completed_at)`,
      [
        input.workspace,
        t.id,
        t.title,
        t.executionStatus,
        t.assignedAgent,
        t.reviewStatus,
        t.reviewNotes,
        attemptsDelta,
        input.leaseOwner ?? null,
        sqlDate(input.leaseExpiresAt),
        sqlDate(t.startedAt),
        sqlDate(t.completedAt),
        attemptsDelta,
      ],
    );
  }

  private async upsertFinding(input: FindingPersistenceInput, attemptsDelta: number): Promise<void> {
    const f = input.finding;
    await this.exec(
      `INSERT INTO findings
        (workspace_path, finding_id, title, related_task_id, status, attempts, lease_owner, lease_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         related_task_id = VALUES(related_task_id),
         status = VALUES(status),
         attempts = attempts + ?,
         lease_owner = VALUES(lease_owner),
         lease_expires_at = VALUES(lease_expires_at)`,
      [
        input.workspace,
        f.id,
        f.title,
        f.relatedTask ?? null,
        f.status,
        attemptsDelta,
        input.leaseOwner ?? null,
        sqlDate(input.leaseExpiresAt),
        attemptsDelta,
      ],
    );
  }

  private async rows<T extends RowDataPacket[]>(sql: string, values: unknown[]): Promise<T> {
    const [rows] = await this.pool!.execute<T>(sql, values as Parameters<Pool['execute']>[1]);
    return rows;
  }

  private async exec(sql: string, values: unknown[]): Promise<ResultSetHeader> {
    const [result] = await this.pool!.execute<ResultSetHeader>(sql, values as Parameters<Pool['execute']>[1]);
    return result;
  }
}

export class MemoryExecutionPersistence implements ExecutionPersistence {
  readonly runs = new Map<string, MemoryRun>();
  readonly stages = new Map<string, MemoryStage>();
  readonly agents = new Map<string, PersistedAgentRunRecord>();
  readonly artifacts = new Map<string, ArtifactInput>();
  readonly tasks = new Map<string, TaskPersistenceInput>();
  readonly findings = new Map<string, FindingPersistenceInput>();

  async init(): Promise<void> {}

  async acquireRunLease(input: LeaseAcquireInput): Promise<LeaseAcquireResult> {
    const now = Date.now();
    const leaseOwner = ownerKey(input.owner);
    for (const run of this.runs.values()) {
      if (run.workspace !== input.workspace || run.status !== 'running') continue;
      if (run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) <= now) continue;
      if (run.leaseOwner && run.leaseOwner !== leaseOwner) {
        return {
          ok: false,
          conflict: { runId: run.id, leaseOwner: run.leaseOwner, leaseExpiresAt: run.leaseExpiresAt },
        };
      }
    }
    const id = nanoid();
    const expires = leaseExpiresAt(input.ttlMs);
    this.runs.set(id, {
      id,
      workspace: input.workspace,
      tigerRoot: input.tigerRoot,
      owner: input.owner,
      status: 'running',
      leaseOwner,
      leaseExpiresAt: expires,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    return { ok: true, runId: id, leaseOwner, leaseExpiresAt: expires };
  }

  async refreshRunLease(runId: string, owner: ExecutionOwner, ttlMs: number): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.leaseOwner = ownerKey(owner);
    run.leaseExpiresAt = leaseExpiresAt(ttlMs);
    run.updatedAt = nowIso();
  }

  async finishRun(runId: string, status: ExecutionRunStatus, message?: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = status;
    run.message = message;
    run.leaseOwner = null;
    run.leaseExpiresAt = null;
    run.endedAt = nowIso();
    run.updatedAt = nowIso();
  }

  async startStage(input: StagePersistenceInput): Promise<void> {
    this.recordStage(input, true);
  }

  async finishStage(input: StagePersistenceInput): Promise<void> {
    this.recordStage(input, false);
  }

  async recordAgentRun(input: AgentPersistenceInput): Promise<void> {
    const r = input.run;
    this.agents.set(r.id, {
      runId: input.runId,
      id: r.id,
      terminalId: r.terminalId,
      stage: r.stage,
      type: r.type,
      index: r.index,
      label: r.label,
      outputPath: r.outputPath,
      outputRel: r.outputRel,
      markerPath: r.markerPath,
      promptPath: r.promptPath,
      command: r.command,
      state: r.state,
      completion: r.completion,
      exitCode: r.exitCode,
      error: r.error,
      taskId: r.taskId,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      attempts: r.attempts,
    });
  }

  async recordArtifact(input: ArtifactInput): Promise<void> {
    this.artifacts.set(artifactId(input), { ...input });
  }

  async recordTasks(input: TaskPersistenceInput[]): Promise<void> {
    for (const item of input) this.upsertTask(item, 0);
  }

  async recordTaskClaim(input: TaskPersistenceInput): Promise<void> {
    this.upsertTask(input, input.attemptsDelta ?? 1);
  }

  async recordTaskFinish(input: TaskPersistenceInput): Promise<void> {
    this.upsertTask({ ...input, leaseOwner: null, leaseExpiresAt: null }, input.attemptsDelta ?? 0);
  }

  async recordFindings(input: FindingPersistenceInput[]): Promise<void> {
    for (const item of input) this.upsertFinding(item, 0);
  }

  async recordFindingClaim(input: FindingPersistenceInput): Promise<void> {
    this.upsertFinding(input, input.attemptsDelta ?? 1);
  }

  async recordFindingFinish(input: FindingPersistenceInput): Promise<void> {
    this.upsertFinding({ ...input, leaseOwner: null, leaseExpiresAt: null }, input.attemptsDelta ?? 0);
  }

  async loadProjectState(workspace: string): Promise<PersistedProjectState | null> {
    const matching = [...this.stages.values()]
      .filter((s) => s.workspace === workspace)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    if (matching.length === 0) return null;
    const latest = new Map<StageId, MemoryStage>();
    for (const s of matching) latest.set(s.stageId, s);
    const state: PersistedProjectState = { stages: {} };
    for (const stage of latest.values()) {
      state.stages[stage.stageId] = {
        runId: stage.runId,
        stageId: stage.stageId,
        status: stage.status,
        message: stage.message,
        attempts: stage.attempts,
        config: stage.config,
        startedAt: stage.startedAt,
        endedAt: stage.endedAt,
        runs: [...this.agents.values()]
          .filter((a) => a.runId === stage.runId && a.stage === stage.stageId)
          .sort((a, b) => a.index - b.index),
      };
    }
    return state;
  }

  async reconcileOnBoot(input: { workspace: string; owner: ExecutionOwner; ttlMs: number }): Promise<ReconcileResult> {
    const result = zeroReconcile();
    const currentOwner = ownerKey(input.owner);
    const staleRunIds = new Set<string>();
    for (const run of this.runs.values()) {
      if (run.workspace !== input.workspace || run.status !== 'running') continue;
      if (!leaseIsStale(run.leaseOwner, run.leaseExpiresAt, currentOwner)) continue;
      run.status = 'interrupted';
      run.message = 'Interrupted by backend restart before completion.';
      run.leaseOwner = null;
      run.leaseExpiresAt = null;
      run.endedAt = nowIso();
      run.updatedAt = nowIso();
      staleRunIds.add(run.id);
      result.interruptedRuns++;
    }
    for (const stage of this.stages.values()) {
      if (!staleRunIds.has(stage.runId) || stage.status !== 'running') continue;
      stage.status = 'interrupted';
      stage.message ??= 'Interrupted by backend restart before completion.';
      stage.endedAt = nowIso();
      stage.updatedAt = nowIso();
      result.interruptedStages++;
    }
    for (const agent of this.agents.values()) {
      if (!staleRunIds.has(agent.runId) || !isTerminalState(agent.state)) continue;
      agent.state = 'interrupted';
      agent.error ??= 'Interrupted by backend restart before completion.';
      agent.endedAt = nowIso();
      result.interruptedAgents++;
    }
    const now = Date.now();
    for (const [key, t] of this.tasks) {
      if (t.workspace !== input.workspace || t.task.executionStatus !== 'in_progress') continue;
      if (!t.leaseExpiresAt || Date.parse(t.leaseExpiresAt) > now) continue;
      const task: TaskRecord = {
        ...t.task,
        executionStatus: 'not_started',
        assignedAgent: '-',
        startedAt: '-',
        completedAt: '-',
      };
      this.tasks.set(key, { workspace: t.workspace, task, leaseOwner: null, leaseExpiresAt: null });
      result.reclaimedTasks++;
    }
    for (const [key, f] of this.findings) {
      if (f.workspace !== input.workspace || f.finding.status !== 'fixing') continue;
      if (!f.leaseExpiresAt || Date.parse(f.leaseExpiresAt) > now) continue;
      this.findings.set(key, {
        workspace: f.workspace,
        finding: { ...f.finding, status: 'open' },
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      result.reclaimedFindings++;
    }
    return result;
  }

  private recordStage(input: StagePersistenceInput, starting: boolean): void {
    const id = stageRecordId(input.runId, input.stageId);
    const prev = this.stages.get(id);
    this.stages.set(id, {
      id,
      workspace: input.workspace,
      runId: input.runId,
      stageId: input.stageId,
      status: input.status,
      attempts: (prev?.attempts ?? 0) + (starting ? 1 : 0),
      config: input.cfg ?? prev?.config,
      message: input.message,
      startedAt: input.startedAt ?? prev?.startedAt,
      endedAt: input.endedAt,
      updatedAt: nowIso(),
    });
  }

  private upsertTask(input: TaskPersistenceInput, attemptsDelta: number): void {
    const key = `${input.workspace}:${input.task.id}`;
    const prev = this.tasks.get(key);
    this.tasks.set(key, {
      ...input,
      attemptsDelta: (prev?.attemptsDelta ?? 0) + attemptsDelta,
    });
  }

  private upsertFinding(input: FindingPersistenceInput, attemptsDelta: number): void {
    const key = `${input.workspace}:${input.finding.id}`;
    const prev = this.findings.get(key);
    this.findings.set(key, {
      ...input,
      attemptsDelta: (prev?.attemptsDelta ?? 0) + attemptsDelta,
    });
  }
}

export function ownerKey(owner: ExecutionOwner): string {
  return `${owner.type}:${owner.id}`;
}

export function leaseExpiresAt(ttlMs: number): string {
  return new Date(Date.now() + Math.max(1000, ttlMs)).toISOString();
}

export async function fileArtifact(absPath: string): Promise<{ checksumSha256: string | null; sizeBytes: number | null }> {
  const stat = await fs.stat(absPath).catch(() => null);
  if (!stat?.isFile()) return { checksumSha256: null, sizeBytes: null };
  const body = await fs.readFile(absPath).catch(() => null);
  if (!body) return { checksumSha256: null, sizeBytes: stat.size };
  return { checksumSha256: createHash('sha256').update(body).digest('hex'), sizeBytes: stat.size };
}

interface MemoryRun {
  id: string;
  workspace: string;
  tigerRoot: string;
  owner: ExecutionOwner;
  status: ExecutionRunStatus;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  message?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface MemoryStage {
  id: string;
  workspace: string;
  runId: string;
  stageId: StageId;
  status: PersistedStageStatus;
  attempts: number;
  config?: StageRunConfig;
  message?: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt: string;
}

interface ActiveLeaseRow extends RowDataPacket {
  id: string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
}

interface WorkspaceLeaseRow extends RowDataPacket {
  run_id: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
}

interface StageRow extends RowDataPacket {
  run_id: string;
  stage_id: string;
  status: string;
  attempts: number;
  config_json: string | object | null;
  message: string | null;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  updated_at: Date | string;
}

interface AgentRow extends RowDataPacket {
  id: string;
  run_id: string;
  stage_id: string;
  terminal_id: string;
  agent_type: string;
  agent_index: number;
  label: string;
  task_id: string | null;
  status: string;
  command_text: string;
  output_path: string;
  output_rel: string;
  marker_path: string;
  prompt_path: string;
  completion: string | null;
  exit_code: number | null;
  error: string | null;
  attempts: number;
  started_at: Date | string | null;
  ended_at: Date | string | null;
}

function agentFromRow(row: AgentRow): PersistedAgentRunRecord {
  return {
    runId: row.run_id,
    id: row.id,
    terminalId: row.terminal_id,
    stage: row.stage_id as StageId,
    // Preserve the persisted provider exactly; never coerce an unknown value to claude/codex.
    type: toAgentTypeOr(row.agent_type, 'claude'),
    index: row.agent_index,
    label: row.label,
    outputPath: row.output_path,
    outputRel: row.output_rel,
    markerPath: row.marker_path,
    promptPath: row.prompt_path,
    command: row.command_text,
    state: row.status as PersistedAgentStatus,
    completion: toCompletion(row.completion),
    exitCode: row.exit_code,
    error: row.error ?? undefined,
    taskId: row.task_id ?? undefined,
    startedAt: dateIso(row.started_at) ?? undefined,
    endedAt: dateIso(row.ended_at) ?? undefined,
    attempts: row.attempts,
  };
}

function toCompletion(value: string | null): 'marker' | 'idle' | 'exit' | undefined {
  return value === 'marker' || value === 'idle' || value === 'exit' ? value : undefined;
}

function stageRecordId(runId: string, stageId: StageId): string {
  return `${runId}:${stageId}`;
}

function artifactId(input: ArtifactInput): string {
  return createHash('sha256')
    .update([input.workspace, input.runId, input.stageId, input.agentRunId ?? '', input.kind, input.absPath].join('\0'))
    .digest('hex');
}

function workspaceLeaseHash(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex');
}

function sqlDate(value?: string | Date | null): Date | null {
  if (!value || value === '-') return null;
  if (value instanceof Date) return value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function dateIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function leaseIsActive(expiresAt: Date | string | null | undefined, now: Date): boolean {
  if (!expiresAt) return true;
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  return Number.isNaN(ms) ? false : ms > now.getTime();
}

function parseJson<T>(value: string | object | null): T | undefined {
  if (!value) return undefined;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error(`invalid MySQL database name: ${value}`);
  return `\`${value}\``;
}

function isPool(value: MySqlExecutionPersistenceOptions | Pool): value is Pool {
  return typeof (value as Pool).getConnection === 'function';
}

function isTerminalState(value: string): boolean {
  return value === 'pending' || value === 'starting' || value === 'waiting_ready' || value === 'running';
}

function leaseIsStale(leaseOwner: string | null, expiresAt: string | null, currentOwner: string): boolean {
  if (!leaseOwner) return true;
  if (leaseOwner === currentOwner) return false;
  const pid = pidFromOwner(leaseOwner);
  if (pid !== null && !pidAlive(pid)) return true;
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) return true;
  return false;
}

function pidFromOwner(owner: string): number | null {
  const m = /^(?:manual|queue):(\d+)(?::|$)/.exec(owner);
  if (!m?.[1]) return null;
  const pid = Number(m[1]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function zeroReconcile(): ReconcileResult {
  return {
    interruptedRuns: 0,
    interruptedStages: 0,
    interruptedAgents: 0,
    reclaimedTasks: 0,
    reclaimedFindings: 0,
  };
}

const nowIso = (): string => new Date().toISOString();

async function withRetries<T>(fn: () => Promise<T>, retries: number, delayMs: number, maxDelayMs: number): Promise<T> {
  let attempt = 0;
  let waitMs = Math.max(0, delayMs);
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= Math.max(1, retries)) throw err;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      waitMs = Math.min(Math.max(waitMs * 2, delayMs), Math.max(delayMs, maxDelayMs));
    }
  }
}
