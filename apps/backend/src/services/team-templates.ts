// ---------------------------------------------------------------------------
// Team template CRUD service. Mirrors the proven `run-templates` service: it
// seeds built-in team templates idempotently, keeps built-in rows non-deletable,
// and validates every custom template (each role against `TigerConfig.cli`,
// unique role keys, and at least one sign-off role) before persisting.
//
// Team templates are stored in their own `team_templates` table and are entirely
// separate from Run All `run_templates` / `/api/tiger/templates`.
// ---------------------------------------------------------------------------

import { nanoid } from 'nanoid';
import { configInputError } from '../orchestrator/stage-config.js';
import type { TigerConfig } from '../orchestrator/types.js';
import {
  BUILTIN_TEAM_TEMPLATES,
  buildRoleTemplate,
  cloneRoleTemplate,
  teamTemplateSlug,
  validateTeamTemplate,
  type RoleTemplate,
  type TeamTemplate,
} from '../team/templates.js';

export interface TeamTemplateCreate {
  id?: string;
  name: string;
  description?: string;
  roles: RoleTemplate[];
  builtin?: boolean;
  version?: number;
  sourceKind?: string;
  sourceKey?: string;
}

export interface TeamTemplateUpdate {
  name?: string;
  description?: string;
  roles?: RoleTemplate[];
}

export interface TeamTemplateRepository {
  list(includeArchived?: boolean): Promise<TeamTemplate[]>;
  findByIdOrName(ref: string, includeArchived?: boolean): Promise<TeamTemplate | null>;
  create(input: TeamTemplateCreate): Promise<TeamTemplate>;
  update(id: string, input: TeamTemplateUpdate): Promise<TeamTemplate>;
  archive(id: string): Promise<boolean>;
  upsertBuiltin(input: TeamTemplateCreate & { id: string; builtin: true }): Promise<void>;
}

export class TeamTemplateServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function serviceError(status: number, message: string): TeamTemplateServiceError {
  return new TeamTemplateServiceError(status, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function cloneTeamTemplate<T extends TeamTemplate>(template: T): T {
  return {
    ...template,
    roles: template.roles.map(cloneRoleTemplate),
  };
}

function normalizeTemplateName(value: unknown): string {
  if (typeof value !== 'string') throw configInputError('team template name must be a string');
  const name = value.trim();
  if (!name) throw configInputError('team template name is required');
  if (name.length > 160) throw configInputError('team template name must be 160 characters or fewer');
  return name;
}

function normalizeDescription(value: unknown, fallback?: string): string | undefined {
  if (value === undefined) return fallback;
  if (value === null) return undefined;
  if (typeof value !== 'string') throw configInputError('team template description must be a string');
  const description = value.trim();
  return description ? description : undefined;
}

function builtinTeamId(template: TeamTemplate): string {
  return `builtin-team-${teamTemplateSlug(template.name)}`;
}

export class TeamTemplateService {
  constructor(
    private readonly repository: TeamTemplateRepository,
    private readonly getConfig: () => TigerConfig,
  ) {}

  /** Seed (and re-seed) the built-in team templates. Idempotent across restarts. */
  async initialize(): Promise<void> {
    await this.seedBuiltins();
  }

  async seedBuiltins(): Promise<void> {
    const config = this.getConfig();
    for (const template of BUILTIN_TEAM_TEMPLATES) {
      // Guard: a built-in must validate against the active config before it is seeded.
      validateTeamTemplate(config, template);
      await this.repository.upsertBuiltin({
        id: builtinTeamId(template),
        name: template.name,
        description: template.description,
        roles: template.roles.map(cloneRoleTemplate),
        builtin: true,
        version: 1,
        sourceKind: 'builtin',
        sourceKey: `builtin-team:${teamTemplateSlug(template.name)}`,
      });
    }
  }

  async list(): Promise<TeamTemplate[]> {
    return this.sort(await this.repository.list(false));
  }

  async get(ref: string): Promise<TeamTemplate> {
    return cloneTeamTemplate(await this.requireExisting(ref));
  }

  async create(payload: unknown): Promise<TeamTemplate> {
    const input = this.parsePayload(payload);
    return this.repository.create({ id: nanoid(), ...input, builtin: false, version: 1 });
  }

  async update(ref: string, payload: unknown): Promise<TeamTemplate> {
    const current = await this.requireEditable(ref);
    const input = this.parsePayload(payload, current);
    return this.repository.update(current.id ?? current.name, input);
  }

  async duplicate(ref: string, payload: unknown = {}): Promise<TeamTemplate> {
    const source = await this.requireExisting(ref);
    const raw = isRecord(payload) ? payload : {};
    const defaultName = await this.nextCopyName(source.name);
    const name = 'name' in raw ? normalizeTemplateName(raw.name) : defaultName;
    const description = normalizeDescription(raw.description, source.description);
    const roles = 'roles' in raw ? this.parseRoles(raw.roles) : source.roles.map(cloneRoleTemplate);
    validateTeamTemplate(this.getConfig(), { name, description, roles });
    return this.repository.create({ id: nanoid(), name, description, roles, builtin: false, version: 1 });
  }

  async archive(ref: string): Promise<void> {
    const current = await this.requireEditable(ref);
    const archived = await this.repository.archive(current.id ?? current.name);
    if (!archived) throw serviceError(404, 'team template not found');
  }

  /** Return a deep clone of a template so callers can safely use it to launch a run. */
  async apply(ref: string): Promise<TeamTemplate> {
    return cloneTeamTemplate(await this.requireExisting(ref));
  }

  private parsePayload(payload: unknown, current?: TeamTemplate): TeamTemplateCreate {
    const raw = this.requirePayload(payload);
    const name = 'name' in raw ? normalizeTemplateName(raw.name) : current?.name;
    if (!name) throw configInputError('team template name is required');
    const description = normalizeDescription(raw.description, current?.description);
    const roles = 'roles' in raw ? this.parseRoles(raw.roles) : current?.roles.map(cloneRoleTemplate);
    if (!roles) throw configInputError('roles are required');
    validateTeamTemplate(this.getConfig(), { name, description, roles });
    return { name, description, roles };
  }

  private parseRoles(raw: unknown): RoleTemplate[] {
    if (!Array.isArray(raw)) throw configInputError('roles must be an array');
    if (raw.length === 0) throw configInputError('a team template must include at least one role');
    const config = this.getConfig();
    return raw.map((role) => buildRoleTemplate(config, role));
  }

  private requirePayload(payload: unknown): Record<string, unknown> {
    if (!isRecord(payload)) throw configInputError('team template body must be an object');
    return payload;
  }

  private async requireExisting(ref: string): Promise<TeamTemplate> {
    const template = await this.repository.findByIdOrName(ref);
    if (!template) throw serviceError(404, 'team template not found');
    return template;
  }

  private async requireEditable(ref: string): Promise<TeamTemplate> {
    const template = await this.requireExisting(ref);
    if (template.builtin) throw serviceError(409, 'built-in team templates cannot be edited or deleted');
    return template;
  }

  private async nextCopyName(name: string): Promise<string> {
    const names = new Set((await this.repository.list(true)).map((t) => t.name.toLowerCase()));
    const base = `${name} Copy`;
    if (!names.has(base.toLowerCase())) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base} ${i}`;
      if (!names.has(candidate.toLowerCase())) return candidate;
    }
    throw serviceError(409, 'could not generate a unique duplicate team template name');
  }

  private sort(templates: TeamTemplate[]): TeamTemplate[] {
    const builtinOrder = new Map(BUILTIN_TEAM_TEMPLATES.map((template, index) => [template.name, index]));
    return templates.map(cloneTeamTemplate).sort((a, b) => {
      if (!!a.builtin !== !!b.builtin) return a.builtin ? -1 : 1;
      if (a.builtin && b.builtin) {
        return (builtinOrder.get(a.name) ?? 999) - (builtinOrder.get(b.name) ?? 999);
      }
      return a.name.localeCompare(b.name);
    });
  }
}

interface MemoryTeamTemplate extends TeamTemplate {
  id: string;
  builtin: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  sourceKey?: string;
}

export class InMemoryTeamTemplateRepository implements TeamTemplateRepository {
  private readonly templates = new Map<string, MemoryTeamTemplate>();

  async list(includeArchived = false): Promise<TeamTemplate[]> {
    return [...this.templates.values()]
      .filter((template) => includeArchived || !template.archivedAt)
      .map(cloneTeamTemplate);
  }

  async findByIdOrName(ref: string, includeArchived = false): Promise<TeamTemplate | null> {
    const found = [...this.templates.values()].find((template) => {
      if (!includeArchived && template.archivedAt) return false;
      return template.id === ref || template.name.toLowerCase() === ref.toLowerCase();
    });
    return found ? cloneTeamTemplate(found) : null;
  }

  async create(input: TeamTemplateCreate): Promise<TeamTemplate> {
    this.assertNameAvailable(input.name);
    const now = new Date().toISOString();
    const template: MemoryTeamTemplate = {
      id: input.id ?? nanoid(),
      name: input.name,
      description: input.description,
      roles: cloneTeamTemplate({ name: input.name, roles: input.roles }).roles,
      builtin: input.builtin === true,
      version: input.version ?? 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      sourceKey: input.sourceKey,
    };
    this.templates.set(template.id, template);
    return cloneTeamTemplate(template);
  }

  async update(id: string, input: TeamTemplateUpdate): Promise<TeamTemplate> {
    const current = this.templates.get(id);
    if (!current || current.archivedAt) throw serviceError(404, 'team template not found');
    if (current.builtin) throw serviceError(409, 'built-in team templates cannot be edited');
    if (input.name && input.name.toLowerCase() !== current.name.toLowerCase()) this.assertNameAvailable(input.name);
    current.name = input.name ?? current.name;
    current.description = input.description;
    current.roles = cloneTeamTemplate({ name: current.name, roles: input.roles ?? current.roles }).roles;
    current.version += 1;
    current.updatedAt = new Date().toISOString();
    return cloneTeamTemplate(current);
  }

  async archive(id: string): Promise<boolean> {
    const current = this.templates.get(id);
    if (!current || current.archivedAt) return false;
    if (current.builtin) throw serviceError(409, 'built-in team templates cannot be deleted');
    const now = new Date().toISOString();
    current.archivedAt = now;
    current.updatedAt = now;
    return true;
  }

  async upsertBuiltin(input: TeamTemplateCreate & { id: string; builtin: true }): Promise<void> {
    const now = new Date().toISOString();
    const existing = [...this.templates.values()].find(
      (template) => template.id === input.id || template.name.toLowerCase() === input.name.toLowerCase(),
    );
    const template: MemoryTeamTemplate = {
      id: existing?.id ?? input.id,
      name: input.name,
      description: input.description,
      roles: cloneTeamTemplate({ name: input.name, roles: input.roles }).roles,
      builtin: true,
      version: input.version ?? existing?.version ?? 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      archivedAt: null,
      sourceKey: input.sourceKey,
    };
    this.templates.set(template.id, template);
  }

  private assertNameAvailable(name: string): void {
    if ([...this.templates.values()].some((template) => template.name.toLowerCase() === name.toLowerCase())) {
      throw serviceError(409, 'team template name already exists');
    }
  }
}
