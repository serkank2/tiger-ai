import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentType, CliToolConfig, StageDefaults, TigerConfig } from './types.js';

let tmpSeq = 0;

export const TIGER_AGENT_COUNT_MIN = 0;
export const TIGER_AGENT_COUNT_MAX = 8;
export const TIGER_PROJECT_PROMPT_MAX_CHARS = 200_000;
export const TIGER_GROUP_NAME_MAX_CHARS = 80;

export const TIGER_CLAUDE_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const TIGER_CODEX_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh'] as const;

type Provider = keyof TigerConfig['cli'];

type NumberLimit = {
  min: number;
  max: number;
};

export const TIGER_TIMING_LIMITS = {
  readyIdleMs: { min: 100, max: 60_000 },
  readyMaxWaitMs: { min: 1_000, max: 10 * 60_000 },
  doneIdleMs: { min: 1_000, max: 2 * 60 * 60_000 },
  markerPollMs: { min: 100, max: 60_000 },
  agentTimeoutMs: { min: 10_000, max: 24 * 60 * 60_000 },
  settleMaxWaitMs: { min: 100, max: 10 * 60_000 },
  submitDelayMs: { min: 1, max: 60_000 },
} satisfies Record<keyof TigerConfig['timing'], NumberLimit>;

export const TIGER_EXECUTION_LIMITS = {
  maxConcurrent: { min: 1, max: 64 },
  lockTtlMs: { min: 1_000, max: 24 * 60 * 60_000 },
  maxCorrectionCycles: { min: 0, max: 20 },
} satisfies Record<'maxConcurrent' | 'lockTtlMs' | 'maxCorrectionCycles', NumberLimit>;

/**
 * Default Tiger configuration. Command templates + flags live here so Claude/Codex
 * invocation can be changed without touching orchestration code.
 *
 * Permission defaults intentionally use the fully autonomous unrestricted modes
 * (claude `dangerous`, codex `yolo`) so unattended background agents do not stall
 * on approval prompts. The cost-aware default profile reduces spend through
 * model/effort choices while preserving unattended execution.
 */
export function defaultTigerConfig(): TigerConfig {
  return {
    version: 1,
    cli: {
      claude: {
        executable: 'claude',
        models: ['opus', 'sonnet', 'haiku', 'fable'],
        modelFlag: '--model',
        effortFlag: '--effort',
        extraArgs: [],
        permissionModes: {
          default: [],
          acceptEdits: ['--permission-mode', 'acceptEdits'],
          plan: ['--permission-mode', 'plan'],
          dangerous: ['--dangerously-skip-permissions'],
        },
      },
      codex: {
        executable: 'codex',
        models: ['gpt-5.5', 'gpt-5-codex', 'gpt-5', 'gpt-5-mini', 'o3', 'o4-mini'],
        modelFlag: '-m',
        effortConfigKey: 'model_reasoning_effort',
        extraArgs: ['--no-alt-screen'],
        permissionModes: {
          'read-only': ['--ask-for-approval', 'never', '--sandbox', 'read-only'],
          'workspace-write': ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'],
          yolo: ['--dangerously-bypass-approvals-and-sandbox'],
        },
      },
    },
    defaults: {
      claudeAgents: 1,
      codexAgents: 1,
      claudeModel: 'opus',
      codexModel: 'gpt-5.5',
      claudeEffort: 'xhigh',
      codexEffort: 'xhigh',
      claudePermission: 'dangerous',
      codexPermission: 'yolo',
      parallel: true,
    },
    timing: {
      readyIdleMs: 1500,
      readyMaxWaitMs: 20000,
      doneIdleMs: 60000,
      markerPollMs: 1500,
      agentTimeoutMs: 30 * 60 * 1000,
      settleMaxWaitMs: 8000,
      submitDelayMs: 800,
    },
    execution: {
      parallel: true,
      locking: true,
      maxConcurrent: 4,
      lockTtlMs: 30 * 60 * 1000,
      maxCorrectionCycles: 2,
      deleteTigerOnComplete: false,
    },
  };
}

/** Fill any missing fields from defaults so a partial/old config.json is always usable. */
export function normalizeConfig(parsed: unknown): TigerConfig {
  const def = defaultTigerConfig();
  if (!parsed || typeof parsed !== 'object') return def;
  const p = parsed as Partial<TigerConfig>;
  const pcli = (p.cli ?? {}) as Partial<TigerConfig['cli']>;
  return {
    version: typeof p.version === 'number' ? p.version : def.version,
    cli: {
      claude: normalizeCliTool('claude', pcli.claude, def.cli.claude),
      codex: normalizeCliTool('codex', pcli.codex, def.cli.codex),
    },
    // Defaults are the seed values for the per-stage run config; keep them source-authoritative
    // so changing them in code applies immediately, without a stale on-disk config.json overriding.
    defaults: { ...def.defaults },
    timing: normalizeNumberRecord(def.timing, p.timing, TIGER_TIMING_LIMITS),
    execution: {
      parallel: typeof p.execution?.parallel === 'boolean' ? p.execution.parallel : def.execution.parallel,
      locking: typeof p.execution?.locking === 'boolean' ? p.execution.locking : def.execution.locking,
      deleteTigerOnComplete:
        typeof p.execution?.deleteTigerOnComplete === 'boolean'
          ? p.execution.deleteTigerOnComplete
          : def.execution.deleteTigerOnComplete,
      ...normalizeNumberRecord(
        {
          maxConcurrent: def.execution.maxConcurrent,
          lockTtlMs: def.execution.lockTtlMs,
          maxCorrectionCycles: def.execution.maxCorrectionCycles,
        },
        p.execution,
        TIGER_EXECUTION_LIMITS,
      ),
    },
  };
}

/** Validate a user-supplied PUT /api/tiger/config body. Returns a 400-safe error message if invalid. */
export function validateConfigPatch(input: unknown, current: TigerConfig): string | null {
  if (!isPlainRecord(input)) return 'config body must be an object';
  const topLevel = ['version', 'cli', 'defaults', 'timing', 'execution'];
  const unknownTop = unknownKey(input, topLevel);
  if (unknownTop) return `unknown config field: ${unknownTop}`;

  if ('version' in input) {
    const msg = validateIntegerInRange(input.version, 'version', { min: 1, max: 1 });
    if (msg) return msg;
  }

  if ('cli' in input) {
    const msg = validateCliPatch(input.cli);
    if (msg) return msg;
  }

  if ('defaults' in input) {
    const msg = validateDefaultsPatch(input.defaults, current);
    if (msg) return msg;
  }

  if ('timing' in input) {
    const msg = validateNumberPatch(input.timing, 'timing', TIGER_TIMING_LIMITS);
    if (msg) return msg;
  }

  if ('execution' in input) {
    const msg = validateExecutionPatch(input.execution);
    if (msg) return msg;
  }

  return null;
}

function normalizeCliTool(type: Provider, raw: unknown, def: CliToolConfig): CliToolConfig {
  const r = isPlainRecord(raw) ? raw : {};
  const out: CliToolConfig = {
    executable: def.executable,
    models: normalizeModelList(r.models, def.models),
    modelFlag: normalizeOptionalToken(r.modelFlag, def.modelFlag, true) ?? def.modelFlag,
    extraArgs: normalizeTokenArray(r.extraArgs, def.extraArgs ?? []),
    permissionModes: normalizePermissionModes(type, r.permissionModes),
  };
  if ('effortFlag' in def || 'effortFlag' in r) {
    out.effortFlag = normalizeOptionalToken(r.effortFlag, def.effortFlag, true);
  }
  if ('effortConfigKey' in def || 'effortConfigKey' in r) {
    out.effortConfigKey = normalizeOptionalToken(r.effortConfigKey, def.effortConfigKey, true);
  }
  return out;
}

function normalizeNumberRecord<T extends { [K in keyof T]: number }>(
  defaults: T,
  raw: unknown,
  limits: { [K in keyof T]: NumberLimit },
): T {
  const r = isPlainRecord(raw) ? raw : {};
  const out = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const value = r[key as string];
    if (typeof value === 'number' && Number.isInteger(value) && value >= limits[key].min && value <= limits[key].max) {
      out[key] = value as T[keyof T];
    }
  }
  return out;
}

function normalizeModelList(raw: unknown, fallback: string[] | undefined): string[] | undefined {
  if (!Array.isArray(raw)) return fallback;
  const values = raw.filter((v): v is string => isSafeToken(v) && v.length <= 96);
  return values.length > 0 && values.length <= 50 ? values : fallback;
}

function normalizeOptionalToken(raw: unknown, fallback: string | undefined, allowEmpty: boolean): string | undefined {
  if (typeof raw !== 'string') return fallback;
  if (allowEmpty && raw === '') return '';
  return isSafeToken(raw) ? raw : fallback;
}

function normalizeTokenArray(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return fallback;
  if (raw.length > 20) return fallback;
  return raw.every((v): v is string => isSafeToken(v)) ? raw : fallback;
}

function normalizePermissionModes(type: Provider, raw: unknown): Record<string, string[]> {
  const expected = defaultTigerConfig().cli[type].permissionModes;
  return permissionModesMatch(raw, expected) ? (raw as Record<string, string[]>) : expected;
}

function validateCliPatch(raw: unknown): string | null {
  if (!isPlainRecord(raw)) return 'cli must be an object';
  const unknownProvider = unknownKey(raw, ['claude', 'codex']);
  if (unknownProvider) return `unknown cli provider: ${unknownProvider}`;
  for (const provider of ['claude', 'codex'] as const) {
    if (provider in raw) {
      const msg = validateCliToolPatch(provider, raw[provider]);
      if (msg) return msg;
    }
  }
  return null;
}

function validateCliToolPatch(provider: Provider, raw: unknown): string | null {
  if (!isPlainRecord(raw)) return `cli.${provider} must be an object`;
  const allowed = ['executable', 'models', 'modelFlag', 'effortFlag', 'effortConfigKey', 'extraArgs', 'permissionModes'];
  const unknown = unknownKey(raw, allowed);
  if (unknown) return `unknown cli.${provider} field: ${unknown}`;

  const expected = defaultTigerConfig().cli[provider];
  if ('executable' in raw && raw.executable !== expected.executable) {
    return `cli.${provider}.executable must be ${JSON.stringify(expected.executable)}`;
  }
  if ('models' in raw) {
    const msg = validateModelList(raw.models, `cli.${provider}.models`);
    if (msg) return msg;
  }
  for (const field of ['modelFlag', 'effortFlag', 'effortConfigKey'] as const) {
    if (field in raw) {
      const value = raw[field];
      if (value !== '' && !isSafeToken(value)) return `cli.${provider}.${field} must be a simple shell token`;
    }
  }
  if ('extraArgs' in raw) {
    const msg = validateTokenArray(raw.extraArgs, `cli.${provider}.extraArgs`, 20);
    if (msg) return msg;
  }
  if ('permissionModes' in raw && !permissionModesMatch(raw.permissionModes, expected.permissionModes)) {
    return `cli.${provider}.permissionModes may only contain the built-in permission modes`;
  }
  return null;
}

function validateDefaultsPatch(raw: unknown, current: TigerConfig): string | null {
  if (!isPlainRecord(raw)) return 'defaults must be an object';
  const allowed: (keyof StageDefaults)[] = [
    'claudeAgents',
    'codexAgents',
    'claudeModel',
    'codexModel',
    'claudeEffort',
    'codexEffort',
    'claudePermission',
    'codexPermission',
    'parallel',
  ];
  const unknown = unknownKey(raw, allowed);
  if (unknown) return `unknown defaults field: ${unknown}`;

  for (const field of ['claudeAgents', 'codexAgents'] as const) {
    if (field in raw) {
      const msg = validateIntegerInRange(raw[field], `defaults.${field}`, {
        min: TIGER_AGENT_COUNT_MIN,
        max: TIGER_AGENT_COUNT_MAX,
      });
      if (msg) return msg;
    }
  }

  const claudeModel = validateModelChoice(raw.claudeModel, 'defaults.claudeModel', current.cli.claude.models);
  if ('claudeModel' in raw && claudeModel) return claudeModel;
  const codexModel = validateModelChoice(raw.codexModel, 'defaults.codexModel', current.cli.codex.models);
  if ('codexModel' in raw && codexModel) return codexModel;
  if ('claudeEffort' in raw && !setHas(TIGER_CLAUDE_EFFORTS, raw.claudeEffort)) {
    return 'defaults.claudeEffort is not a known Claude effort';
  }
  if ('codexEffort' in raw && !setHas(TIGER_CODEX_EFFORTS, raw.codexEffort)) {
    return 'defaults.codexEffort is not a known Codex effort';
  }
  if ('claudePermission' in raw && !setHas(Object.keys(current.cli.claude.permissionModes), raw.claudePermission)) {
    return 'defaults.claudePermission is not a known Claude permission mode';
  }
  if ('codexPermission' in raw && !setHas(Object.keys(current.cli.codex.permissionModes), raw.codexPermission)) {
    return 'defaults.codexPermission is not a known Codex permission mode';
  }
  if ('parallel' in raw && typeof raw.parallel !== 'boolean') return 'defaults.parallel must be a boolean';
  return null;
}

function validateExecutionPatch(raw: unknown): string | null {
  if (!isPlainRecord(raw)) return 'execution must be an object';
  const allowed = ['parallel', 'locking', 'deleteTigerOnComplete', ...Object.keys(TIGER_EXECUTION_LIMITS)];
  const unknown = unknownKey(raw, allowed);
  if (unknown) return `unknown execution field: ${unknown}`;
  for (const field of ['parallel', 'locking', 'deleteTigerOnComplete'] as const) {
    if (field in raw && typeof raw[field] !== 'boolean') return `execution.${field} must be a boolean`;
  }
  const numeric: Record<string, unknown> = {};
  for (const field of Object.keys(TIGER_EXECUTION_LIMITS)) {
    if (field in raw) numeric[field] = raw[field];
  }
  return validateNumberPatch(numeric, 'execution', TIGER_EXECUTION_LIMITS);
}

function validateNumberPatch<T extends Record<string, NumberLimit>>(
  raw: unknown,
  label: string,
  limits: T,
): string | null {
  if (!isPlainRecord(raw)) return `${label} must be an object`;
  const unknown = unknownKey(raw, Object.keys(limits));
  if (unknown) return `unknown ${label} field: ${unknown}`;
  for (const key of Object.keys(limits) as (keyof T & string)[]) {
    if (key in raw) {
      const msg = validateIntegerInRange(raw[key], `${label}.${key}`, limits[key]!);
      if (msg) return msg;
    }
  }
  return null;
}

function validateIntegerInRange(value: unknown, label: string, limit: NumberLimit): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
    return `${label} must be an integer`;
  }
  if (value < limit.min || value > limit.max) {
    return `${label} must be between ${limit.min} and ${limit.max}`;
  }
  return null;
}

function validateModelList(value: unknown, label: string): string | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    return `${label} must contain 1 to 50 model identifiers`;
  }
  for (const model of value) {
    if (typeof model !== 'string' || !isSafeToken(model) || model.length > 96) {
      return `${label} entries must be simple non-empty model identifiers`;
    }
  }
  return null;
}

function validateModelChoice(value: unknown, label: string, allowed: string[] | undefined): string | null {
  if (typeof value !== 'string') return `${label} must be a string`;
  if (value === '') return null;
  if (!allowed?.includes(value)) return `${label} is not in the configured model list`;
  return null;
}

function validateTokenArray(value: unknown, label: string, max: number): string | null {
  if (!Array.isArray(value) || value.length > max) return `${label} must be an array with at most ${max} entries`;
  if (!value.every((entry) => isSafeToken(entry))) return `${label} entries must be simple shell tokens`;
  return null;
}

function permissionModesMatch(value: unknown, expected: Record<string, string[]>): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, i) => key !== expectedKeys[i])) return false;
  return expectedKeys.every((key) => {
    const actual = value[key];
    const exp = expected[key]!;
    return Array.isArray(actual) && actual.length === exp.length && actual.every((entry, i) => entry === exp[i]);
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function unknownKey(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  const allowedSet = new Set(allowed);
  return Object.keys(value).find((key) => !allowedSet.has(key)) ?? null;
}

function isSafeToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s"'`;&|<>()[\]{}$\\]/.test(value);
}

function setHas(values: readonly string[], value: unknown): value is string {
  return typeof value === 'string' && values.includes(value);
}

/** Load tiger/config.json, normalizing/repairing it; returns defaults if missing or corrupt. */
export async function loadConfig(configFile: string): Promise<TigerConfig> {
  try {
    const raw = await fs.readFile(configFile, 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return defaultTigerConfig();
  }
}

/** Atomically persist the config (unique temp + rename, mirroring store/state.ts). */
export async function saveConfig(configFile: string, cfg: TigerConfig): Promise<void> {
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  const tmp = `${configFile}.${process.pid}.${tmpSeq++}.tmp`;
  const data = JSON.stringify(cfg, null, 2);
  const fh = await fs.open(tmp, 'wx');
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, configFile);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}
