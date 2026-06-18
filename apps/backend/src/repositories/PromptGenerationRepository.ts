import type { Pool, RowDataPacket } from 'mysql2/promise';
import { nanoid } from 'nanoid';
import { getDbPool } from '../db/pool.js';
import { migrate, toMysqlDate } from '../db/migrate.js';
import type { AgentType } from '../orchestrator/types.js';

export type PromptGenerationStatus = 'pending' | 'running' | 'done' | 'failed';

export interface PromptGenerationRecord {
  id: string;
  inputText: string;
  outputText: string | null;
  status: PromptGenerationStatus;
  agentType: AgentType;
  model: string | null;
  error: string | null;
  projectId: string | null;
  terminalId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CreatePromptGenerationInput {
  inputText: string;
  agentType: AgentType;
  model?: string | null;
  projectId?: string | null;
}

export interface UpdatePromptGenerationInput {
  outputText?: string | null;
  status?: PromptGenerationStatus;
  error?: string | null;
  terminalId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface PromptGenerationRepository {
  create(input: CreatePromptGenerationInput): Promise<PromptGenerationRecord>;
  update(id: string, input: UpdatePromptGenerationInput): Promise<PromptGenerationRecord>;
  get(id: string): Promise<PromptGenerationRecord | null>;
}

interface GenerationRow extends RowDataPacket {
  id: string;
  input_text: string;
  output_text: string | null;
  status: PromptGenerationStatus;
  agent_type: AgentType;
  model: string | null;
  error: string | null;
  project_id: string | null;
  terminal_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}

export class MySqlPromptGenerationRepository implements PromptGenerationRepository {
  private ready: Promise<Pool> | null = null;

  private async pool(): Promise<Pool> {
    if (!this.ready) {
      this.ready = (async () => {
        const pool = await getDbPool();
        await migrate(pool);
        return pool;
      })();
    }
    return this.ready;
  }

  async create(input: CreatePromptGenerationInput): Promise<PromptGenerationRecord> {
    const id = nanoid();
    const now = new Date().toISOString();
    const pool = await this.pool();
    await pool.query(
      `INSERT INTO prompt_generations
       (id, input_text, output_text, status, agent_type, model, error, project_id, terminal_id, created_at, updated_at, started_at, completed_at)
       VALUES (?, ?, NULL, 'pending', ?, ?, NULL, ?, NULL, ?, ?, NULL, NULL)`,
      [
        id,
        input.inputText,
        input.agentType,
        input.model ?? null,
        input.projectId ?? null,
        toMysqlDate(now),
        toMysqlDate(now),
      ],
    );
    const created = await this.get(id);
    if (!created) throw new Error('failed to create prompt generation');
    return created;
  }

  async update(id: string, input: UpdatePromptGenerationInput): Promise<PromptGenerationRecord> {
    const pool = await this.pool();
    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (field: string, value: unknown): void => {
      fields.push(`${field} = ?`);
      values.push(value);
    };
    if ('outputText' in input) set('output_text', input.outputText ?? null);
    if ('status' in input) set('status', input.status);
    if ('error' in input) set('error', input.error ?? null);
    if ('terminalId' in input) set('terminal_id', input.terminalId ?? null);
    if ('startedAt' in input) set('started_at', input.startedAt ? toMysqlDate(input.startedAt) : null);
    if ('completedAt' in input) set('completed_at', input.completedAt ? toMysqlDate(input.completedAt) : null);
    set('updated_at', toMysqlDate(new Date().toISOString()));
    await pool.query(`UPDATE prompt_generations SET ${fields.join(', ')} WHERE id = ?`, [...values, id]);
    const updated = await this.get(id);
    if (!updated) throw new Error(`prompt generation not found: ${id}`);
    return updated;
  }

  async get(id: string): Promise<PromptGenerationRecord | null> {
    const pool = await this.pool();
    const [rows] = await pool.query<GenerationRow[]>('SELECT * FROM prompt_generations WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }
}

export class InMemoryPromptGenerationRepository implements PromptGenerationRepository {
  private rows = new Map<string, PromptGenerationRecord>();

  async create(input: CreatePromptGenerationInput): Promise<PromptGenerationRecord> {
    const now = new Date().toISOString();
    const row: PromptGenerationRecord = {
      id: nanoid(),
      inputText: input.inputText,
      outputText: null,
      status: 'pending',
      agentType: input.agentType,
      model: input.model ?? null,
      error: null,
      projectId: input.projectId ?? null,
      terminalId: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async update(id: string, input: UpdatePromptGenerationInput): Promise<PromptGenerationRecord> {
    const current = this.rows.get(id);
    if (!current) throw new Error(`prompt generation not found: ${id}`);
    const next: PromptGenerationRecord = {
      ...current,
      outputText: 'outputText' in input ? input.outputText ?? null : current.outputText,
      status: input.status ?? current.status,
      error: 'error' in input ? input.error ?? null : current.error,
      terminalId: 'terminalId' in input ? input.terminalId ?? null : current.terminalId,
      startedAt: 'startedAt' in input ? input.startedAt ?? null : current.startedAt,
      completedAt: 'completedAt' in input ? input.completedAt ?? null : current.completedAt,
      updatedAt: new Date().toISOString(),
    };
    this.rows.set(id, next);
    return { ...next };
  }

  async get(id: string): Promise<PromptGenerationRecord | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
}

function mapRow(row: GenerationRow): PromptGenerationRecord {
  return {
    id: row.id,
    inputText: row.input_text,
    outputText: row.output_text,
    status: row.status,
    agentType: row.agent_type,
    model: row.model,
    error: row.error,
    projectId: row.project_id,
    terminalId: row.terminal_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    startedAt: row.started_at ? toIso(row.started_at) : null,
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
