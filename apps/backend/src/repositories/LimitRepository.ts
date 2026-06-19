import type { RowDataPacket } from 'mysql2/promise';
import { query } from '../db/pool.js';
import { toMysqlDate } from '../db/migrate.js';
import {
  defaultLimitRules,
  type LimitMetricRaw,
  type LimitParseConfidence,
  type LimitProvider,
  type LimitRule,
  type LimitSnapshot,
  type LimitWindowKey,
  type LimitsPersistedState,
} from '../limits/types.js';

export interface LimitRepository {
  load(maxSnapshots: number): Promise<LimitsPersistedState>;
  insertSnapshots(snapshots: LimitSnapshot[]): Promise<void>;
  upsertRules(rules: LimitRule[]): Promise<void>;
  listRules(): Promise<LimitRule[]>;
  upsertRule(rule: LimitRule): Promise<void>;
  deleteRule(id: string): Promise<void>;
}

interface LimitSnapshotRow extends RowDataPacket {
  id: string;
  provider: LimitProvider;
  window_key: string;
  label: string;
  percent_used: string | number | null;
  metric_raw: string | LimitMetricRaw | null;
  reset_text: string | null;
  reset_at: Date | string | null;
  ok: number | boolean;
  error: string | null;
  raw_panel: string | null;
  parse_confidence: string;
  checked_at: Date | string;
}

interface LimitRuleRow extends RowDataPacket {
  id: string;
  provider: LimitProvider;
  window_key: string;
  threshold_percent: string | number;
  comparison: 'gte';
  action: 'block';
  enabled: number | boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseMetric(value: string | LimitMetricRaw | null): LimitMetricRaw | null {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value) as Partial<LimitMetricRaw>;
    if (
      typeof parsed.percent === 'number' &&
      Number.isFinite(parsed.percent) &&
      (parsed.metric === 'used' || parsed.metric === 'left')
    ) {
      return { percent: parsed.percent, metric: parsed.metric };
    }
  } catch {
    /* ignore malformed JSON */
  }
  return null;
}

function mysqlDate(value: string | null | undefined): string | null {
  return value ? toMysqlDate(value) : null;
}

/**
 * True when the error is "the limit tables don't exist / are shaped differently". Treated as a
 * fail-open condition: a missing snapshot table must never silently block all dispatch forever.
 */
function isMissingLimitTable(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR';
}

function mapSnapshot(row: LimitSnapshotRow): LimitSnapshot {
  const confidence: LimitParseConfidence = row.parse_confidence === 'trusted' ? 'trusted' : 'unknown';
  return {
    id: row.id,
    provider: row.provider,
    windowKey: row.window_key as LimitWindowKey,
    label: row.label,
    percentUsed: row.percent_used == null ? null : Number(row.percent_used),
    metricRaw: parseMetric(row.metric_raw),
    resetText: row.reset_text,
    resetAt: toIso(row.reset_at),
    ok: row.ok === true || row.ok === 1,
    error: row.error ?? undefined,
    rawPanel: row.raw_panel ?? '',
    parseConfidence: confidence,
    checkedAt: toIso(row.checked_at) ?? new Date().toISOString(),
  };
}

function mapRule(row: LimitRuleRow): LimitRule {
  return {
    id: row.id,
    provider: row.provider,
    windowKey: row.window_key as LimitWindowKey | 'any',
    thresholdPercent: Number(row.threshold_percent),
    comparison: row.comparison,
    action: row.action,
    enabled: row.enabled === true || row.enabled === 1,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
  };
}

export class MySqlLimitRepository implements LimitRepository {
  async load(maxSnapshots: number): Promise<LimitsPersistedState> {
    let snapshots: LimitSnapshotRow[];
    let snapshotsUnavailable = false;
    try {
      snapshots = await query<LimitSnapshotRow[]>(
        `SELECT *
         FROM (
           SELECT *
           FROM limit_snapshots
           ORDER BY checked_at DESC, created_at DESC
           LIMIT ?
         ) recent
         ORDER BY checked_at ASC`,
        [maxSnapshots],
      );
    } catch (err) {
      // Fail open: a missing/unreadable snapshot table must NOT permanently block dispatch.
      if (!isMissingLimitTable(err)) throw err;
      console.warn(
        '[limits] limit_snapshots table is missing or unreadable — failing OPEN (allowing dispatch). Run migrations to restore the limit gate.',
      );
      snapshots = [];
      snapshotsUnavailable = true;
    }

    let rules: LimitRuleRow[];
    try {
      rules = await query<LimitRuleRow[]>('SELECT * FROM limit_rules ORDER BY created_at ASC');
    } catch (err) {
      if (!isMissingLimitTable(err)) throw err;
      rules = [];
    }

    return {
      snapshots: snapshots.map(mapSnapshot),
      rules: rules.length ? rules.map(mapRule) : defaultLimitRules(),
      updatedAt: snapshots[0] ? mapSnapshot(snapshots[snapshots.length - 1]!).checkedAt : undefined,
      ...(snapshotsUnavailable ? { snapshotsUnavailable: true } : {}),
    };
  }

  async insertSnapshots(snapshots: LimitSnapshot[]): Promise<void> {
    for (const snapshot of snapshots) {
      await query(
        `INSERT INTO limit_snapshots (
          id, provider, window_key, label, percent_used, metric_raw, reset_text, reset_at,
          ok, error, raw_panel, parse_confidence, checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshot.id,
          snapshot.provider,
          snapshot.windowKey,
          snapshot.label,
          snapshot.percentUsed,
          snapshot.metricRaw ? JSON.stringify(snapshot.metricRaw) : null,
          snapshot.resetText,
          mysqlDate(snapshot.resetAt),
          snapshot.ok ? 1 : 0,
          snapshot.error ?? null,
          snapshot.rawPanel,
          snapshot.parseConfidence,
          toMysqlDate(snapshot.checkedAt),
        ],
      );
    }
  }

  async upsertRules(rules: LimitRule[]): Promise<void> {
    for (const rule of rules) await this.upsertRule(rule);
  }

  async upsertRule(rule: LimitRule): Promise<void> {
    await query(
      `INSERT INTO limit_rules (
        id, provider, window_key, threshold_percent, comparison, action, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        provider = VALUES(provider),
        window_key = VALUES(window_key),
        threshold_percent = VALUES(threshold_percent),
        comparison = VALUES(comparison),
        action = VALUES(action),
        enabled = VALUES(enabled),
        updated_at = VALUES(updated_at)`,
      [
        rule.id,
        rule.provider,
        rule.windowKey,
        rule.thresholdPercent,
        rule.comparison,
        rule.action,
        rule.enabled ? 1 : 0,
        mysqlDate(rule.createdAt),
        mysqlDate(rule.updatedAt),
      ],
    );
  }

  async listRules(): Promise<LimitRule[]> {
    const rules = await query<LimitRuleRow[]>('SELECT * FROM limit_rules ORDER BY created_at ASC');
    return rules.length ? rules.map(mapRule) : defaultLimitRules();
  }

  async deleteRule(id: string): Promise<void> {
    await query('DELETE FROM limit_rules WHERE id = ?', [id]);
  }
}
