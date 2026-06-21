import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentType, CliToolConfig, TigerConfig } from './types.js';

let tmpSeq = 0;

export const TIGER_AGENT_COUNT_MIN = 0;
export const TIGER_AGENT_COUNT_MAX = 8;
export const TIGER_PROJECT_PROMPT_MAX_CHARS = 200_000;
export const TIGER_GROUP_NAME_MAX_CHARS = 80;

export const TIGER_CLAUDE_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const TIGER_CODEX_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh'] as const;
// Antigravity (`agy`) exposes no reasoning-effort flag — reasoning level is baked into the
// model label itself (e.g. "Gemini 3.1 Pro (High)"), so the only valid effort is empty.
export const TIGER_ANTIGRAVITY_EFFORTS = [''] as const;

type Provider = keyof TigerConfig['cli'];

/** Providers whose model identifiers are human-readable labels with spaces/parentheses (e.g. `agy`). */
const LABEL_MODEL_PROVIDERS: ReadonlySet<Provider> = new Set<Provider>(['antigravity']);

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

const DEFAULT_AGENT_TIMEOUT_MS = 60 * 60 * 1000;

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
      // Google's Antigravity CLI (`agy`). Models are exact labels reported by `agy models`
      // (they contain spaces and parentheses), selected with `--model`. There is no
      // reasoning-effort flag. Permission modes mirror the flags in `agy -h`.
      antigravity: {
        executable: 'agy',
        models: [
          'Gemini 3.5 Flash (Medium)',
          'Gemini 3.5 Flash (High)',
          'Gemini 3.5 Flash (Low)',
          'Gemini 3.1 Pro (Low)',
          'Gemini 3.1 Pro (High)',
          'Claude Sonnet 4.6 (Thinking)',
          'Claude Opus 4.6 (Thinking)',
          'GPT-OSS 120B (Medium)',
        ],
        modelFlag: '--model',
        extraArgs: [],
        permissionModes: {
          default: [],
          sandbox: ['--sandbox'],
          dangerous: ['--dangerously-skip-permissions'],
        },
      },
    },
    defaults: {
      claudeAgents: 1,
      codexAgents: 1,
      // Antigravity is off by default so existing two-provider runs are unchanged; users opt in.
      antigravityAgents: 0,
      claudeModel: 'opus',
      codexModel: 'gpt-5.5',
      antigravityModel: 'Gemini 3.1 Pro (High)',
      claudeEffort: 'xhigh',
      codexEffort: 'xhigh',
      antigravityEffort: '',
      claudePermission: 'dangerous',
      codexPermission: 'yolo',
      antigravityPermission: 'dangerous',
      parallel: true,
    },
    timing: {
      readyIdleMs: 1500,
      readyMaxWaitMs: 20000,
      doneIdleMs: 60000,
      markerPollMs: 1500,
      agentTimeoutMs: envIntegerInRange('KAPLAN_AGENT_TIMEOUT_MS', DEFAULT_AGENT_TIMEOUT_MS, TIGER_TIMING_LIMITS.agentTimeoutMs),
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
  if (!parsed || typeof parsed !== 'object') return applyEnvOverrides(def);
  const p = parsed as Partial<TigerConfig>;
  const pcli = (p.cli ?? {}) as Partial<TigerConfig['cli']>;
  return applyEnvOverrides({
    version: typeof p.version === 'number' ? p.version : def.version,
    cli: {
      claude: normalizeCliTool('claude', pcli.claude, def.cli.claude),
      codex: normalizeCliTool('codex', pcli.codex, def.cli.codex),
      antigravity: normalizeCliTool('antigravity', pcli.antigravity, def.cli.antigravity),
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
  });
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
    // `defaults` are SOURCE-authoritative: normalizeConfig() always reseeds them from code on load
    // (so a code change applies immediately and a stale config.json can never pin old defaults).
    // Accepting a `defaults` patch here would be a lossy round-trip — saveConfig persists it but the
    // next load discards it. Reject the patch instead so the contract is consistent: defaults are
    // read-only via the API and only ever change in code.
    return 'defaults are managed in code and cannot be changed via the config API';
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
    models: normalizeModelList(r.models, def.models, LABEL_MODEL_PROVIDERS.has(type)),
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

function normalizeModelList(raw: unknown, fallback: string[] | undefined, allowLabel: boolean): string[] | undefined {
  if (!Array.isArray(raw)) return fallback;
  const values = raw.filter((v): v is string => isModelIdentifier(v, allowLabel));
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
  const unknownProvider = unknownKey(raw, ['claude', 'codex', 'antigravity']);
  if (unknownProvider) return `unknown cli provider: ${unknownProvider}`;
  for (const provider of ['claude', 'codex', 'antigravity'] as const) {
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
    const msg = validateModelList(raw.models, `cli.${provider}.models`, LABEL_MODEL_PROVIDERS.has(provider));
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

function envIntegerInRange(name: string, fallback: number, limit: NumberLimit): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const integer = Math.trunc(value);
  return integer >= limit.min && integer <= limit.max ? integer : fallback;
}

function applyEnvOverrides(cfg: TigerConfig): TigerConfig {
  const agentTimeoutMs = envIntegerInRange('KAPLAN_AGENT_TIMEOUT_MS', cfg.timing.agentTimeoutMs, TIGER_TIMING_LIMITS.agentTimeoutMs);
  if (agentTimeoutMs === cfg.timing.agentTimeoutMs) return cfg;
  return { ...cfg, timing: { ...cfg.timing, agentTimeoutMs } };
}

function validateModelList(value: unknown, label: string, allowLabel: boolean): string | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    return `${label} must contain 1 to 50 model identifiers`;
  }
  for (const model of value) {
    if (!isModelIdentifier(model, allowLabel)) {
      return allowLabel
        ? `${label} entries must be non-empty model labels without control characters or shell metacharacters`
        : `${label} entries must be simple non-empty model identifiers`;
    }
  }
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

/**
 * A model "label" identifier: lets a provider expose human-readable model names that contain
 * spaces and parentheses (e.g. Antigravity's `Gemini 3.1 Pro (High)`), while still rejecting
 * control characters and any shell metacharacter that could break safe argv quoting. The launch
 * builder double-quotes such values, so only quote-breaking characters are dangerous.
 */
export function isModelLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 96 &&
    /^[A-Za-z0-9 .()/_+\-]+$/.test(value)
  );
}

/** A configured model identifier for a provider — a simple token, or (when allowed) a label. */
function isModelIdentifier(value: unknown, allowLabel: boolean): value is string {
  if (allowLabel) return isModelLabel(value);
  return isSafeToken(value) && (value as string).length <= 96;
}

/**
 * Whether a model value is safe to pass to {@link buildLaunchCommand} for the given provider.
 * Empty means "use the CLI default". Antigravity accepts its label form (spaces/parentheses);
 * every other provider requires a simple shell-safe token. Used to reject injectable model
 * overrides (quotes, `$`, `;`, control characters, …) before a launch command is built.
 */
export function isLaunchSafeModel(provider: Provider, value: string): boolean {
  if (value === '') return true;
  return isModelIdentifier(value, LABEL_MODEL_PROVIDERS.has(provider));
}

/** The reasoning-effort values valid for a provider ('' = use the CLI default). */
export function effortsForProvider(provider: Provider): readonly string[] {
  if (provider === 'codex') return TIGER_CODEX_EFFORTS;
  if (provider === 'antigravity') return TIGER_ANTIGRAVITY_EFFORTS;
  return TIGER_CLAUDE_EFFORTS;
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
