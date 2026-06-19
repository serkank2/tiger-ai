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
 * Claude/Codex tokens are simple flags/identifiers, but Antigravity (`agy`) model labels
 * contain spaces and parentheses (e.g. `Gemini 3.1 Pro (High)`). Each token is therefore
 * passed through {@link shellQuote}, which double-quotes only the values that need it — so
 * a label becomes one argument and simple flags stay unquoted. Pure + unit-tested.
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
    // Antigravity has no effort flag; reasoning level is part of the model label.
  }

  const perm = tool.permissionModes[params.permission];
  if (perm && perm.length) args.push(...perm);

  if (tool.extraArgs && tool.extraArgs.length) args.push(...tool.extraArgs);

  return args.map(shellQuote).join(' ');
}

/**
 * Quote a single argv token for a shell command line. Tokens made only of safe characters
 * (letters, digits, and `-._/=:,` — every flag/identifier Claude and Codex use) are returned
 * verbatim so existing commands are byte-for-byte unchanged. Anything else (a model label with
 * spaces or parentheses) is wrapped in double quotes, with any embedded backslash or double quote
 * escaped so a stray quote cannot terminate the argument or inject further tokens. Callers should
 * still validate untrusted model values upstream (see `isLaunchSafeModel`); this escaping is
 * defense in depth, not a substitute for validation.
 */
export function shellQuote(token: string): string {
  if (token.length > 0 && /^[A-Za-z0-9._/=:,-]+$/.test(token)) return token;
  return `"${token.replace(/([\\"])/g, '\\$1')}"`;
}

/** True if the permission key resolves to a documented dangerous/unrestricted mode. */
export function isDangerousPermission(cfg: TigerConfig, type: AgentType, permission: string): boolean {
  const perm = cfg.cli[type].permissionModes[permission];
  if (!perm) return false;
  return perm.some(
    (a) => a === '--dangerously-skip-permissions' || a === '--dangerously-bypass-approvals-and-sandbox',
  );
}
