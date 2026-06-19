import type { TigerConfig, TigerRunTemplate, TigerStageId, TigerStageRunConfig } from '~/types';
import { TIGER_STAGES } from '~/lib/tigerStages';

const AGENT_COUNT_MIN = 0;
const AGENT_COUNT_MAX = 8;
const CLAUDE_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh'];
// Antigravity has no reasoning-effort flag; only the empty (CLI default) value is valid.
const ANTIGRAVITY_EFFORTS = [''];

function clampAgentCount(value: unknown): number {
  return Math.min(
    AGENT_COUNT_MAX,
    Math.max(AGENT_COUNT_MIN, Number.isInteger(value) ? Number(value) : AGENT_COUNT_MIN),
  );
}

export function freshStageConfig(config?: TigerConfig | null): TigerStageRunConfig {
  const d = config?.defaults;
  return {
    claudeAgents: d?.claudeAgents ?? 1,
    codexAgents: d?.codexAgents ?? 1,
    antigravityAgents: d?.antigravityAgents ?? 0,
    claudeModel: d?.claudeModel ?? 'opus',
    codexModel: d?.codexModel ?? 'gpt-5.5',
    antigravityModel: d?.antigravityModel ?? 'Gemini 3.1 Pro (High)',
    claudeEffort: d?.claudeEffort ?? 'xhigh',
    codexEffort: d?.codexEffort ?? 'xhigh',
    antigravityEffort: d?.antigravityEffort ?? '',
    claudePermission: d?.claudePermission ?? 'dangerous',
    codexPermission: d?.codexPermission ?? 'yolo',
    antigravityPermission: d?.antigravityPermission ?? 'dangerous',
    parallel: d?.parallel ?? true,
    mergeAgent: 'claude',
  };
}

export function sanitizeStageConfig(
  config: TigerConfig | null | undefined,
  input?: Partial<TigerStageRunConfig>,
): TigerStageRunConfig {
  const cfg = { ...freshStageConfig(config), ...(input ?? {}) };
  const claudeModels = ['', ...(config?.cli.claude.models ?? [])];
  const codexModels = ['', ...(config?.cli.codex.models ?? [])];
  const antigravityModels = ['', ...(config?.cli.antigravity?.models ?? [])];
  const claudePerms = Object.keys(config?.cli.claude.permissionModes ?? {});
  const codexPerms = Object.keys(config?.cli.codex.permissionModes ?? {});
  const antigravityPerms = Object.keys(config?.cli.antigravity?.permissionModes ?? {});

  cfg.claudeAgents = clampAgentCount(cfg.claudeAgents);
  cfg.codexAgents = clampAgentCount(cfg.codexAgents);
  cfg.antigravityAgents = clampAgentCount(cfg.antigravityAgents);
  if (!claudeModels.includes(cfg.claudeModel)) cfg.claudeModel = '';
  if (!codexModels.includes(cfg.codexModel)) cfg.codexModel = '';
  if (!antigravityModels.includes(cfg.antigravityModel)) cfg.antigravityModel = '';
  if (!CLAUDE_EFFORTS.includes(cfg.claudeEffort)) cfg.claudeEffort = '';
  if (!CODEX_EFFORTS.includes(cfg.codexEffort)) cfg.codexEffort = '';
  if (!ANTIGRAVITY_EFFORTS.includes(cfg.antigravityEffort)) cfg.antigravityEffort = '';
  if (!claudePerms.includes(cfg.claudePermission)) cfg.claudePermission = freshStageConfig(config).claudePermission;
  if (!codexPerms.includes(cfg.codexPermission)) cfg.codexPermission = freshStageConfig(config).codexPermission;
  if (!antigravityPerms.includes(cfg.antigravityPermission)) {
    cfg.antigravityPermission = freshStageConfig(config).antigravityPermission;
  }
  if (cfg.mergeAgent !== 'claude' && cfg.mergeAgent !== 'codex' && cfg.mergeAgent !== 'antigravity') {
    cfg.mergeAgent = 'claude';
  }
  return cfg;
}

export function fullStageConfigs(
  config: TigerConfig | null | undefined,
  template?: Pick<TigerRunTemplate, 'configs'> | null,
): Record<TigerStageId, TigerStageRunConfig> {
  return Object.fromEntries(
    TIGER_STAGES.map((stage) => [
      stage.id,
      sanitizeStageConfig(config, template?.configs?.[stage.id]),
    ]),
  ) as Record<TigerStageId, TigerStageRunConfig>;
}

export function cloneStageConfigs(
  config: TigerConfig | null | undefined,
  configs: Partial<Record<TigerStageId, TigerStageRunConfig>>,
): Partial<Record<TigerStageId, TigerStageRunConfig>> {
  const out: Partial<Record<TigerStageId, TigerStageRunConfig>> = {};
  for (const stage of TIGER_STAGES) out[stage.id] = sanitizeStageConfig(config, configs[stage.id]);
  return out;
}
