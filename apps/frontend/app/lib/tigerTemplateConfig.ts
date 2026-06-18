import type { TigerConfig, TigerRunTemplate, TigerStageId, TigerStageRunConfig } from '~/types';
import { TIGER_STAGES } from '~/lib/tigerStages';

const AGENT_COUNT_MIN = 1;
const AGENT_COUNT_MAX = 8;
const CLAUDE_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh'];

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
    claudeModel: d?.claudeModel ?? 'opus',
    codexModel: d?.codexModel ?? 'gpt-5.5',
    claudeEffort: d?.claudeEffort ?? 'xhigh',
    codexEffort: d?.codexEffort ?? 'xhigh',
    claudePermission: d?.claudePermission ?? 'dangerous',
    codexPermission: d?.codexPermission ?? 'yolo',
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
  const claudePerms = Object.keys(config?.cli.claude.permissionModes ?? {});
  const codexPerms = Object.keys(config?.cli.codex.permissionModes ?? {});

  cfg.claudeAgents = clampAgentCount(cfg.claudeAgents);
  cfg.codexAgents = clampAgentCount(cfg.codexAgents);
  if (!claudeModels.includes(cfg.claudeModel)) cfg.claudeModel = '';
  if (!codexModels.includes(cfg.codexModel)) cfg.codexModel = '';
  if (!CLAUDE_EFFORTS.includes(cfg.claudeEffort)) cfg.claudeEffort = '';
  if (!CODEX_EFFORTS.includes(cfg.codexEffort)) cfg.codexEffort = '';
  if (!claudePerms.includes(cfg.claudePermission)) cfg.claudePermission = freshStageConfig(config).claudePermission;
  if (!codexPerms.includes(cfg.codexPermission)) cfg.codexPermission = freshStageConfig(config).codexPermission;
  if (cfg.mergeAgent !== 'claude' && cfg.mergeAgent !== 'codex') cfg.mergeAgent = 'claude';
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
