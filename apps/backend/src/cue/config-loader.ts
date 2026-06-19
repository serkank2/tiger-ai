import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CueChangeType,
  CueConfigFile,
  CueEventType,
  CueSubscription,
  CueTarget,
  CueTargetKind,
} from './types.js';

/** The on-disk location of a project's cue config, relative to the workspace. */
export const CUE_CONFIG_RELPATH = path.join('.kaplan', 'cue.json');

const EVENT_TYPES: ReadonlySet<CueEventType> = new Set<CueEventType>([
  'file.changed',
  'time.scheduled',
  'time.once',
  'agent.completed',
  'cli.trigger',
]);
const CHANGE_TYPES: ReadonlySet<CueChangeType> = new Set<CueChangeType>(['created', 'modified', 'deleted', 'any']);
const TARGET_KINDS: ReadonlySet<CueTargetKind> = new Set<CueTargetKind>(['queue', 'team']);

export interface CueConfigLoadResult {
  /** Valid, normalized subscriptions. */
  subscriptions: CueSubscription[];
  /** Non-fatal problems (skipped/invalid entries) for surfacing in logs + status. */
  warnings: string[];
  /** Absolute path the config was read from, or null when none exists. */
  configPath: string | null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Validate + normalize a raw config object into typed subscriptions. Pure (no I/O) so it is unit
 * testable and reusable both for the on-disk file and a directly-supplied config object. Invalid
 * entries are dropped and reported via `warnings` rather than throwing — one bad cue must never
 * disable the whole engine.
 */
export function normalizeConfig(raw: unknown): { subscriptions: CueSubscription[]; warnings: string[] } {
  const warnings: string[] = [];
  const out: CueSubscription[] = [];
  const root = (raw ?? {}) as { subscriptions?: unknown };
  const list = Array.isArray(root.subscriptions) ? root.subscriptions : [];
  if (!Array.isArray(root.subscriptions)) {
    if (raw && typeof raw === 'object') warnings.push('config has no "subscriptions" array');
  }
  const seenIds = new Set<string>();

  for (const [i, entryRaw] of list.entries()) {
    const entry = (entryRaw ?? {}) as Record<string, unknown>;
    const id = str(entry.id);
    if (!id) {
      warnings.push(`subscription #${i}: missing "id" — skipped`);
      continue;
    }
    if (seenIds.has(id)) {
      warnings.push(`subscription "${id}": duplicate id — skipped`);
      continue;
    }
    const event = str(entry.event) as CueEventType | undefined;
    if (!event || !EVENT_TYPES.has(event)) {
      warnings.push(`subscription "${id}": invalid event "${String(entry.event)}" — skipped`);
      continue;
    }
    const target = normalizeTarget(entry.target);
    if (!target) {
      warnings.push(`subscription "${id}": missing/invalid "target" — skipped`);
      continue;
    }
    const prompt = str(entry.prompt);
    const promptFile = str(entry.promptFile);
    if (!prompt && !promptFile) {
      warnings.push(`subscription "${id}": needs "prompt" or "promptFile" — skipped`);
      continue;
    }

    const sub: CueSubscription = {
      id,
      event,
      target,
      ...(str(entry.name) ? { name: str(entry.name) } : {}),
      ...(prompt ? { prompt } : {}),
      ...(promptFile ? { promptFile } : {}),
      ...(entry.enabled === false ? { enabled: false } : { enabled: true }),
      ...(str(entry.watch) ? { watch: str(entry.watch) } : {}),
      ...(num(entry.intervalMs) ? { intervalMs: num(entry.intervalMs) } : {}),
      ...(str(entry.at) ? { at: str(entry.at) } : {}),
    };
    const filter = normalizeFilter(entry.filter);
    if (filter) sub.filter = filter;
    // Allow an interval spec under `watch` for time.scheduled (string spec), which the engine
    // parses via parseIntervalSpec; leave as-is.
    seenIds.add(id);
    out.push(sub);
  }

  return { subscriptions: out, warnings };
}

function normalizeTarget(raw: unknown): CueTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const kind = str(t.kind) as CueTargetKind | undefined;
  if (!kind || !TARGET_KINDS.has(kind)) return null;
  const target: CueTarget = { kind };
  if (str(t.workspacePath)) target.workspacePath = str(t.workspacePath);
  if (str(t.projectName)) target.projectName = str(t.projectName);
  const provider = str(t.provider);
  if (provider === 'claude' || provider === 'codex' || provider === 'antigravity' || provider === 'mixed') {
    target.provider = provider;
  }
  if (num(t.priority) !== undefined) target.priority = num(t.priority);
  if (num(t.maxAttempts) !== undefined) target.maxAttempts = num(t.maxAttempts);
  return target;
}

function normalizeFilter(raw: unknown): CueSubscription['filter'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const f = raw as Record<string, unknown>;
  const filter: NonNullable<CueSubscription['filter']> = {};
  const changeType = str(f.changeType) as CueChangeType | undefined;
  if (changeType && CHANGE_TYPES.has(changeType)) filter.changeType = changeType;
  if (str(f.pathIncludes)) filter.pathIncludes = str(f.pathIncludes);
  const triggeredBy = str(f.triggeredBy);
  if (triggeredBy === 'team' || triggeredBy === 'tiger') filter.triggeredBy = triggeredBy;
  if (Array.isArray(f.allOf)) {
    const allOf = f.allOf.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
    if (allOf.length) filter.allOf = allOf;
  }
  return Object.keys(filter).length ? filter : undefined;
}

/**
 * Load + normalize the config from a workspace's `.kaplan/cue.json`. A missing file yields an
 * empty (valid) config; a malformed JSON file yields an empty config plus a warning. Never throws.
 */
export async function loadCueConfig(workspace: string): Promise<CueConfigLoadResult> {
  const configPath = path.join(workspace, CUE_CONFIG_RELPATH);
  let text: string;
  try {
    text = await fs.readFile(configPath, 'utf8');
  } catch {
    return { subscriptions: [], warnings: [], configPath: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    return {
      subscriptions: [],
      warnings: [`cue.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
      configPath,
    };
  }
  const { subscriptions, warnings } = normalizeConfig(parsed);
  return { subscriptions, warnings, configPath };
}

/** Normalize a directly-supplied config object (e.g. tests / programmatic use). */
export function configFromObject(obj: CueConfigFile | unknown): CueConfigLoadResult {
  const { subscriptions, warnings } = normalizeConfig(obj);
  return { subscriptions, warnings, configPath: null };
}
