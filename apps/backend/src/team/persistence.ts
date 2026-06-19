import { nanoid } from 'nanoid';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { getDbPool } from '../db/pool.js';
import { leaseExpiresAt, ownerKey, type ExecutionOwner } from '../orchestrator/persistence.js';
import { toAgentTypeOr, type AgentType } from '../orchestrator/types.js';

// ---------------------------------------------------------------------------
// Domain unions
//
// These mirror the AI Team contract defined by TASK-001 (`team/types.ts`). They
// are re-declared here so the persistence layer compiles and unit-tests run
// independently of that file (the two tasks land in parallel). When TASK-001's
// `team/types.ts` is integrated, these structurally-compatible aliases can be
// re-pointed at the canonical types without changing the storage schema.
// ---------------------------------------------------------------------------

export type TeamRunStatus =
  | 'running'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted';

export type TeamMessageFromKind = 'role' | 'user' | 'system';

export type TeamMessageKind =
  | 'chat'
  | 'decision'
  | 'task'
  | 'handoff'
  | 'tool'
  | 'verification'
  | 'finding'
  | 'steering'
  | 'signoff'
  | 'system'
  | 'blocker';

export type TeamAgentType = AgentType;

/** A run lease is owned the same way an execution run is (`type:id`). */
export type TeamOwner = ExecutionOwner;

// ---------------------------------------------------------------------------
// Records returned by the persistence layer
// ---------------------------------------------------------------------------

export interface TeamRunRecord {
  id: string;
  workspace: string;
  tigerRoot: string;
  templateId: string | null;
  goal: string | null;
  status: TeamRunStatus;
  owner: TeamOwner;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  seqCursor: number;
  startedAt: string | null;
  endedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamRoleRecord {
  id: string;
  runId: string;
  roleKey: string;
  name: string;
  agentType: TeamAgentType;
  model: string | null;
  effort: string | null;
  permission: string | null;
  canWriteCode: boolean;
  requiredForSignoff: boolean;
  status: string;
  systemPrompt: string | null;
  terminalId: string | null;
  config: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMessageRecord {
  id: string;
  runId: string;
  seq: number;
  turnId: string | null;
  fromKind: TeamMessageFromKind;
  fromRole: string | null;
  toRole: string | null;
  channel: string | null;
  kind: TeamMessageKind;
  body: string;
  refs: unknown;
  createdAt: string;
}

export interface TeamTurnRecord {
  id: string;
  runId: string;
  roleKey: string | null;
  ordinal: number;
  status: string;
  promptPath: string | null;
  outputPath: string | null;
  markerPath: string | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamDirectiveRecord {
  id: string;
  runId: string;
  targetRole: string | null;
  body: string;
  status: string;
  createdAt: string;
  deliveredAt: string | null;
}

export interface TeamVerificationRecord {
  id: string;
  runId: string;
  roleKey: string | null;
  kind: string | null;
  passed: boolean;
  summary: string | null;
  details: unknown;
  createdAt: string;
}

export interface TeamSignoffRecord {
  runId: string;
  roleKey: string;
  signedOff: boolean;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoadedTeamRun {
  run: TeamRunRecord;
  roles: TeamRoleRecord[];
  turns: TeamTurnRecord[];
  directives: TeamDirectiveRecord[];
  verifications: TeamVerificationRecord[];
  signoffs: TeamSignoffRecord[];
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateTeamRunInput {
  workspace: string;
  tigerRoot: string;
  owner: TeamOwner;
  ttlMs: number;
  id?: string;
  templateId?: string | null;
  goal?: string | null;
  status?: TeamRunStatus;
}

export interface TeamRoleInput {
  id?: string;
  roleKey: string;
  name: string;
  agentType: TeamAgentType;
  model?: string | null;
  effort?: string | null;
  permission?: string | null;
  canWriteCode?: boolean;
  requiredForSignoff?: boolean;
  status?: string;
  systemPrompt?: string | null;
  terminalId?: string | null;
  config?: unknown;
}

export interface AppendTeamMessageInput {
  runId: string;
  id?: string;
  turnId?: string | null;
  fromKind: TeamMessageFromKind;
  fromRole?: string | null;
  toRole?: string | null;
  channel?: string | null;
  kind: TeamMessageKind;
  body: string;
  refs?: unknown;
}

export interface TeamTurnInput {
  id?: string;
  runId: string;
  roleKey?: string | null;
  ordinal?: number;
  status: string;
  promptPath?: string | null;
  outputPath?: string | null;
  markerPath?: string | null;
  error?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

export interface TeamDirectiveInput {
  id?: string;
  runId: string;
  targetRole?: string | null;
  body: string;
  status?: string;
  deliveredAt?: string | null;
}

export interface TeamVerificationInput {
  id?: string;
  runId: string;
  roleKey?: string | null;
  kind?: string | null;
  passed: boolean;
  summary?: string | null;
  details?: unknown;
}

export interface TeamSignoffInput {
  runId: string;
  roleKey: string;
  signedOff?: boolean;
  summary?: string | null;
}

export interface TeamLeaseConflict {
  runId: string;
  leaseOwner: string;
  leaseExpiresAt: string | null;
}

export type TeamLeaseAcquireResult =
  | { ok: true; runId: string; leaseOwner: string; leaseExpiresAt: string }
  | { ok: false; conflict: TeamLeaseConflict };

export interface TeamReconcileInput {
  workspace: string;
  owner: TeamOwner;
  ttlMs: number;
}

export interface TeamReconcileResult {
  interruptedRuns: number;
  interruptedRoles: number;
  interruptedTurns: number;
}

// ---------------------------------------------------------------------------
// Interface — mirrors the `ExecutionPersistence` shape
// ---------------------------------------------------------------------------

export interface TeamPersistence {
  init(): Promise<void>;
  createRun(input: CreateTeamRunInput): Promise<TeamRunRecord>;
  acquireRunLease(runId: string, owner: TeamOwner, ttlMs: number): Promise<TeamLeaseAcquireResult>;
  refreshRunLease(runId: string, owner: TeamOwner, ttlMs: number): Promise<void>;
  finishRun(runId: string, status: TeamRunStatus, message?: string): Promise<void>;
  saveRole(runId: string, role: TeamRoleInput): Promise<TeamRoleRecord>;
  saveRoles(runId: string, roles: TeamRoleInput[]): Promise<TeamRoleRecord[]>;
  appendMessage(input: AppendTeamMessageInput): Promise<TeamMessageRecord>;
  listMessages(runId: string, afterSeq?: number, limit?: number): Promise<TeamMessageRecord[]>;
  recordTurn(input: TeamTurnInput): Promise<TeamTurnRecord>;
  recordDirective(input: TeamDirectiveInput): Promise<TeamDirectiveRecord>;
  recordVerification(input: TeamVerificationInput): Promise<TeamVerificationRecord>;
  recordSignoff(input: TeamSignoffInput): Promise<TeamSignoffRecord>;
  loadRun(runId: string): Promise<LoadedTeamRun | null>;
  reconcileTeamOnBoot(input: TeamReconcileInput): Promise<TeamReconcileResult>;
}

// ---------------------------------------------------------------------------
// Migration — registered in `db/migrate.ts` (mirrors EXECUTION_*_MIGRATION)
// ---------------------------------------------------------------------------

const TEAM_MIGRATION_ID = '20260618_team_runs';

const TEAM_MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS team_runs (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    workspace_path VARCHAR(1024) NOT NULL,
    tiger_root VARCHAR(1024) NOT NULL,
    template_id VARCHAR(64) NULL,
    goal MEDIUMTEXT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'running',
    owner_type VARCHAR(32) NOT NULL,
    owner_id VARCHAR(191) NOT NULL,
    attempts INT NOT NULL DEFAULT 1,
    lease_owner VARCHAR(191) NULL,
    lease_expires_at DATETIME(3) NULL,
    seq_cursor BIGINT NOT NULL DEFAULT 0,
    started_at DATETIME(3) NULL,
    ended_at DATETIME(3) NULL,
    last_error TEXT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_team_runs_workspace_status (workspace_path(191), status),
    INDEX idx_team_runs_lease (lease_owner, lease_expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS team_roles (
    id VARCHAR(255) NOT NULL PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL,
    role_key VARCHAR(128) NOT NULL,
    name VARCHAR(191) NOT NULL,
    agent_type VARCHAR(16) NOT NULL,
    model VARCHAR(128) NULL,
    effort VARCHAR(32) NULL,
    permission VARCHAR(64) NULL,
    can_write_code TINYINT(1) NOT NULL DEFAULT 0,
    required_for_signoff TINYINT(1) NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'idle',
    system_prompt MEDIUMTEXT NULL,
    terminal_id VARCHAR(64) NULL,
    config_json JSON NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_team_roles_run_role (run_id, role_key),
    INDEX idx_team_roles_run (run_id),
    CONSTRAINT fk_team_roles_run FOREIGN KEY (run_id) REFERENCES team_runs(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS team_messages (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL,
    seq BIGINT NOT NULL,
    turn_id VARCHAR(64) NULL,
    from_kind VARCHAR(16) NOT NULL,
    from_role VARCHAR(128) NULL,
    to_role VARCHAR(128) NULL,
    channel VARCHAR(64) NULL,
    kind VARCHAR(32) NOT NULL,
    body MEDIUMTEXT NOT NULL,
    refs_json JSON NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_team_messages_run_seq (run_id, seq),
    INDEX idx_team_messages_run_seq (run_id, seq),
    INDEX idx_team_messages_turn (turn_id),
    CONSTRAINT fk_team_messages_run FOREIGN KEY (run_id) REFERENCES team_runs(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS team_turns (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL,
    role_key VARCHAR(128) NULL,
    ordinal INT NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL,
    prompt_path VARCHAR(2048) NULL,
    output_path VARCHAR(2048) NULL,
    marker_path VARCHAR(2048) NULL,
    error TEXT NULL,
    started_at DATETIME(3) NULL,
    ended_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_team_turns_run (run_id, ordinal),
    CONSTRAINT fk_team_turns_run FOREIGN KEY (run_id) REFERENCES team_runs(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS team_directives (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL,
    target_role VARCHAR(128) NULL,
    body MEDIUMTEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    delivered_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_team_directives_run (run_id, created_at),
    CONSTRAINT fk_team_directives_run FOREIGN KEY (run_id) REFERENCES team_runs(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS team_signoffs (
    run_id VARCHAR(64) NOT NULL,
    role_key VARCHAR(128) NOT NULL,
    signed_off TINYINT(1) NOT NULL DEFAULT 1,
    summary MEDIUMTEXT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (run_id, role_key),
    INDEX idx_team_signoffs_run (run_id),
    CONSTRAINT fk_team_signoffs_run FOREIGN KEY (run_id) REFERENCES team_runs(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS team_verifications (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL,
    role_key VARCHAR(128) NULL,
    kind VARCHAR(64) NULL,
    passed TINYINT(1) NOT NULL DEFAULT 0,
    summary MEDIUMTEXT NULL,
    details_json JSON NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_team_verifications_run (run_id, created_at),
    CONSTRAINT fk_team_verifications_run FOREIGN KEY (run_id) REFERENCES team_runs(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS team_templates (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(191) NOT NULL,
    description TEXT NULL,
    kind VARCHAR(16) NOT NULL DEFAULT 'team',
    definition_json JSON NOT NULL,
    builtin TINYINT(1) NOT NULL DEFAULT 0,
    version INT NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    archived_at DATETIME(3) NULL,
    UNIQUE KEY uq_team_templates_name (name),
    INDEX idx_team_templates_kind (kind),
    INDEX idx_team_templates_archived (archived_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

/** Idempotent migration appended to the central `MIGRATIONS` array in `db/migrate.ts`. */
export const TEAM_MIGRATION = {
  id: TEAM_MIGRATION_ID,
  statements: TEAM_MIGRATION_STATEMENTS,
};

// ---------------------------------------------------------------------------
// Corrective migration for `team_templates` (mirrors the run_templates shape).
//
// The original `team_templates` table shipped inside `20260618_team_runs` with a
// `kind` / `definition_json (JSON NOT NULL)` shape that never matched
// `MySqlTeamTemplateRepository` (repositories/team-templates.ts), which reads and
// writes `roles_json`, `source_kind` and `source_key` and never supplies
// `definition_json`. Every DB-backed team-template operation therefore failed at
// runtime ("Unknown column 'roles_json'" / missing NOT NULL `definition_json`).
//
// `20260618_team_runs` is treated as immutable (it may already be applied), so the
// shape is corrected under a new migration id rather than by editing it. The table
// holds no data worth preserving: the repository could never persist a row through
// the broken schema, and built-ins are re-seeded on every service init via
// `upsertBuiltin`. Dropping and recreating is therefore safe and yields the
// run_templates-style shape on both fresh and previously-migrated databases.
// ---------------------------------------------------------------------------

const TEAM_TEMPLATES_MIGRATION_ID = '20260618_team_templates_columns';

const TEAM_TEMPLATES_MIGRATION_STATEMENTS = [
  `DROP TABLE IF EXISTS team_templates`,
  `CREATE TABLE IF NOT EXISTS team_templates (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(191) NOT NULL,
    description TEXT NULL,
    roles_json JSON NOT NULL,
    builtin TINYINT(1) NOT NULL DEFAULT 0,
    version INT NOT NULL DEFAULT 1,
    source_kind VARCHAR(32) NOT NULL DEFAULT 'custom',
    source_key VARCHAR(512) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    archived_at DATETIME(3) NULL,
    UNIQUE KEY uq_team_templates_name (name),
    UNIQUE KEY uq_team_templates_source_key (source_key),
    INDEX idx_team_templates_archived (archived_at),
    INDEX idx_team_templates_builtin (builtin)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

/** Corrects the `team_templates` columns to match `MySqlTeamTemplateRepository`. */
export const TEAM_TEMPLATES_MIGRATION = {
  id: TEAM_TEMPLATES_MIGRATION_ID,
  statements: TEAM_TEMPLATES_MIGRATION_STATEMENTS,
};

/** Ordered team migrations applied by both `migrate()` and `MySqlTeamPersistence.ensureSchema`. */
const TEAM_MIGRATIONS = [TEAM_MIGRATION, TEAM_TEMPLATES_MIGRATION];

// ---------------------------------------------------------------------------
// Noop implementation — used when persistence is disabled (no DB configured)
// ---------------------------------------------------------------------------

export class NoopTeamPersistence implements TeamPersistence {
  async init(): Promise<void> {}

  async createRun(input: CreateTeamRunInput): Promise<TeamRunRecord> {
    return emptyRunRecord(input);
  }

  async acquireRunLease(runId: string, owner: TeamOwner, ttlMs: number): Promise<TeamLeaseAcquireResult> {
    return { ok: true, runId, leaseOwner: ownerKey(owner), leaseExpiresAt: leaseExpiresAt(ttlMs) };
  }

  async refreshRunLease(): Promise<void> {}
  async finishRun(): Promise<void> {}

  async saveRole(runId: string, role: TeamRoleInput): Promise<TeamRoleRecord> {
    return roleRecordFromInput(runId, role);
  }

  async saveRoles(runId: string, roles: TeamRoleInput[]): Promise<TeamRoleRecord[]> {
    return roles.map((role) => roleRecordFromInput(runId, role));
  }

  async appendMessage(input: AppendTeamMessageInput): Promise<TeamMessageRecord> {
    return messageRecordFromInput(input, 1);
  }

  async listMessages(): Promise<TeamMessageRecord[]> {
    return [];
  }

  async recordTurn(input: TeamTurnInput): Promise<TeamTurnRecord> {
    return turnRecordFromInput(input);
  }

  async recordDirective(input: TeamDirectiveInput): Promise<TeamDirectiveRecord> {
    return directiveRecordFromInput(input);
  }

  async recordVerification(input: TeamVerificationInput): Promise<TeamVerificationRecord> {
    return verificationRecordFromInput(input);
  }

  async recordSignoff(input: TeamSignoffInput): Promise<TeamSignoffRecord> {
    return signoffRecordFromInput(input);
  }

  async loadRun(): Promise<LoadedTeamRun | null> {
    return null;
  }

  async reconcileTeamOnBoot(): Promise<TeamReconcileResult> {
    return { interruptedRuns: 0, interruptedRoles: 0, interruptedTurns: 0 };
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation — full fidelity, used by tests and DB-less runs
// ---------------------------------------------------------------------------

export class MemoryTeamPersistence implements TeamPersistence {
  readonly runs = new Map<string, TeamRunRecord>();
  readonly roles = new Map<string, TeamRoleRecord[]>();
  readonly messages = new Map<string, TeamMessageRecord[]>();
  readonly turns = new Map<string, TeamTurnRecord[]>();
  readonly directives = new Map<string, TeamDirectiveRecord[]>();
  readonly verifications = new Map<string, TeamVerificationRecord[]>();
  readonly signoffs = new Map<string, Map<string, TeamSignoffRecord>>();

  async init(): Promise<void> {}

  async createRun(input: CreateTeamRunInput): Promise<TeamRunRecord> {
    const record = emptyRunRecord(input);
    this.runs.set(record.id, record);
    return clone(record);
  }

  async acquireRunLease(runId: string, owner: TeamOwner, ttlMs: number): Promise<TeamLeaseAcquireResult> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`team run not found: ${runId}`);
    const leaseOwner = ownerKey(owner);
    if (run.leaseOwner && run.leaseOwner !== leaseOwner && leaseIsActive(run.leaseExpiresAt)) {
      return { ok: false, conflict: { runId, leaseOwner: run.leaseOwner, leaseExpiresAt: run.leaseExpiresAt } };
    }
    const expires = leaseExpiresAt(ttlMs);
    run.leaseOwner = leaseOwner;
    run.leaseExpiresAt = expires;
    run.updatedAt = nowIso();
    return { ok: true, runId, leaseOwner, leaseExpiresAt: expires };
  }

  async refreshRunLease(runId: string, owner: TeamOwner, ttlMs: number): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.leaseOwner = ownerKey(owner);
    run.leaseExpiresAt = leaseExpiresAt(ttlMs);
    run.updatedAt = nowIso();
  }

  async finishRun(runId: string, status: TeamRunStatus, message?: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = status;
    run.lastError = message ?? run.lastError;
    run.leaseOwner = null;
    run.leaseExpiresAt = null;
    run.endedAt = nowIso();
    run.updatedAt = nowIso();
  }

  async saveRole(runId: string, role: TeamRoleInput): Promise<TeamRoleRecord> {
    const record = roleRecordFromInput(runId, role);
    const list = this.roles.get(runId) ?? [];
    const idx = list.findIndex((r) => r.roleKey === record.roleKey);
    if (idx >= 0) {
      record.createdAt = list[idx]!.createdAt;
      list[idx] = record;
    } else {
      list.push(record);
    }
    this.roles.set(runId, list);
    return clone(record);
  }

  async saveRoles(runId: string, roles: TeamRoleInput[]): Promise<TeamRoleRecord[]> {
    const out: TeamRoleRecord[] = [];
    for (const role of roles) out.push(await this.saveRole(runId, role));
    return out;
  }

  async appendMessage(input: AppendTeamMessageInput): Promise<TeamMessageRecord> {
    const run = this.runs.get(input.runId);
    if (!run) throw new Error(`team run not found: ${input.runId}`);
    run.seqCursor += 1;
    run.updatedAt = nowIso();
    const record = messageRecordFromInput(input, run.seqCursor);
    const list = this.messages.get(input.runId) ?? [];
    list.push(record);
    this.messages.set(input.runId, list);
    return clone(record);
  }

  async listMessages(runId: string, afterSeq = 0, limit?: number): Promise<TeamMessageRecord[]> {
    const list = (this.messages.get(runId) ?? [])
      .filter((m) => m.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .map(clone);
    return typeof limit === 'number' ? list.slice(0, Math.max(0, limit)) : list;
  }

  async recordTurn(input: TeamTurnInput): Promise<TeamTurnRecord> {
    const record = turnRecordFromInput(input);
    const list = this.turns.get(input.runId) ?? [];
    const idx = list.findIndex((t) => t.id === record.id);
    if (idx >= 0) {
      record.createdAt = list[idx]!.createdAt;
      record.ordinal = input.ordinal ?? list[idx]!.ordinal;
      list[idx] = record;
    } else {
      list.push(record);
    }
    this.turns.set(input.runId, list);
    return clone(record);
  }

  async recordDirective(input: TeamDirectiveInput): Promise<TeamDirectiveRecord> {
    const record = directiveRecordFromInput(input);
    const list = this.directives.get(input.runId) ?? [];
    list.push(record);
    this.directives.set(input.runId, list);
    return clone(record);
  }

  async recordVerification(input: TeamVerificationInput): Promise<TeamVerificationRecord> {
    const record = verificationRecordFromInput(input);
    const list = this.verifications.get(input.runId) ?? [];
    list.push(record);
    this.verifications.set(input.runId, list);
    return clone(record);
  }

  async recordSignoff(input: TeamSignoffInput): Promise<TeamSignoffRecord> {
    const record = signoffRecordFromInput(input);
    const byRole = this.signoffs.get(input.runId) ?? new Map<string, TeamSignoffRecord>();
    const prev = byRole.get(input.roleKey);
    if (prev) record.createdAt = prev.createdAt;
    byRole.set(input.roleKey, record);
    this.signoffs.set(input.runId, byRole);
    return clone(record);
  }

  async loadRun(runId: string): Promise<LoadedTeamRun | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    return {
      run: clone(run),
      roles: (this.roles.get(runId) ?? []).map(clone),
      turns: (this.turns.get(runId) ?? []).slice().sort((a, b) => a.ordinal - b.ordinal).map(clone),
      directives: (this.directives.get(runId) ?? []).map(clone),
      verifications: (this.verifications.get(runId) ?? []).map(clone),
      signoffs: [...(this.signoffs.get(runId)?.values() ?? [])].map(clone),
    };
  }

  async reconcileTeamOnBoot(input: TeamReconcileInput): Promise<TeamReconcileResult> {
    const result: TeamReconcileResult = { interruptedRuns: 0, interruptedRoles: 0, interruptedTurns: 0 };
    const currentOwner = ownerKey(input.owner);
    for (const run of this.runs.values()) {
      if (run.workspace !== input.workspace || run.status !== 'running') continue;
      if (!leaseIsStale(run.leaseOwner, run.leaseExpiresAt, currentOwner)) continue;
      run.status = 'interrupted';
      run.lastError ??= 'Interrupted by backend restart before completion.';
      run.leaseOwner = null;
      run.leaseExpiresAt = null;
      run.endedAt = nowIso();
      run.updatedAt = nowIso();
      result.interruptedRuns += 1;
      for (const role of this.roles.get(run.id) ?? []) {
        if (isActiveRoleStatus(role.status)) {
          role.status = 'interrupted';
          role.updatedAt = nowIso();
          result.interruptedRoles += 1;
        }
      }
      for (const turn of this.turns.get(run.id) ?? []) {
        if (isActiveTurnStatus(turn.status)) {
          turn.status = 'interrupted';
          turn.error ??= 'Interrupted by backend restart before completion.';
          turn.endedAt = nowIso();
          turn.updatedAt = nowIso();
          result.interruptedTurns += 1;
        }
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// MySQL implementation — reuses `db/pool.ts`, mirrors MySqlExecutionPersistence
// ---------------------------------------------------------------------------

export class MySqlTeamPersistence implements TeamPersistence {
  private pool: Pool | null = null;
  private initialized = false;

  constructor(pool?: Pool) {
    this.pool = pool ?? null;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.pool ??= await getDbPool();
    await this.ensureSchema();
    this.initialized = true;
  }

  async createRun(input: CreateTeamRunInput): Promise<TeamRunRecord> {
    await this.init();
    const record = emptyRunRecord(input);
    await this.exec(
      `INSERT INTO team_runs
        (id, workspace_path, tiger_root, template_id, goal, status, owner_type, owner_id, attempts,
         lease_owner, lease_expires_at, seq_cursor, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?)`,
      [
        record.id,
        record.workspace,
        record.tigerRoot,
        record.templateId,
        record.goal,
        record.status,
        record.owner.type,
        record.owner.id,
        record.leaseOwner,
        sqlDate(record.leaseExpiresAt),
        sqlDate(record.startedAt),
      ],
    );
    return record;
  }

  async acquireRunLease(runId: string, owner: TeamOwner, ttlMs: number): Promise<TeamLeaseAcquireResult> {
    await this.init();
    const leaseOwner = ownerKey(owner);
    return this.transaction(async (conn) => {
      const [rows] = await conn.execute<TeamRunRow[]>(`SELECT * FROM team_runs WHERE id = ? FOR UPDATE`, [runId]);
      const row = rows[0];
      if (!row) throw new Error(`team run not found: ${runId}`);
      if (row.lease_owner && row.lease_owner !== leaseOwner && leaseIsActive(dateIso(row.lease_expires_at))) {
        return {
          ok: false,
          conflict: { runId, leaseOwner: row.lease_owner, leaseExpiresAt: dateIso(row.lease_expires_at) },
        };
      }
      const expires = leaseExpiresAt(ttlMs);
      await conn.execute<ResultSetHeader>(
        `UPDATE team_runs SET lease_owner = ?, lease_expires_at = ? WHERE id = ?`,
        [leaseOwner, sqlDate(expires), runId],
      );
      return { ok: true, runId, leaseOwner, leaseExpiresAt: expires };
    });
  }

  async refreshRunLease(runId: string, owner: TeamOwner, ttlMs: number): Promise<void> {
    await this.init();
    await this.exec(`UPDATE team_runs SET lease_owner = ?, lease_expires_at = ? WHERE id = ?`, [
      ownerKey(owner),
      sqlDate(leaseExpiresAt(ttlMs)),
      runId,
    ]);
  }

  async finishRun(runId: string, status: TeamRunStatus, message?: string): Promise<void> {
    await this.init();
    await this.exec(
      `UPDATE team_runs
       SET status = ?, ended_at = ?, lease_owner = NULL, lease_expires_at = NULL,
           last_error = COALESCE(?, last_error)
       WHERE id = ?`,
      [status, new Date(), message ?? null, runId],
    );
  }

  async saveRole(runId: string, role: TeamRoleInput): Promise<TeamRoleRecord> {
    await this.init();
    const record = roleRecordFromInput(runId, role);
    await this.exec(
      `INSERT INTO team_roles
        (id, run_id, role_key, name, agent_type, model, effort, permission, can_write_code,
         required_for_signoff, status, system_prompt, terminal_id, config_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         agent_type = VALUES(agent_type),
         model = VALUES(model),
         effort = VALUES(effort),
         permission = VALUES(permission),
         can_write_code = VALUES(can_write_code),
         required_for_signoff = VALUES(required_for_signoff),
         status = VALUES(status),
         system_prompt = VALUES(system_prompt),
         terminal_id = VALUES(terminal_id),
         config_json = VALUES(config_json)`,
      [
        record.id,
        record.runId,
        record.roleKey,
        record.name,
        record.agentType,
        record.model,
        record.effort,
        record.permission,
        record.canWriteCode ? 1 : 0,
        record.requiredForSignoff ? 1 : 0,
        record.status,
        record.systemPrompt,
        record.terminalId,
        jsonOrNull(record.config),
      ],
    );
    return record;
  }

  async saveRoles(runId: string, roles: TeamRoleInput[]): Promise<TeamRoleRecord[]> {
    const out: TeamRoleRecord[] = [];
    for (const role of roles) out.push(await this.saveRole(runId, role));
    return out;
  }

  async appendMessage(input: AppendTeamMessageInput): Promise<TeamMessageRecord> {
    await this.init();
    return this.transaction(async (conn) => {
      // Atomic, strictly-increasing per-run sequence via the LAST_INSERT_ID() trick.
      const [upd] = await conn.execute<ResultSetHeader>(
        `UPDATE team_runs SET seq_cursor = LAST_INSERT_ID(seq_cursor + 1) WHERE id = ?`,
        [input.runId],
      );
      if (upd.affectedRows === 0) throw new Error(`team run not found: ${input.runId}`);
      const seq = Number(upd.insertId);
      const record = messageRecordFromInput(input, seq);
      await conn.execute<ResultSetHeader>(
        `INSERT INTO team_messages
          (id, run_id, seq, turn_id, from_kind, from_role, to_role, channel, kind, body, refs_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.runId,
          record.seq,
          record.turnId,
          record.fromKind,
          record.fromRole,
          record.toRole,
          record.channel,
          record.kind,
          record.body,
          jsonOrNull(record.refs),
          sqlDate(record.createdAt),
        ],
      );
      return record;
    });
  }

  async listMessages(runId: string, afterSeq = 0, limit?: number): Promise<TeamMessageRecord[]> {
    await this.init();
    const cap = typeof limit === 'number' ? Math.max(0, Math.floor(limit)) : 1000;
    const rows = await this.rows<TeamMessageRow[]>(
      `SELECT id, run_id, seq, turn_id, from_kind, from_role, to_role, channel, kind, body, refs_json, created_at
       FROM team_messages
       WHERE run_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
      [runId, afterSeq, cap],
    );
    return rows.map(messageFromRow);
  }

  async recordTurn(input: TeamTurnInput): Promise<TeamTurnRecord> {
    await this.init();
    const record = turnRecordFromInput(input);
    await this.exec(
      `INSERT INTO team_turns
        (id, run_id, role_key, ordinal, status, prompt_path, output_path, marker_path, error, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         role_key = VALUES(role_key),
         ordinal = VALUES(ordinal),
         status = VALUES(status),
         prompt_path = VALUES(prompt_path),
         output_path = VALUES(output_path),
         marker_path = VALUES(marker_path),
         error = VALUES(error),
         started_at = COALESCE(VALUES(started_at), started_at),
         ended_at = VALUES(ended_at)`,
      [
        record.id,
        record.runId,
        record.roleKey,
        record.ordinal,
        record.status,
        record.promptPath,
        record.outputPath,
        record.markerPath,
        record.error,
        sqlDate(record.startedAt),
        sqlDate(record.endedAt),
      ],
    );
    return record;
  }

  async recordDirective(input: TeamDirectiveInput): Promise<TeamDirectiveRecord> {
    await this.init();
    const record = directiveRecordFromInput(input);
    await this.exec(
      `INSERT INTO team_directives (id, run_id, target_role, body, status, delivered_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.runId,
        record.targetRole,
        record.body,
        record.status,
        sqlDate(record.deliveredAt),
        sqlDate(record.createdAt),
      ],
    );
    return record;
  }

  async recordVerification(input: TeamVerificationInput): Promise<TeamVerificationRecord> {
    await this.init();
    const record = verificationRecordFromInput(input);
    await this.exec(
      `INSERT INTO team_verifications (id, run_id, role_key, kind, passed, summary, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.runId,
        record.roleKey,
        record.kind,
        record.passed ? 1 : 0,
        record.summary,
        jsonOrNull(record.details),
        sqlDate(record.createdAt),
      ],
    );
    return record;
  }

  async recordSignoff(input: TeamSignoffInput): Promise<TeamSignoffRecord> {
    await this.init();
    const record = signoffRecordFromInput(input);
    await this.exec(
      `INSERT INTO team_signoffs (run_id, role_key, signed_off, summary)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         signed_off = VALUES(signed_off),
         summary = VALUES(summary)`,
      [record.runId, record.roleKey, record.signedOff ? 1 : 0, record.summary],
    );
    return record;
  }

  async loadRun(runId: string): Promise<LoadedTeamRun | null> {
    await this.init();
    const runRows = await this.rows<TeamRunRow[]>(`SELECT * FROM team_runs WHERE id = ? LIMIT 1`, [runId]);
    const runRow = runRows[0];
    if (!runRow) return null;
    const [roleRows, turnRows, directiveRows, verificationRows, signoffRows] = await Promise.all([
      this.rows<TeamRoleRow[]>(`SELECT * FROM team_roles WHERE run_id = ? ORDER BY role_key ASC`, [runId]),
      this.rows<TeamTurnRow[]>(`SELECT * FROM team_turns WHERE run_id = ? ORDER BY ordinal ASC, created_at ASC`, [runId]),
      this.rows<TeamDirectiveRow[]>(`SELECT * FROM team_directives WHERE run_id = ? ORDER BY created_at ASC`, [runId]),
      this.rows<TeamVerificationRow[]>(`SELECT * FROM team_verifications WHERE run_id = ? ORDER BY created_at ASC`, [runId]),
      this.rows<TeamSignoffRow[]>(`SELECT * FROM team_signoffs WHERE run_id = ? ORDER BY role_key ASC`, [runId]),
    ]);
    return {
      run: runFromRow(runRow),
      roles: roleRows.map(roleFromRow),
      turns: turnRows.map(turnFromRow),
      directives: directiveRows.map(directiveFromRow),
      verifications: verificationRows.map(verificationFromRow),
      signoffs: signoffRows.map(signoffFromRow),
    };
  }

  async reconcileTeamOnBoot(input: TeamReconcileInput): Promise<TeamReconcileResult> {
    await this.init();
    const now = new Date();
    const currentOwner = ownerKey(input.owner);
    const runs = await this.rows<TeamRunRow[]>(
      `SELECT id, lease_owner, lease_expires_at FROM team_runs WHERE workspace_path = ? AND status = 'running'`,
      [input.workspace],
    );
    const staleRunIds = runs
      .filter((r) => leaseIsStale(r.lease_owner, dateIso(r.lease_expires_at), currentOwner))
      .map((r) => r.id);
    if (staleRunIds.length === 0) return { interruptedRuns: 0, interruptedRoles: 0, interruptedTurns: 0 };
    const ph = staleRunIds.map(() => '?').join(',');
    const interruptedRuns = (
      await this.exec(
        `UPDATE team_runs
         SET status = 'interrupted', ended_at = ?, lease_owner = NULL, lease_expires_at = NULL,
             last_error = COALESCE(last_error, 'Interrupted by backend restart before completion.')
         WHERE id IN (${ph}) AND status = 'running'`,
        [now, ...staleRunIds],
      )
    ).affectedRows;
    const interruptedRoles = (
      await this.exec(
        `UPDATE team_roles SET status = 'interrupted'
         WHERE run_id IN (${ph}) AND status IN ('active', 'working', 'running', 'waiting', 'starting')`,
        staleRunIds,
      )
    ).affectedRows;
    const interruptedTurns = (
      await this.exec(
        `UPDATE team_turns
         SET status = 'interrupted', ended_at = ?,
             error = COALESCE(error, 'Interrupted by backend restart before completion.')
         WHERE run_id IN (${ph}) AND status IN ('pending', 'running', 'waiting', 'starting')`,
        [now, ...staleRunIds],
      )
    ).affectedRows;
    return { interruptedRuns, interruptedRoles, interruptedTurns };
  }

  private async ensureSchema(): Promise<void> {
    // Self-sufficient, idempotent schema bootstrap guarded by `schema_migrations`,
    // mirroring MySqlExecutionPersistence.applyMigration. The central `migrate()`
    // registers the same migration ids, so whichever runs first wins; the other no-ops.
    await this.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        id VARCHAR(128) NOT NULL PRIMARY KEY,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      [],
    );
    for (const migration of TEAM_MIGRATIONS) {
      const existing = await this.rows<MigrationIdRow[]>(`SELECT id FROM schema_migrations WHERE id = ? LIMIT 1`, [
        migration.id,
      ]);
      if (existing.length > 0) continue;
      for (const statement of migration.statements) await this.exec(statement, []);
      await this.exec(`INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`, [migration.id, new Date()]);
    }
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

  private async rows<T extends RowDataPacket[]>(sql: string, values: unknown[]): Promise<T> {
    const [rows] = await this.pool!.execute<T>(sql, values as Parameters<Pool['execute']>[1]);
    return rows;
  }

  private async exec(sql: string, values: unknown[]): Promise<ResultSetHeader> {
    const [result] = await this.pool!.execute<ResultSetHeader>(sql, values as Parameters<Pool['execute']>[1]);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Record builders (shared by Noop / Memory / MySQL)
// ---------------------------------------------------------------------------

function emptyRunRecord(input: CreateTeamRunInput): TeamRunRecord {
  const now = nowIso();
  return {
    id: input.id ?? nanoid(),
    workspace: input.workspace,
    tigerRoot: input.tigerRoot,
    templateId: input.templateId ?? null,
    goal: input.goal ?? null,
    status: input.status ?? 'running',
    owner: input.owner,
    attempts: 1,
    leaseOwner: ownerKey(input.owner),
    leaseExpiresAt: leaseExpiresAt(input.ttlMs),
    seqCursor: 0,
    startedAt: now,
    endedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

function roleRecordFromInput(runId: string, role: TeamRoleInput): TeamRoleRecord {
  const now = nowIso();
  return {
    id: role.id ?? `${runId}:${role.roleKey}`,
    runId,
    roleKey: role.roleKey,
    name: role.name,
    agentType: role.agentType,
    model: role.model ?? null,
    effort: role.effort ?? null,
    permission: role.permission ?? null,
    canWriteCode: role.canWriteCode ?? false,
    requiredForSignoff: role.requiredForSignoff ?? false,
    status: role.status ?? 'idle',
    systemPrompt: role.systemPrompt ?? null,
    terminalId: role.terminalId ?? null,
    config: role.config ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

function messageRecordFromInput(input: AppendTeamMessageInput, seq: number): TeamMessageRecord {
  return {
    id: input.id ?? nanoid(),
    runId: input.runId,
    seq,
    turnId: input.turnId ?? null,
    fromKind: input.fromKind,
    fromRole: input.fromRole ?? null,
    toRole: input.toRole ?? null,
    channel: input.channel ?? null,
    kind: input.kind,
    body: input.body,
    refs: input.refs ?? null,
    createdAt: nowIso(),
  };
}

function turnRecordFromInput(input: TeamTurnInput): TeamTurnRecord {
  const now = nowIso();
  return {
    id: input.id ?? nanoid(),
    runId: input.runId,
    roleKey: input.roleKey ?? null,
    ordinal: input.ordinal ?? 0,
    status: input.status,
    promptPath: input.promptPath ?? null,
    outputPath: input.outputPath ?? null,
    markerPath: input.markerPath ?? null,
    error: input.error ?? null,
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

function directiveRecordFromInput(input: TeamDirectiveInput): TeamDirectiveRecord {
  return {
    id: input.id ?? nanoid(),
    runId: input.runId,
    targetRole: input.targetRole ?? null,
    body: input.body,
    status: input.status ?? 'pending',
    createdAt: nowIso(),
    deliveredAt: input.deliveredAt ?? null,
  };
}

function verificationRecordFromInput(input: TeamVerificationInput): TeamVerificationRecord {
  return {
    id: input.id ?? nanoid(),
    runId: input.runId,
    roleKey: input.roleKey ?? null,
    kind: input.kind ?? null,
    passed: input.passed,
    summary: input.summary ?? null,
    details: input.details ?? null,
    createdAt: nowIso(),
  };
}

function signoffRecordFromInput(input: TeamSignoffInput): TeamSignoffRecord {
  const now = nowIso();
  return {
    runId: input.runId,
    roleKey: input.roleKey,
    signedOff: input.signedOff ?? true,
    summary: input.summary ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Row → record mappers (MySQL)
// ---------------------------------------------------------------------------

function runFromRow(row: TeamRunRow): TeamRunRecord {
  return {
    id: row.id,
    workspace: row.workspace_path,
    tigerRoot: row.tiger_root,
    templateId: row.template_id ?? null,
    goal: row.goal ?? null,
    status: row.status as TeamRunStatus,
    owner: { type: (row.owner_type as TeamOwner['type']) ?? 'manual', id: row.owner_id ?? '' },
    attempts: row.attempts ?? 1,
    leaseOwner: row.lease_owner ?? null,
    leaseExpiresAt: dateIso(row.lease_expires_at),
    seqCursor: Number(row.seq_cursor ?? 0),
    startedAt: dateIso(row.started_at),
    endedAt: dateIso(row.ended_at),
    lastError: row.last_error ?? null,
    createdAt: dateIso(row.created_at) ?? nowIso(),
    updatedAt: dateIso(row.updated_at) ?? nowIso(),
  };
}

function roleFromRow(row: TeamRoleRow): TeamRoleRecord {
  return {
    id: row.id,
    runId: row.run_id,
    roleKey: row.role_key,
    name: row.name,
    agentType: toAgentTypeOr(row.agent_type, 'claude'),
    model: row.model ?? null,
    effort: row.effort ?? null,
    permission: row.permission ?? null,
    canWriteCode: Boolean(row.can_write_code),
    requiredForSignoff: Boolean(row.required_for_signoff),
    status: row.status,
    systemPrompt: row.system_prompt ?? null,
    terminalId: row.terminal_id ?? null,
    config: parseJson(row.config_json),
    createdAt: dateIso(row.created_at) ?? nowIso(),
    updatedAt: dateIso(row.updated_at) ?? nowIso(),
  };
}

function messageFromRow(row: TeamMessageRow): TeamMessageRecord {
  return {
    id: row.id,
    runId: row.run_id,
    seq: Number(row.seq),
    turnId: row.turn_id ?? null,
    fromKind: row.from_kind as TeamMessageFromKind,
    fromRole: row.from_role ?? null,
    toRole: row.to_role ?? null,
    channel: row.channel ?? null,
    kind: row.kind as TeamMessageKind,
    body: row.body,
    refs: parseJson(row.refs_json),
    createdAt: dateIso(row.created_at) ?? nowIso(),
  };
}

function turnFromRow(row: TeamTurnRow): TeamTurnRecord {
  return {
    id: row.id,
    runId: row.run_id,
    roleKey: row.role_key ?? null,
    ordinal: row.ordinal ?? 0,
    status: row.status,
    promptPath: row.prompt_path ?? null,
    outputPath: row.output_path ?? null,
    markerPath: row.marker_path ?? null,
    error: row.error ?? null,
    startedAt: dateIso(row.started_at),
    endedAt: dateIso(row.ended_at),
    createdAt: dateIso(row.created_at) ?? nowIso(),
    updatedAt: dateIso(row.updated_at) ?? nowIso(),
  };
}

function directiveFromRow(row: TeamDirectiveRow): TeamDirectiveRecord {
  return {
    id: row.id,
    runId: row.run_id,
    targetRole: row.target_role ?? null,
    body: row.body,
    status: row.status,
    createdAt: dateIso(row.created_at) ?? nowIso(),
    deliveredAt: dateIso(row.delivered_at),
  };
}

function verificationFromRow(row: TeamVerificationRow): TeamVerificationRecord {
  return {
    id: row.id,
    runId: row.run_id,
    roleKey: row.role_key ?? null,
    kind: row.kind ?? null,
    passed: Boolean(row.passed),
    summary: row.summary ?? null,
    details: parseJson(row.details_json),
    createdAt: dateIso(row.created_at) ?? nowIso(),
  };
}

function signoffFromRow(row: TeamSignoffRow): TeamSignoffRecord {
  return {
    runId: row.run_id,
    roleKey: row.role_key,
    signedOff: Boolean(row.signed_off),
    summary: row.summary ?? null,
    createdAt: dateIso(row.created_at) ?? nowIso(),
    updatedAt: dateIso(row.updated_at) ?? nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  return structuredClone(value);
}

const nowIso = (): string => new Date().toISOString();

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

function leaseIsActive(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return true;
  const ms = Date.parse(expiresAt);
  return Number.isNaN(ms) ? false : ms > Date.now();
}

function leaseIsStale(leaseOwner: string | null, expiresAt: string | null, currentOwner: string): boolean {
  if (!leaseOwner) return true;
  if (leaseOwner === currentOwner) return false;
  if (!expiresAt) return false;
  const ms = Date.parse(expiresAt);
  return Number.isNaN(ms) ? false : ms <= Date.now();
}

function isActiveRoleStatus(status: string): boolean {
  return status === 'active' || status === 'working' || status === 'running' || status === 'waiting' || status === 'starting';
}

function isActiveTurnStatus(status: string): boolean {
  return status === 'pending' || status === 'running' || status === 'waiting' || status === 'starting';
}

function jsonOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseJson(value: string | object | null | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// MySQL row shapes
// ---------------------------------------------------------------------------

interface MigrationIdRow extends RowDataPacket {
  id: string;
}

interface TeamRunRow extends RowDataPacket {
  id: string;
  workspace_path: string;
  tiger_root: string;
  template_id: string | null;
  goal: string | null;
  status: string;
  owner_type: string | null;
  owner_id: string | null;
  attempts: number | null;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  seq_cursor: number | string | null;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  last_error: string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

interface TeamRoleRow extends RowDataPacket {
  id: string;
  run_id: string;
  role_key: string;
  name: string;
  agent_type: string;
  model: string | null;
  effort: string | null;
  permission: string | null;
  can_write_code: number;
  required_for_signoff: number;
  status: string;
  system_prompt: string | null;
  terminal_id: string | null;
  config_json: string | object | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

interface TeamMessageRow extends RowDataPacket {
  id: string;
  run_id: string;
  seq: number | string;
  turn_id: string | null;
  from_kind: string;
  from_role: string | null;
  to_role: string | null;
  channel: string | null;
  kind: string;
  body: string;
  refs_json: string | object | null;
  created_at: Date | string | null;
}

interface TeamTurnRow extends RowDataPacket {
  id: string;
  run_id: string;
  role_key: string | null;
  ordinal: number | null;
  status: string;
  prompt_path: string | null;
  output_path: string | null;
  marker_path: string | null;
  error: string | null;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

interface TeamDirectiveRow extends RowDataPacket {
  id: string;
  run_id: string;
  target_role: string | null;
  body: string;
  status: string;
  delivered_at: Date | string | null;
  created_at: Date | string | null;
}

interface TeamVerificationRow extends RowDataPacket {
  id: string;
  run_id: string;
  role_key: string | null;
  kind: string | null;
  passed: number;
  summary: string | null;
  details_json: string | object | null;
  created_at: Date | string | null;
}

interface TeamSignoffRow extends RowDataPacket {
  run_id: string;
  role_key: string;
  signed_off: number;
  summary: string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}
