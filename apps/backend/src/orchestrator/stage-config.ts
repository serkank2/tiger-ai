import {
  TIGER_AGENT_COUNT_MAX,
  TIGER_AGENT_COUNT_MIN,
  TIGER_ANTIGRAVITY_EFFORTS,
  TIGER_CLAUDE_EFFORTS,
  TIGER_CODEX_EFFORTS,
} from './config.js';
import { STAGE_ORDER, isAgentType, type AgentType, type StageId, type StageRunConfig, type TigerConfig } from './types.js';

export function configInputError(message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = 400;
  return e;
}

function toStr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function toAgentType(v: unknown): AgentType | undefined {
  return isAgentType(v) ? v : undefined;
}

export function isStage(v: string): v is StageId {
  return (STAGE_ORDER as string[]).includes(v);
}

function toAgentCount(v: unknown, fallback: number, field: string): number {
  const value = v === undefined ? fallback : v;
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
    throw configInputError(`${field} must be an integer`);
  }
  if (value < TIGER_AGENT_COUNT_MIN || value > TIGER_AGENT_COUNT_MAX) {
    throw configInputError(`${field} must be between ${TIGER_AGENT_COUNT_MIN} and ${TIGER_AGENT_COUNT_MAX}`);
  }
  return value;
}

function toModel(v: unknown, fallback: string, models: string[] | undefined, field: string): string {
  const value = toStr(v, fallback).trim();
  if (value && !models?.includes(value)) throw configInputError(`${field} is not in the configured model list`);
  return value;
}

function toEffort(v: unknown, fallback: string, allowed: readonly string[], field: string): string {
  const value = toStr(v, fallback).trim();
  if (!allowed.includes(value)) throw configInputError(`${field} is not a known effort`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Build a StageRunConfig from request/template input, defaulting from config and validating permission keys. */
export function buildStageConfig(config: TigerConfig, body: Record<string, unknown>, prefix = ''): StageRunConfig {
  const d = config.defaults;
  const cli = config.cli;
  const cfg: StageRunConfig = {
    claudeAgents: toAgentCount(body.claudeAgents, d.claudeAgents, `${prefix}claudeAgents`),
    codexAgents: toAgentCount(body.codexAgents, d.codexAgents, `${prefix}codexAgents`),
    antigravityAgents: toAgentCount(body.antigravityAgents, d.antigravityAgents, `${prefix}antigravityAgents`),
    claudeModel: toModel(body.claudeModel, d.claudeModel, cli.claude.models, `${prefix}claudeModel`),
    codexModel: toModel(body.codexModel, d.codexModel, cli.codex.models, `${prefix}codexModel`),
    antigravityModel: toModel(body.antigravityModel, d.antigravityModel, cli.antigravity.models, `${prefix}antigravityModel`),
    claudeEffort: toEffort(body.claudeEffort, d.claudeEffort, TIGER_CLAUDE_EFFORTS, `${prefix}claudeEffort`),
    codexEffort: toEffort(body.codexEffort, d.codexEffort, TIGER_CODEX_EFFORTS, `${prefix}codexEffort`),
    antigravityEffort: toEffort(
      body.antigravityEffort,
      d.antigravityEffort,
      TIGER_ANTIGRAVITY_EFFORTS,
      `${prefix}antigravityEffort`,
    ),
    claudePermission: toStr(body.claudePermission, d.claudePermission),
    codexPermission: toStr(body.codexPermission, d.codexPermission),
    antigravityPermission: toStr(body.antigravityPermission, d.antigravityPermission),
    parallel: typeof body.parallel === 'boolean' ? body.parallel : d.parallel,
    mergeAgent: toAgentType(body.mergeAgent),
  };
  if (!cli.claude.permissionModes[cfg.claudePermission]) {
    throw configInputError(`unknown ${prefix}claude permission mode: ${cfg.claudePermission}`);
  }
  if (!cli.codex.permissionModes[cfg.codexPermission]) {
    throw configInputError(`unknown ${prefix}codex permission mode: ${cfg.codexPermission}`);
  }
  if (!cli.antigravity.permissionModes[cfg.antigravityPermission]) {
    throw configInputError(`unknown ${prefix}antigravity permission mode: ${cfg.antigravityPermission}`);
  }
  if (cfg.claudeAgents === 0 && cfg.codexAgents === 0 && cfg.antigravityAgents === 0) {
    throw configInputError(
      `${prefix}claudeAgents, codexAgents and antigravityAgents cannot all be 0 — at least one agent is required`,
    );
  }
  return cfg;
}

/** Validate a template's per-stage config map through the same rules used for stage execution. */
export function buildTemplateConfigs(config: TigerConfig, raw: unknown): Partial<Record<StageId, StageRunConfig>> {
  if (!isRecord(raw)) throw configInputError('configs must be an object');
  const configs: Partial<Record<StageId, StageRunConfig>> = {};
  for (const [stage, entry] of Object.entries(raw)) {
    if (!isStage(stage)) throw configInputError(`configs.${stage} is not a known stage`);
    if (!isRecord(entry)) throw configInputError(`configs.${stage} must be an object`);
    configs[stage] = buildStageConfig(config, entry, `configs.${stage}.`);
  }
  return configs;
}
