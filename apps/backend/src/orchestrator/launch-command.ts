import type { AgentType, TigerConfig } from './types.js';
import { config } from '../config.js';
import { getAdapter } from '../executors/registry.js';
import { quoteInvocation, shellQuote as shellQuoteImpl, isDangerousPermissionArgv } from '../executors/shell.js';

export interface LaunchParams {
  model: string;
  effort: string;
  /** Permission-mode key into cfg.cli[type].permissionModes. */
  permission: string;
}

export interface LaunchOptions {
  /**
   * Whether the blanket `--dangerously-*` agent permission flag may be applied. The blanket
   * "skip every approval / disable the sandbox" mode is a foot-gun, so it is OPT-IN: when this
   * is false (the default, read from `config.security.allowDangerousAgentPermissions`), a
   * permission mode that resolves to a dangerous flag is downgraded to no permission flags
   * (the CLI's own safe default) instead of disabling all guardrails. Fine-grained/safe
   * permission modes (acceptEdits, plan, workspace-write, read-only, sandbox, …) are unaffected.
   */
  allowDangerous?: boolean;
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
export function buildLaunchCommand(
  cfg: TigerConfig,
  type: AgentType,
  params: LaunchParams,
  opts?: LaunchOptions,
): string {
  const tool = cfg.cli[type];
  // Gate the blanket dangerous flag: it is applied only when explicitly allowed.
  // Default the gate from config so callers that don't pass opts (Orchestrator, prompt
  // generation, team runner) get the safe behavior without any wiring change.
  const allowDangerous = opts?.allowDangerous ?? config.security.allowDangerousAgentPermissions;

  // Resolve the provider adapter from the registry and delegate. Each adapter owns its own flag
  // layout (model/effort/permission); the dangerous-mode opt-in gate and safe shell quoting are
  // applied by the shared executor helpers, so behavior is byte-for-byte identical to before.
  const adapter = getAdapter(type);
  const { command, args } = adapter.buildLaunch({ cfg, tool, params, allowDangerous });
  return quoteInvocation(command, args);
}

/**
 * Quote a single argv token for a shell command line. Re-exported from the executor layer so the
 * public API stays stable for existing importers. See `executors/shell.ts` for the implementation.
 */
export function shellQuote(token: string): string {
  return shellQuoteImpl(token);
}

/** True if the permission key resolves to a documented dangerous/unrestricted mode. */
export function isDangerousPermission(cfg: TigerConfig, type: AgentType, permission: string): boolean {
  return isDangerousPermissionArgv(cfg.cli[type].permissionModes[permission]);
}
