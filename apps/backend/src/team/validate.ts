import { TIGER_ANTIGRAVITY_EFFORTS, TIGER_CLAUDE_EFFORTS, TIGER_CODEX_EFFORTS } from '../orchestrator/config.js';
import { AGENT_TYPES, type AgentType, type TigerConfig } from '../orchestrator/types.js';

/** The CLI tools a role may use. Mirrors the orchestrator `AgentType` union. */
const AGENT_TOOLS: readonly string[] = AGENT_TYPES;

/** Valid reasoning-effort values per provider ('' = use the CLI default). */
const EFFORTS_BY_TOOL: Record<AgentType, readonly string[]> = {
  claude: TIGER_CLAUDE_EFFORTS,
  codex: TIGER_CODEX_EFFORTS,
  antigravity: TIGER_ANTIGRAVITY_EFFORTS,
};

/**
 * The subset of a role definition this validator inspects. `RoleConfigInput`
 * (and other richer role shapes) are structurally assignable to it.
 */
export interface ValidatableRole {
  name: string;
  tool: string;
  model: string;
  effort: string;
  permission: string;
  canWriteCode: boolean;
  requiredForSignoff: boolean;
}

/**
 * Validate a single role's CLI execution settings against the active
 * `TigerConfig`. Returns a clear English error message, or `null` when the role
 * is valid. Pure: no I/O and no mutation.
 *
 * Checks: a non-empty role name; a known CLI tool (`claude`/`codex`); a model and
 * effort valid for that tool (empty string = "use the CLI default"); a permission
 * key present in `TigerConfig.cli[tool].permissionModes`; and boolean
 * `canWriteCode` / `requiredForSignoff` flags.
 */
export function validateRoleConfig(role: ValidatableRole, config: TigerConfig): string | null {
  if (typeof role.name !== 'string' || role.name.trim() === '') {
    return 'role name must not be empty';
  }

  if (!AGENT_TOOLS.includes(role.tool)) {
    return `role tool must be one of: ${AGENT_TOOLS.join(', ')} (got "${role.tool}")`;
  }
  const tool = role.tool as AgentType;
  const cli = config.cli[tool];

  // Model: '' means "use the CLI default"; otherwise it must be a configured model.
  if (typeof role.model !== 'string') {
    return `role "${role.name}" model must be a string`;
  }
  if (role.model !== '' && !(cli.models ?? []).includes(role.model)) {
    return `role "${role.name}" model "${role.model}" is not a configured ${tool} model`;
  }

  // Effort: '' means "use the CLI default"; otherwise it must be valid for the tool.
  const efforts: readonly string[] = EFFORTS_BY_TOOL[tool];
  if (typeof role.effort !== 'string' || !efforts.includes(role.effort)) {
    return `role "${role.name}" effort "${role.effort}" is not a valid ${tool} effort`;
  }

  // Permission: must be one of the configured permission-mode keys for the tool.
  // Use an own-key check (mirrors `config.ts`) rather than `in`, which would also
  // match inherited Object.prototype names such as "toString" or "constructor".
  if (typeof role.permission !== 'string' || !Object.keys(cli.permissionModes).includes(role.permission)) {
    return `role "${role.name}" permission "${role.permission}" is not a known ${tool} permission mode`;
  }

  if (typeof role.canWriteCode !== 'boolean') {
    return `role "${role.name}" canWriteCode must be a boolean`;
  }
  if (typeof role.requiredForSignoff !== 'boolean') {
    return `role "${role.name}" requiredForSignoff must be a boolean`;
  }

  return null;
}
