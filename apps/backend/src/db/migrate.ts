import type { Pool } from 'mysql2/promise';
import { getDbPool } from './pool.js';
import { EXECUTION_CHECKPOINT_MIGRATION, EXECUTION_WORKSPACE_LEASE_MIGRATION } from '../orchestrator/persistence.js';
import { TEAM_MIGRATION, TEAM_TEMPLATES_MIGRATION, TEAM_ATTEMPTS_MIGRATION } from '../team/persistence.js';

interface Migration {
  id: string;
  statements: string[];
  /**
   * Optional rollback statements, applied in order inside a single transaction by
   * {@link rollbackLast}. A migration without `down` is considered irreversible and
   * rollback refuses to touch it (so we never silently leave a half-undone schema).
   */
  down?: string[];
}

// Migration ID convention (Epic 8): going forward, IDs are zero-padded to 4 digits and
// contiguous (`0001`..`00NN`). The early IDs below (`003_`, `004_`, `006_`, `008_`, `009_`)
// predate this convention and are intentionally LEFT AS-IS: the `schema_migrations` table
// keys off the exact `id` string, so renumbering an already-applied migration would make the
// runner think it was never applied and re-run its `CREATE TABLE`s on every existing database.
// We standardize new migrations only and never rewrite an applied id. The gaps in the early
// sequence are cosmetic and harmless.

const MIGRATIONS: Migration[] = [
  {
    // Foundational schema bootstrap: a small key/value table for system-level metadata.
    // Domain tables arrive in later, task-scoped migrations below. This first migration
    // gives the pipeline a real, idempotent unit of work to apply and verify.
    id: '0001_init',
    statements: [
      `CREATE TABLE IF NOT EXISTS app_meta (
        \`key\` VARCHAR(191) NOT NULL PRIMARY KEY,
        \`value\` TEXT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      // Record when the schema was first initialized. INSERT IGNORE keeps this idempotent
      // even if the row already exists (defensive; the runner already skips applied versions).
      `INSERT IGNORE INTO app_meta (\`key\`, \`value\`) VALUES ('schema_initialized_at', NOW())`,
    ],
  },
  {
    id: '003_limit_snapshots',
    statements: [
      `CREATE TABLE IF NOT EXISTS limit_snapshots (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        provider VARCHAR(16) NOT NULL,
        window_key VARCHAR(64) NOT NULL,
        label VARCHAR(160) NOT NULL,
        percent_used DECIMAL(5,2) NULL,
        metric_raw JSON NULL,
        reset_text TEXT NULL,
        reset_at DATETIME(3) NULL,
        ok TINYINT(1) NOT NULL DEFAULT 1,
        error TEXT NULL,
        raw_panel MEDIUMTEXT NULL,
        parse_confidence VARCHAR(32) NOT NULL DEFAULT 'unknown',
        checked_at DATETIME(3) NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY idx_limit_snapshots_latest (provider, window_key, checked_at),
        KEY idx_limit_snapshots_provider_checked (provider, checked_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS limit_rules (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        provider VARCHAR(16) NOT NULL,
        window_key VARCHAR(64) NOT NULL DEFAULT 'any',
        threshold_percent DECIMAL(5,2) NOT NULL,
        comparison VARCHAR(16) NOT NULL DEFAULT 'gte',
        action VARCHAR(32) NOT NULL DEFAULT 'block',
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        KEY idx_limit_rules_enabled_provider (enabled, provider)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `INSERT INTO limit_rules (
        id, provider, window_key, threshold_percent, comparison, action, enabled, created_at, updated_at
      ) VALUES (
        'claude-percent-used-90', 'claude', 'any', 90, 'gte', 'block', 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
      )
      ON DUPLICATE KEY UPDATE
        provider = VALUES(provider),
        window_key = VALUES(window_key),
        threshold_percent = VALUES(threshold_percent),
        comparison = VALUES(comparison),
        action = VALUES(action),
        updated_at = UTC_TIMESTAMP(3)`,
    ],
    down: [`DROP TABLE IF EXISTS limit_rules`, `DROP TABLE IF EXISTS limit_snapshots`],
  },
  {
    id: '004_run_templates',
    statements: [
      `CREATE TABLE IF NOT EXISTS run_templates (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        name VARCHAR(160) NOT NULL,
        description TEXT NULL,
        from_stage VARCHAR(64) NULL,
        configs_json JSON NOT NULL,
        builtin TINYINT(1) NOT NULL DEFAULT 0,
        version INT NOT NULL DEFAULT 1,
        source_kind VARCHAR(32) NOT NULL DEFAULT 'custom',
        source_key VARCHAR(512) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        archived_at DATETIME(3) NULL,
        UNIQUE KEY uq_run_templates_name (name),
        UNIQUE KEY uq_run_templates_source_key (source_key),
        KEY idx_run_templates_archived_at (archived_at),
        KEY idx_run_templates_builtin (builtin)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
    down: [`DROP TABLE IF EXISTS run_templates`],
  },
  {
    id: '006_queue',
    statements: [
      `CREATE TABLE IF NOT EXISTS queue_jobs (
        id VARCHAR(64) PRIMARY KEY,
        position INT NOT NULL,
        status VARCHAR(32) NOT NULL,
        priority INT NOT NULL DEFAULT 0,
        provider VARCHAR(16) NOT NULL DEFAULT 'claude',
        workspace_path TEXT NOT NULL,
        project_name VARCHAR(255) NULL,
        prompt MEDIUMTEXT NOT NULL,
        config_snapshot JSON NULL,
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 1,
        blocked_reason TEXT NULL,
        resume_after DATETIME(3) NULL,
        lease_owner VARCHAR(128) NULL,
        lease_expires_at DATETIME(3) NULL,
        current_step VARCHAR(64) NULL,
        started_at DATETIME(3) NULL,
        completed_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        INDEX idx_queue_jobs_dispatch (status, resume_after, priority, position),
        INDEX idx_queue_jobs_lease (lease_owner, lease_expires_at),
        INDEX idx_queue_jobs_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS queue_steps (
        id VARCHAR(64) PRIMARY KEY,
        job_id VARCHAR(64) NOT NULL,
        step_key VARCHAR(64) NOT NULL,
        position INT NOT NULL,
        status VARCHAR(32) NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        error TEXT NULL,
        checkpoint JSON NULL,
        started_at DATETIME(3) NULL,
        completed_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_queue_steps_job_step (job_id, step_key),
        INDEX idx_queue_steps_job_position (job_id, position),
        CONSTRAINT fk_queue_steps_job FOREIGN KEY (job_id) REFERENCES queue_jobs(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS queue_events (
        id VARCHAR(64) PRIMARY KEY,
        job_id VARCHAR(64) NULL,
        type VARCHAR(96) NOT NULL,
        message TEXT NOT NULL,
        payload JSON NULL,
        created_at DATETIME(3) NOT NULL,
        INDEX idx_queue_events_job_created (job_id, created_at),
        INDEX idx_queue_events_type_created (type, created_at),
        CONSTRAINT fk_queue_events_job FOREIGN KEY (job_id) REFERENCES queue_jobs(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS queue_rules (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(191) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        provider VARCHAR(16) NOT NULL,
        window_key VARCHAR(64) NOT NULL DEFAULT 'any',
        metric VARCHAR(64) NOT NULL,
        operator VARCHAR(16) NOT NULL,
        threshold DECIMAL(8,3) NOT NULL,
        action VARCHAR(64) NOT NULL,
        config JSON NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        INDEX idx_queue_rules_enabled_provider (enabled, provider)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `INSERT INTO queue_rules (
        id, name, enabled, provider, window_key, metric, operator, threshold, action, config, created_at, updated_at
      ) VALUES (
        'builtin-claude-usage-gte-90',
        'Claude usage >= 90% pauses queue dispatch',
        1,
        'claude',
        'any',
        'percent_used',
        'gte',
        90,
        'block_dispatch',
        JSON_OBJECT('resumeFrom', 'reset_at'),
        UTC_TIMESTAMP(3),
        UTC_TIMESTAMP(3)
      )
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        provider = VALUES(provider),
        window_key = VALUES(window_key),
        metric = VALUES(metric),
        operator = VALUES(operator),
        threshold = VALUES(threshold),
        action = VALUES(action),
        config = VALUES(config),
        updated_at = UTC_TIMESTAMP(3)`,
    ],
    // Drop children (FK to queue_jobs) before the parent.
    down: [
      `DROP TABLE IF EXISTS queue_rules`,
      `DROP TABLE IF EXISTS queue_events`,
      `DROP TABLE IF EXISTS queue_steps`,
      `DROP TABLE IF EXISTS queue_jobs`,
    ],
  },
  {
    id: '008_prompt_generations',
    statements: [
      `CREATE TABLE IF NOT EXISTS prompt_generations (
        id VARCHAR(32) PRIMARY KEY,
        input_text MEDIUMTEXT NOT NULL,
        output_text MEDIUMTEXT NULL,
        status ENUM('pending', 'running', 'done', 'failed') NOT NULL,
        agent_type VARCHAR(16) NOT NULL,
        model VARCHAR(128) NULL,
        error TEXT NULL,
        project_id VARCHAR(512) NULL,
        terminal_id VARCHAR(64) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        started_at DATETIME(3) NULL,
        completed_at DATETIME(3) NULL,
        INDEX idx_prompt_generations_project_created (project_id, created_at),
        INDEX idx_prompt_generations_status_updated (status, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS prompt_history_events (
        id VARCHAR(32) PRIMARY KEY,
        project_id VARCHAR(512) NULL,
        kind VARCHAR(64) NOT NULL,
        input_text MEDIUMTEXT NULL,
        output_text MEDIUMTEXT NULL,
        generation_id VARCHAR(32) NULL,
        metadata JSON NULL,
        created_at DATETIME(3) NOT NULL,
        INDEX idx_prompt_history_project_created (project_id, created_at),
        INDEX idx_prompt_history_generation (generation_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
    down: [`DROP TABLE IF EXISTS prompt_history_events`, `DROP TABLE IF EXISTS prompt_generations`],
  },
  {
    // Migration 008 originally created these two tables WITHOUT an explicit
    // `DEFAULT CHARSET=utf8mb4` clause (every other table specifies it), so on a server
    // whose default charset is not utf8mb4 they could silently truncate or reject 4-byte
    // characters (emoji, many CJK/supplementary code points). Convert any already-created
    // tables to utf8mb4 to match the rest of the schema. CONVERT TO is a no-op when the
    // table is already utf8mb4_unicode_ci, so this is safe to run on fresh installs too.
    id: '009_prompt_tables_utf8mb4',
    statements: [
      `ALTER TABLE prompt_generations CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      `ALTER TABLE prompt_history_events CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    ],
  },
  EXECUTION_CHECKPOINT_MIGRATION,
  EXECUTION_WORKSPACE_LEASE_MIGRATION,
  TEAM_MIGRATION,
  // Corrects the team_templates columns to match MySqlTeamTemplateRepository.
  // Must run after TEAM_MIGRATION, which creates the original (mismatched) table.
  TEAM_TEMPLATES_MIGRATION,
  // Adds the team_attempts table (vibe-kanban-style Attempt model). Must run after
  // TEAM_MIGRATION, which creates the parent team_runs table it references.
  TEAM_ATTEMPTS_MIGRATION,
];

let migrationRun: Promise<void> | null = null;

export async function migrate(pool: Pool): Promise<void> {
  if (migrationRun) return migrationRun;
  migrationRun = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id VARCHAR(128) PRIMARY KEY,
        applied_at DATETIME(3) NOT NULL
      )
    `);
    for (const migration of MIGRATIONS) {
      const [existing] = await pool.query('SELECT id FROM schema_migrations WHERE id = ? LIMIT 1', [migration.id]);
      if (Array.isArray(existing) && existing.length > 0) continue;
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        for (const statement of migration.statements) await conn.query(statement);
        await conn.query('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
          migration.id,
          toMysqlDate(new Date().toISOString()),
        ]);
        await conn.commit();
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    }
  })();
  return migrationRun;
}

export async function runMigrations(pool?: Pool): Promise<void> {
  await migrate(pool ?? (await getDbPool()));
}

export interface RollbackResult {
  /** The migration id that was rolled back, or null when there was nothing to do. */
  rolledBack: string | null;
  reason?: string;
}

/**
 * Roll back the most-recently-applied migration that we still know how to reverse.
 *
 * Reads the latest `applied_at` row from `schema_migrations`, looks up its `down` statements,
 * runs them inside a transaction, then deletes the `schema_migrations` row (so a later
 * `migrate()` will re-apply it). If the latest applied migration declares no `down`, we refuse
 * rather than silently skipping it — that would leave the recorded version out of sync with the
 * actual schema.
 */
export async function rollbackLast(pool?: Pool): Promise<RollbackResult> {
  const db = pool ?? (await getDbPool());
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(128) PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL
    )
  `);
  const [rows] = await db.query(
    'SELECT id FROM schema_migrations ORDER BY applied_at DESC, id DESC LIMIT 1',
  );
  const latestId = Array.isArray(rows) && rows.length > 0 ? (rows[0] as { id: string }).id : null;
  if (!latestId) return { rolledBack: null, reason: 'no applied migrations' };

  const migration = MIGRATIONS.find((m) => m.id === latestId);
  if (!migration) {
    return { rolledBack: null, reason: `applied migration "${latestId}" is unknown to this build` };
  }
  if (!migration.down || migration.down.length === 0) {
    return { rolledBack: null, reason: `migration "${latestId}" is irreversible (no down steps)` };
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    for (const statement of migration.down) await conn.query(statement);
    await conn.query('DELETE FROM schema_migrations WHERE id = ?', [latestId]);
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
  return { rolledBack: latestId };
}

export function toMysqlDate(iso: string): string {
  return iso.replace('T', ' ').replace('Z', '').slice(0, 23);
}

// CLI: `tsx src/db/migrate.ts [up|down]`. `up` (default) applies pending migrations;
// `down` rolls back the most recent reversible migration.
const isCliEntry = (() => {
  try {
    const entry = process.argv[1] ?? '';
    return import.meta.url === new URL(`file://${entry}`).href || import.meta.url.endsWith(entry.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  const command = (process.argv[2] ?? 'up').toLowerCase();
  const run = async () => {
    const pool = await getDbPool();
    if (command === 'down') {
      const result = await rollbackLast(pool);
      if (result.rolledBack) console.log(`[migrate] rolled back ${result.rolledBack}`);
      else console.log(`[migrate] nothing rolled back: ${result.reason}`);
    } else {
      await migrate(pool);
      console.log('[migrate] migrations up to date');
    }
  };
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
