import type { AgentType, TigerConfig } from './types.js';

export interface LaunchParams {
  model: string;
  effort: string;
  /** Permission-mode key into cfg.cli[type].permissionModes. */
  permission: string;
}

/**
 * Build the interactive launch command for an agent from config + per-run params.
 * Returns a shell command string (typed as a terminal's initialCommand). The agent's
 * working directory is the terminal cwd (the tiger root), so no -C/--cd is needed.
 *
 * All tokens are simple flags/identifiers (no spaces), so a plain space-join is safe.
 * Pure + unit-tested.
 */
export function buildLaunchCommand(cfg: TigerConfig, type: AgentType, params: LaunchParams): string {
  const tool = cfg.cli[type];
  const args: string[] = [tool.executable];

  const model = params.model.trim();
  if (model && tool.modelFlag) args.push(tool.modelFlag, model);

  const effort = params.effort.trim();
  if (effort) {
    if (type === 'claude' && tool.effortFlag) {
      args.push(tool.effortFlag, effort);
    } else if (type === 'codex' && tool.effortConfigKey) {
      // codex applies reasoning effort via a -c override (TOML or literal fallback).
      args.push('-c', `${tool.effortConfigKey}=${effort}`);
    }
  }

  const perm = tool.permissionModes[params.permission];
  if (perm && perm.length) args.push(...perm);

  if (tool.extraArgs && tool.extraArgs.length) args.push(...tool.extraArgs);

  return args.join(' ');
}

/** True if the permission key resolves to a documented dangerous/unrestricted mode. */
export function isDangerousPermission(cfg: TigerConfig, type: AgentType, permission: string): boolean {
  const perm = cfg.cli[type].permissionModes[permission];
  if (!perm) return false;
  return perm.some(
    (a) => a === '--dangerously-skip-permissions' || a === '--dangerously-bypass-approvals-and-sandbox',
  );
}
