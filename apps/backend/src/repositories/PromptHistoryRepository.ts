import type { Pool, RowDataPacket } from 'mysql2/promise';
import { nanoid } from 'nanoid';
import { getDbPool } from '../db/pool.js';
import { migrate, toMysqlDate } from '../db/migrate.js';
import type { AgentType } from '../orchestrator/types.js';

export type PromptHistoryKind = 'generated' | 'saved_to_library' | 'used_as_project_prompt' | 'enqueue_requested';

export interface PromptHistoryEvent {
  id: string;
  projectId: string | null;
  kind: PromptHistoryKind | string;
  inputText: string | null;
  outputText: string | null;
  generationId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  status: string | null;
  agentType: AgentType | null;
  model: string | null;
  error: string | null;
}

export interface PromptHistoryEventInput {
  projectId?: string | null;
  kind: PromptHistoryKind;
  inputText?: string | null;
  outputText?: string | null;
  generationId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PromptHistoryFilters {
  text?: string;
  kind?: string;
  projectId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  generationId?: string;
  limit?: number;
}

export interface PromptHistoryListResponse {
  items: PromptHistoryEvent[];
  total: number;
}

export interface PromptHistoryRepository {
  record(input: PromptHistoryEventInput): Promise<void>;
  list(filters?: PromptHistoryFilters): Promise<PromptHistoryListResponse>;
}

interface PromptHistoryRow extends RowDataPacket {
  id: string;
  project_id: string | null;
  kind: string;
  input_text: string | null;
  output_text: string | null;
  generation_id: string | null;
  metadata: string | Record<string, unknown> | null;
  created_at: Date | string;
  status: string | null;
  agent_type: AgentType | null;
  model: string | null;
  error: string | null;
}

interface CountRow extends RowDataPacket {
  total: number;
}

export class MySqlPromptHistoryRepository implements PromptHistoryRepository {
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

  async record(input: PromptHistoryEventInput): Promise<void> {
    const pool = await this.pool();
    await pool.query(
      `INSERT INTO prompt_history_events
       (id, project_id, kind, input_text, output_text, generation_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nanoid(),
        input.projectId ?? null,
        input.kind,
        input.inputText ?? null,
        input.outputText ?? null,
        input.generationId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        toMysqlDate(new Date().toISOString()),
      ],
    );
  }

  async list(filters: PromptHistoryFilters = {}): Promise<PromptHistoryListResponse> {
    const pool = await this.pool();
    const { where, params } = historyWhere(filters);
    const limit = normalizeLimit(filters.limit);
    const from = `
      FROM prompt_history_events h
      LEFT JOIN prompt_generations g ON g.id = h.generation_id
      ${where}
    `;
    const [rows] = await pool.query<PromptHistoryRow[]>(
      `SELECT
        h.id, h.project_id, h.kind, h.input_text, h.output_text, h.generation_id, h.metadata, h.created_at,
        g.status, g.agent_type, g.model, g.error
       ${from}
       ORDER BY h.created_at DESC, h.id DESC
       LIMIT ?`,
      [...params, limit],
    );
    const [countRows] = await pool.query<CountRow[]>(`SELECT COUNT(*) AS total ${from}`, params);
    return {
      items: rows.map(mapHistoryRow),
      total: Number(countRows[0]?.total ?? rows.length),
    };
  }
}

export class InMemoryPromptHistoryRepository implements PromptHistoryRepository {
  readonly events: (PromptHistoryEventInput & { id: string; createdAt: string })[] = [];

  async record(input: PromptHistoryEventInput): Promise<void> {
    this.events.push({ id: nanoid(), createdAt: new Date().toISOString(), ...input });
  }

  async list(filters: PromptHistoryFilters = {}): Promise<PromptHistoryListResponse> {
    const text = filters.text?.trim().toLowerCase();
    const dateFrom = filters.dateFrom ? new Date(filters.dateFrom).getTime() : null;
    const dateTo = filters.dateTo ? new Date(filters.dateTo).getTime() : null;
    const items = this.events
      .map(
        (event): PromptHistoryEvent => ({
          id: event.id,
          projectId: event.projectId ?? null,
          kind: event.kind,
          inputText: event.inputText ?? null,
          outputText: event.outputText ?? null,
          generationId: event.generationId ?? null,
          metadata: event.metadata ?? null,
          createdAt: event.createdAt,
          status: typeof event.metadata?.status === 'string' ? event.metadata.status : null,
          agentType: typeof event.metadata?.agentType === 'string' ? (event.metadata.agentType as AgentType) : null,
          model: typeof event.metadata?.model === 'string' ? event.metadata.model : null,
          error: typeof event.metadata?.error === 'string' ? event.metadata.error : null,
        }),
      )
      .filter((event) => {
        if (filters.kind && event.kind !== filters.kind) return false;
        if (filters.projectId && event.projectId !== filters.projectId) return false;
        if (filters.generationId && event.generationId !== filters.generationId) return false;
        if (filters.status && event.status !== filters.status) return false;
        const created = new Date(event.createdAt).getTime();
        if (dateFrom !== null && created < dateFrom) return false;
        if (dateTo !== null && created > dateTo) return false;
        if (!text) return true;
        return [event.id, event.kind, event.projectId, event.generationId, event.inputText, event.outputText]
          .filter(Boolean)
          .join('\n')
          .toLowerCase()
          .includes(text);
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const total = items.length;
    return { items: items.slice(0, normalizeLimit(filters.limit)), total };
  }
}

function historyWhere(filters: PromptHistoryFilters): { where: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, ...values: unknown[]) => {
    parts.push(sql);
    params.push(...values);
  };

  if (filters.text?.trim()) {
    const like = `%${filters.text.trim()}%`;
    add(
      `(h.id LIKE ? OR h.kind LIKE ? OR h.project_id LIKE ? OR h.generation_id LIKE ? OR h.input_text LIKE ? OR h.output_text LIKE ?)`,
      like,
      like,
      like,
      like,
      like,
      like,
    );
  }
  if (filters.kind?.trim()) add('h.kind = ?', filters.kind.trim());
  if (filters.projectId?.trim()) add('h.project_id = ?', filters.projectId.trim());
  if (filters.generationId?.trim()) add('h.generation_id = ?', filters.generationId.trim());
  if (filters.status?.trim()) {
    add(
      `(g.status = ? OR JSON_UNQUOTE(JSON_EXTRACT(h.metadata, '$.status')) = ?)`,
      filters.status.trim(),
      filters.status.trim(),
    );
  }
  if (filters.dateFrom) add('h.created_at >= ?', normalizeDate(filters.dateFrom, false));
  if (filters.dateTo) add('h.created_at <= ?', normalizeDate(filters.dateTo, true));

  return { where: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

function normalizeLimit(limit: unknown): number {
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function normalizeDate(value: string, endOfDay: boolean): string {
  const trimmed = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const date = dateOnly ? new Date(`${trimmed}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`) : new Date(trimmed);
  if (Number.isNaN(date.getTime())) throw httpErr(400, 'history date filters must be valid dates');
  return toMysqlDate(date.toISOString());
}

function mapHistoryRow(row: PromptHistoryRow): PromptHistoryEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    inputText: row.input_text,
    outputText: row.output_text,
    generationId: row.generation_id,
    metadata: json(row.metadata),
    createdAt: toIso(row.created_at),
    status: row.status,
    agentType: row.agent_type,
    model: row.model,
    error: row.error,
  };
}

function json(value: string | Record<string, unknown> | null): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}
