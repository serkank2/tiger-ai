import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  RunTemplateServiceError,
  type RunTemplateCreate,
  type RunTemplateRepository,
  type RunTemplateUpdate,
} from '../services/run-templates.js';
import type { RunTemplate, StageId, StageRunConfig } from '../orchestrator/types.js';
import { logger } from '../obs/logger.js';

const log = logger.child({ mod: 'repo.run-templates' });

interface RunTemplateRow extends RowDataPacket {
  id: string;
  name: string;
  description: string | null;
  from_stage: string | null;
  configs_json: string | Partial<Record<StageId, StageRunConfig>>;
  builtin: 0 | 1;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
}

function dateIso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseConfigs(value: RunTemplateRow['configs_json'], id?: string): Partial<Record<StageId, StageRunConfig>> {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as Partial<Record<StageId, StageRunConfig>>;
  } catch (err) {
    // A single corrupted configs_json must not throw out of list() and break the whole
    // templates endpoint. Degrade this row to empty configs and log it.
    log.warn('run template configs_json is not valid JSON; using empty configs', {
      id,
      err: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

function rowToTemplate(row: RunTemplateRow): RunTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    fromStage: row.from_stage ? (row.from_stage as StageId) : undefined,
    configs: parseConfigs(row.configs_json, row.id),
    builtin: row.builtin === 1,
    version: row.version,
    createdAt: dateIso(row.created_at) ?? undefined,
    updatedAt: dateIso(row.updated_at) ?? undefined,
    archivedAt: dateIso(row.archived_at),
  };
}

function duplicateError(error: unknown): boolean {
  return (
    !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ER_DUP_ENTRY'
  );
}

function templateConflict(): RunTemplateServiceError {
  return new RunTemplateServiceError(409, 'template name already exists');
}

export class MySqlRunTemplateRepository implements RunTemplateRepository {
  constructor(private readonly pool: Pool) {}

  async list(includeArchived = false): Promise<RunTemplate[]> {
    const [rows] = await this.pool.query<RunTemplateRow[]>(
      `SELECT id, name, description, from_stage, configs_json, builtin, version, created_at, updated_at, archived_at
       FROM run_templates
       ${includeArchived ? '' : 'WHERE archived_at IS NULL'}`,
    );
    return rows.map(rowToTemplate);
  }

  async findByIdOrName(ref: string, includeArchived = false): Promise<RunTemplate | null> {
    const [rows] = await this.pool.execute<RunTemplateRow[]>(
      `SELECT id, name, description, from_stage, configs_json, builtin, version, created_at, updated_at, archived_at
       FROM run_templates
       WHERE (id = ? OR LOWER(name) = LOWER(?)) ${includeArchived ? '' : 'AND archived_at IS NULL'}
       LIMIT 1`,
      [ref, ref],
    );
    return rows[0] ? rowToTemplate(rows[0]) : null;
  }

  async findBySourceKey(sourceKey: string): Promise<RunTemplate | null> {
    const [rows] = await this.pool.execute<RunTemplateRow[]>(
      `SELECT id, name, description, from_stage, configs_json, builtin, version, created_at, updated_at, archived_at
       FROM run_templates
       WHERE source_key = ?
       LIMIT 1`,
      [sourceKey],
    );
    return rows[0] ? rowToTemplate(rows[0]) : null;
  }

  async create(input: RunTemplateCreate): Promise<RunTemplate> {
    const id = input.id;
    if (!id) throw new RunTemplateServiceError(400, 'template id is required');
    try {
      await this.pool.execute(
        `INSERT INTO run_templates
          (id, name, description, from_stage, configs_json, builtin, version, source_kind, source_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.name,
          input.description ?? null,
          input.fromStage ?? null,
          JSON.stringify(input.configs),
          input.builtin === true ? 1 : 0,
          input.version ?? 1,
          input.sourceKind ?? 'custom',
          input.sourceKey ?? null,
        ],
      );
    } catch (error) {
      if (duplicateError(error)) throw templateConflict();
      throw error;
    }
    const created = await this.findByIdOrName(id);
    if (!created) throw new RunTemplateServiceError(500, 'template was not created');
    return created;
  }

  async update(id: string, input: RunTemplateUpdate): Promise<RunTemplate> {
    const current = await this.findByIdOrName(id);
    if (!current) throw new RunTemplateServiceError(404, 'template not found');
    if (current.builtin) throw new RunTemplateServiceError(409, 'built-in templates cannot be edited');
    const currentId = current.id;
    if (!currentId) throw new RunTemplateServiceError(500, 'template id is missing');
    try {
      const [result] = await this.pool.execute<ResultSetHeader>(
        `UPDATE run_templates
         SET name = ?,
             description = ?,
             from_stage = ?,
             configs_json = ?,
             version = version + 1,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND builtin = 0 AND archived_at IS NULL`,
        [
          input.name ?? current.name,
          input.description ?? null,
          input.fromStage ?? null,
          JSON.stringify(input.configs ?? current.configs),
          currentId,
        ],
      );
      if (result.affectedRows === 0) throw new RunTemplateServiceError(404, 'template not found');
    } catch (error) {
      if (duplicateError(error)) throw templateConflict();
      throw error;
    }
    const updated = await this.findByIdOrName(currentId);
    if (!updated) throw new RunTemplateServiceError(404, 'template not found');
    return updated;
  }

  async archive(id: string): Promise<boolean> {
    const current = await this.findByIdOrName(id);
    if (!current) return false;
    if (current.builtin) throw new RunTemplateServiceError(409, 'built-in templates cannot be deleted');
    const currentId = current.id;
    if (!currentId) throw new RunTemplateServiceError(500, 'template id is missing');
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE run_templates
       SET archived_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND builtin = 0 AND archived_at IS NULL`,
      [currentId],
    );
    return result.affectedRows > 0;
  }

  async upsertBuiltin(input: RunTemplateCreate & { id: string; builtin: true }): Promise<void> {
    await this.pool.execute(
      `INSERT INTO run_templates
        (id, name, description, from_stage, configs_json, builtin, version, source_kind, source_key)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         description = VALUES(description),
         from_stage = VALUES(from_stage),
         configs_json = VALUES(configs_json),
         builtin = 1,
         version = VALUES(version),
         source_kind = VALUES(source_kind),
         source_key = VALUES(source_key),
         archived_at = NULL,
         updated_at = CURRENT_TIMESTAMP(3)`,
      [
        input.id,
        input.name,
        input.description ?? null,
        input.fromStage ?? null,
        JSON.stringify(input.configs),
        input.version ?? 1,
        input.sourceKind ?? 'builtin',
        input.sourceKey ?? `builtin:${input.id}`,
      ],
    );
  }
}
