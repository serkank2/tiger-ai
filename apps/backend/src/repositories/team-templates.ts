// ---------------------------------------------------------------------------
// MySQL-backed team template repository. Mirrors `MySqlRunTemplateRepository`
// but targets the dedicated `team_templates` table (created by the team-tables
// migration) and stores the role array in a `roles_json` column.
//
// Expected `team_templates` columns (mirrors `run_templates`, minus from_stage):
//   id, name, description, roles_json, builtin, version, source_kind, source_key,
//   created_at, updated_at, archived_at
// ---------------------------------------------------------------------------

import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  TeamTemplateServiceError,
  type TeamTemplateCreate,
  type TeamTemplateRepository,
  type TeamTemplateUpdate,
} from '../services/team-templates.js';
import type { RoleTemplate, TeamTemplate } from '../team/templates.js';

interface TeamTemplateRow extends RowDataPacket {
  id: string;
  name: string;
  description: string | null;
  roles_json: string | RoleTemplate[];
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

function parseRoles(value: TeamTemplateRow['roles_json']): RoleTemplate[] {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? (parsed as RoleTemplate[]) : [];
}

function rowToTemplate(row: TeamTemplateRow): TeamTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    roles: parseRoles(row.roles_json),
    builtin: row.builtin === 1,
    version: row.version,
    createdAt: dateIso(row.created_at) ?? undefined,
    updatedAt: dateIso(row.updated_at) ?? undefined,
    archivedAt: dateIso(row.archived_at),
  };
}

function duplicateError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ER_DUP_ENTRY';
}

function templateConflict(): TeamTemplateServiceError {
  return new TeamTemplateServiceError(409, 'team template name already exists');
}

export class MySqlTeamTemplateRepository implements TeamTemplateRepository {
  constructor(private readonly pool: Pool) {}

  async list(includeArchived = false): Promise<TeamTemplate[]> {
    const [rows] = await this.pool.query<TeamTemplateRow[]>(
      `SELECT id, name, description, roles_json, builtin, version, created_at, updated_at, archived_at
       FROM team_templates
       ${includeArchived ? '' : 'WHERE archived_at IS NULL'}`,
    );
    return rows.map(rowToTemplate);
  }

  async findByIdOrName(ref: string, includeArchived = false): Promise<TeamTemplate | null> {
    const [rows] = await this.pool.execute<TeamTemplateRow[]>(
      `SELECT id, name, description, roles_json, builtin, version, created_at, updated_at, archived_at
       FROM team_templates
       WHERE (id = ? OR LOWER(name) = LOWER(?)) ${includeArchived ? '' : 'AND archived_at IS NULL'}
       LIMIT 1`,
      [ref, ref],
    );
    return rows[0] ? rowToTemplate(rows[0]) : null;
  }

  async create(input: TeamTemplateCreate): Promise<TeamTemplate> {
    const id = input.id;
    if (!id) throw new TeamTemplateServiceError(400, 'team template id is required');
    try {
      await this.pool.execute(
        `INSERT INTO team_templates
          (id, name, description, roles_json, builtin, version, source_kind, source_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.name,
          input.description ?? null,
          JSON.stringify(input.roles),
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
    if (!created) throw new TeamTemplateServiceError(500, 'team template was not created');
    return created;
  }

  async update(id: string, input: TeamTemplateUpdate): Promise<TeamTemplate> {
    const current = await this.findByIdOrName(id);
    if (!current) throw new TeamTemplateServiceError(404, 'team template not found');
    if (current.builtin) throw new TeamTemplateServiceError(409, 'built-in team templates cannot be edited');
    const currentId = current.id;
    if (!currentId) throw new TeamTemplateServiceError(500, 'team template id is missing');
    try {
      const [result] = await this.pool.execute<ResultSetHeader>(
        `UPDATE team_templates
         SET name = ?,
             description = ?,
             roles_json = ?,
             version = version + 1,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND builtin = 0 AND archived_at IS NULL`,
        [
          input.name ?? current.name,
          input.description ?? null,
          JSON.stringify(input.roles ?? current.roles),
          currentId,
        ],
      );
      if (result.affectedRows === 0) throw new TeamTemplateServiceError(404, 'team template not found');
    } catch (error) {
      if (duplicateError(error)) throw templateConflict();
      throw error;
    }
    const updated = await this.findByIdOrName(currentId);
    if (!updated) throw new TeamTemplateServiceError(404, 'team template not found');
    return updated;
  }

  async archive(id: string): Promise<boolean> {
    const current = await this.findByIdOrName(id);
    if (!current) return false;
    if (current.builtin) throw new TeamTemplateServiceError(409, 'built-in team templates cannot be deleted');
    const currentId = current.id;
    if (!currentId) throw new TeamTemplateServiceError(500, 'team template id is missing');
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE team_templates
       SET archived_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND builtin = 0 AND archived_at IS NULL`,
      [currentId],
    );
    return result.affectedRows > 0;
  }

  async upsertBuiltin(input: TeamTemplateCreate & { id: string; builtin: true }): Promise<void> {
    await this.pool.execute(
      `INSERT INTO team_templates
        (id, name, description, roles_json, builtin, version, source_kind, source_key)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         description = VALUES(description),
         roles_json = VALUES(roles_json),
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
        JSON.stringify(input.roles),
        input.version ?? 1,
        input.sourceKind ?? 'builtin',
        input.sourceKey ?? `builtin-team:${input.id}`,
      ],
    );
  }
}
