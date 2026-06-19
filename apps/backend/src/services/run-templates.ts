import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { buildTemplateConfigs, configInputError, isStage } from '../orchestrator/stage-config.js';
import { logger } from '../obs/logger.js';
import { BUILTIN_TEMPLATES, parseTemplateMd, templateSlug } from '../orchestrator/templates.js';
import type { RunTemplate, StageId, StageRunConfig, TigerConfig } from '../orchestrator/types.js';

type TemplateConfigs = Partial<Record<StageId, StageRunConfig>>;

export interface RunTemplateCreate {
  id?: string;
  name: string;
  description?: string;
  fromStage?: StageId;
  configs: TemplateConfigs;
  builtin?: boolean;
  version?: number;
  sourceKind?: string;
  sourceKey?: string;
}

export interface RunTemplateUpdate {
  name?: string;
  description?: string;
  fromStage?: StageId;
  configs?: TemplateConfigs;
}

export interface RunTemplateRepository {
  list(includeArchived?: boolean): Promise<RunTemplate[]>;
  findByIdOrName(ref: string, includeArchived?: boolean): Promise<RunTemplate | null>;
  findBySourceKey(sourceKey: string): Promise<RunTemplate | null>;
  create(input: RunTemplateCreate): Promise<RunTemplate>;
  update(id: string, input: RunTemplateUpdate): Promise<RunTemplate>;
  archive(id: string): Promise<boolean>;
  upsertBuiltin(input: RunTemplateCreate & { id: string; builtin: true }): Promise<void>;
}

export class RunTemplateServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function serviceError(status: number, message: string): RunTemplateServiceError {
  return new RunTemplateServiceError(status, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneTemplate<T extends RunTemplate>(template: T): T {
  return {
    ...template,
    configs: JSON.parse(JSON.stringify(template.configs)) as TemplateConfigs,
  };
}

function normalizeTemplateName(value: unknown): string {
  if (typeof value !== 'string') throw configInputError('template name must be a string');
  const name = value.trim();
  if (!name) throw configInputError('template name is required');
  if (name.length > 160) throw configInputError('template name must be 160 characters or fewer');
  return name;
}

function normalizeDescription(value: unknown, fallback?: string): string | undefined {
  if (value === undefined) return fallback;
  if (value === null) return undefined;
  if (typeof value !== 'string') throw configInputError('template description must be a string');
  const description = value.trim();
  return description ? description : undefined;
}

function normalizeFromStage(value: unknown, fallback?: StageId): StageId | undefined {
  if (value === undefined) return fallback;
  if (value === null || value === '') return undefined;
  if (typeof value !== 'string' || !isStage(value)) throw configInputError('fromStage is not a known stage');
  return value;
}

function sourceKeyForFile(file: string): string {
  const normalized = path.resolve(file).replace(/\\/g, '/').toLowerCase();
  return `legacy-md:${createHash('sha256').update(normalized).digest('hex')}`;
}

function builtinId(template: RunTemplate): string {
  return `builtin-${templateSlug(template.name)}`;
}

export class RunTemplateService {
  constructor(
    private readonly repository: RunTemplateRepository,
    private readonly getConfig: () => TigerConfig,
  ) {}

  async initialize(options: { legacyTemplateDirs?: string[] } = {}): Promise<void> {
    await this.seedBuiltins();
    await this.importLegacyTemplates(options.legacyTemplateDirs ?? []);
  }

  async seedBuiltins(): Promise<void> {
    for (const template of BUILTIN_TEMPLATES) {
      await this.repository.upsertBuiltin({
        id: builtinId(template),
        name: template.name,
        description: template.description,
        fromStage: template.fromStage,
        configs: buildTemplateConfigs(this.getConfig(), template.configs),
        builtin: true,
        version: 1,
        sourceKind: 'builtin',
        sourceKey: `builtin:${templateSlug(template.name)}`,
      });
    }
  }

  async importLegacyTemplates(dirs: string[]): Promise<void> {
    const seenDirs = [...new Set(dirs.map((dir) => path.resolve(dir)))];
    // Hoist the full template scan out of the per-file loop: it does not change as we import, so a
    // single fetch avoids an O(files) sweep of the whole table.
    const existingNames = new Set((await this.repository.list(true)).map((t) => t.name.toLowerCase()));
    for (const dir of seenDirs) {
      const entries = (await fs.readdir(dir).catch(() => [] as string[]))
        .filter((name) => name.toLowerCase().endsWith('.md'))
        .sort();
      for (const entry of entries) {
        const file = path.join(dir, entry);
        const sourceKey = sourceKeyForFile(file);
        if (await this.repository.findBySourceKey(sourceKey)) continue;
        const content = await this.readLegacyFile(file);
        if (content == null) continue; // unreadable (ENOENT or logged error) — skip this file
        const parsed = parseTemplateMd(content, entry.replace(/\.md$/i, ''));
        if (!parsed) continue;
        if (existingNames.has(parsed.name.toLowerCase())) continue;
        existingNames.add(parsed.name.toLowerCase());
        await this.repository.create({
          id: nanoid(),
          name: normalizeTemplateName(parsed.name),
          description: normalizeDescription(parsed.description),
          fromStage: normalizeFromStage(parsed.fromStage),
          configs: buildTemplateConfigs(this.getConfig(), parsed.configs),
          builtin: false,
          version: 1,
          sourceKind: 'legacy-md',
          sourceKey,
        });
      }
    }
  }

  /**
   * Read a legacy template file. A missing file (ENOENT) is an expected race (e.g. a dir entry
   * removed between readdir and read) and is silently skipped. Any OTHER error (permissions, I/O)
   * is logged and skipped rather than masquerading as an empty file (which would mis-parse).
   */
  private async readLegacyFile(file: string): Promise<string | null> {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      logger.warn('failed to read legacy template file; skipping', {
        file,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async list(): Promise<RunTemplate[]> {
    return this.sort(await this.repository.list(false));
  }

  async create(payload: unknown): Promise<RunTemplate> {
    const input = this.parsePayload(payload);
    return this.repository.create({ id: nanoid(), ...input, builtin: false, version: 1 });
  }

  /** Compatibility save: create a new custom template, or edit an existing custom template by name/id. */
  async save(payload: unknown): Promise<RunTemplate> {
    const raw = this.requirePayload(payload);
    const name = normalizeTemplateName(raw.name);
    const current = await this.repository.findByIdOrName(name);
    if (!current) return this.create(raw);
    if (current.builtin) throw serviceError(409, 'built-in templates cannot be edited');
    return this.update(current.id ?? current.name, raw);
  }

  async update(ref: string, payload: unknown): Promise<RunTemplate> {
    const current = await this.requireEditable(ref);
    const input = this.parsePayload(payload, current);
    return this.repository.update(current.id ?? current.name, input);
  }

  async duplicate(ref: string, payload: unknown = {}): Promise<RunTemplate> {
    const source = await this.requireExisting(ref);
    const raw = isRecord(payload) ? payload : {};
    const defaultName = await this.nextCopyName(source.name);
    const name = 'name' in raw ? normalizeTemplateName(raw.name) : defaultName;
    const description = normalizeDescription(raw.description, source.description);
    const fromStage = normalizeFromStage(raw.fromStage, source.fromStage);
    const configs = 'configs' in raw ? buildTemplateConfigs(this.getConfig(), raw.configs) : source.configs;
    return this.repository.create({
      id: nanoid(),
      name,
      description,
      fromStage,
      configs,
      builtin: false,
      version: 1,
    });
  }

  async archive(ref: string): Promise<void> {
    const current = await this.requireEditable(ref);
    const archived = await this.repository.archive(current.id ?? current.name);
    if (!archived) throw serviceError(404, 'template not found');
  }

  async apply(ref: string): Promise<RunTemplate> {
    return cloneTemplate(await this.requireExisting(ref));
  }

  private parsePayload(payload: unknown, current?: RunTemplate): RunTemplateCreate {
    const raw = this.requirePayload(payload);
    const name = 'name' in raw ? normalizeTemplateName(raw.name) : current?.name;
    if (!name) throw configInputError('template name is required');
    const description = normalizeDescription(raw.description, current?.description);
    const fromStage = normalizeFromStage(raw.fromStage, current?.fromStage);
    const configs = 'configs' in raw ? buildTemplateConfigs(this.getConfig(), raw.configs) : (current?.configs ?? {});
    return { name, description, fromStage, configs };
  }

  private requirePayload(payload: unknown): Record<string, unknown> {
    if (!isRecord(payload)) throw configInputError('template body must be an object');
    return payload;
  }

  private async requireExisting(ref: string): Promise<RunTemplate> {
    const template = await this.repository.findByIdOrName(ref);
    if (!template) throw serviceError(404, 'template not found');
    return template;
  }

  private async requireEditable(ref: string): Promise<RunTemplate> {
    const template = await this.requireExisting(ref);
    if (template.builtin) throw serviceError(409, 'built-in templates cannot be edited or deleted');
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
    throw serviceError(409, 'could not generate a unique duplicate template name');
  }

  private sort(templates: RunTemplate[]): RunTemplate[] {
    const builtinOrder = new Map(BUILTIN_TEMPLATES.map((template, index) => [template.name, index]));
    return templates.map(cloneTemplate).sort((a, b) => {
      if (!!a.builtin !== !!b.builtin) return a.builtin ? -1 : 1;
      if (a.builtin && b.builtin) {
        return (builtinOrder.get(a.name) ?? 999) - (builtinOrder.get(b.name) ?? 999);
      }
      return a.name.localeCompare(b.name);
    });
  }
}

interface MemoryRunTemplate extends RunTemplate {
  id: string;
  builtin: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  sourceKey?: string;
}

export class InMemoryRunTemplateRepository implements RunTemplateRepository {
  private readonly templates = new Map<string, MemoryRunTemplate>();

  async list(includeArchived = false): Promise<RunTemplate[]> {
    return [...this.templates.values()]
      .filter((template) => includeArchived || !template.archivedAt)
      .map(cloneTemplate);
  }

  async findByIdOrName(ref: string, includeArchived = false): Promise<RunTemplate | null> {
    const found = [...this.templates.values()].find((template) => {
      if (!includeArchived && template.archivedAt) return false;
      return template.id === ref || template.name.toLowerCase() === ref.toLowerCase();
    });
    return found ? cloneTemplate(found) : null;
  }

  async findBySourceKey(sourceKey: string): Promise<RunTemplate | null> {
    const found = [...this.templates.values()].find((template) => template.sourceKey === sourceKey);
    return found ? cloneTemplate(found) : null;
  }

  async create(input: RunTemplateCreate): Promise<RunTemplate> {
    this.assertNameAvailable(input.name);
    const now = new Date().toISOString();
    const template: MemoryRunTemplate = {
      id: input.id ?? nanoid(),
      name: input.name,
      description: input.description,
      fromStage: input.fromStage,
      configs: cloneTemplate({ name: input.name, configs: input.configs }).configs,
      builtin: input.builtin === true,
      version: input.version ?? 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      sourceKey: input.sourceKey,
    };
    this.templates.set(template.id, template);
    return cloneTemplate(template);
  }

  async update(id: string, input: RunTemplateUpdate): Promise<RunTemplate> {
    const current = this.templates.get(id);
    if (!current || current.archivedAt) throw serviceError(404, 'template not found');
    if (current.builtin) throw serviceError(409, 'built-in templates cannot be edited');
    if (input.name && input.name.toLowerCase() !== current.name.toLowerCase()) this.assertNameAvailable(input.name);
    current.name = input.name ?? current.name;
    current.description = input.description;
    current.fromStage = input.fromStage;
    current.configs = cloneTemplate({ name: current.name, configs: input.configs ?? current.configs }).configs;
    current.version += 1;
    current.updatedAt = new Date().toISOString();
    return cloneTemplate(current);
  }

  async archive(id: string): Promise<boolean> {
    const current = this.templates.get(id);
    if (!current || current.archivedAt) return false;
    if (current.builtin) throw serviceError(409, 'built-in templates cannot be deleted');
    const now = new Date().toISOString();
    current.archivedAt = now;
    current.updatedAt = now;
    return true;
  }

  async upsertBuiltin(input: RunTemplateCreate & { id: string; builtin: true }): Promise<void> {
    const now = new Date().toISOString();
    const existing = [...this.templates.values()].find(
      (template) => template.id === input.id || template.name.toLowerCase() === input.name.toLowerCase(),
    );
    const template: MemoryRunTemplate = {
      id: existing?.id ?? input.id,
      name: input.name,
      description: input.description,
      fromStage: input.fromStage,
      configs: cloneTemplate({ name: input.name, configs: input.configs }).configs,
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
      throw serviceError(409, 'template name already exists');
    }
  }
}
