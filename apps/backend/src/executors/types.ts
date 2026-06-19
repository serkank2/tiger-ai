import type { AgentType, CliToolConfig, TigerConfig } from '../orchestrator/types.js';

/**
 * Per-run launch inputs (the user's per-step/per-role model + effort + permission choice).
 * Identical to the orchestrator's `LaunchParams`; re-declared here so the executor layer is
 * self-contained and the orchestrator can import it from either place.
 */
export interface ExecutorLaunchParams {
  model: string;
  effort: string;
  /** Permission-mode key into the provider's `permissionModes`. */
  permission: string;
}

/** Everything an adapter needs to build a launch command, resolved by the caller. */
export interface BuildLaunchContext {
  /** Full Tiger config (adapters read their own `cli[id]` entry + may read security/defaults). */
  cfg: TigerConfig;
  /** The provider/tool config for this adapter (convenience: `cfg.cli[id]`). */
  tool: CliToolConfig;
  /** Per-run params (model/effort/permission). Per-step/per-role model routing flows through here. */
  params: ExecutorLaunchParams;
  /**
   * Whether the blanket `--dangerously-*` permission flag may be applied. When false, a dangerous
   * permission mode is downgraded to the CLI's own safe default (no permission flags) instead of
   * disabling all guardrails. Resolved by the caller from `opts.allowDangerous ??
   * config.security.allowDangerousAgentPermissions`.
   */
  allowDangerous: boolean;
}

/** The argv an adapter produces. `command` is the executable; `args` excludes it. */
export interface LaunchInvocation {
  /** The executable (argv[0]). */
  command: string;
  /** Remaining argv tokens (already in order, NOT yet shell-quoted). */
  args: string[];
}

/**
 * A provider adapter — the single extension point for launching an agent CLI. Adding a provider is
 * "add an adapter + register it". Modelled on vibe-kanban's `Executor` trait / the myclaude
 * backend-wrapper pattern: each provider owns its own flag layout behind one stable interface.
 */
export interface ProviderAdapter {
  /** Stable registry id (matches `cfg.cli` keys for wired providers). */
  readonly id: string;
  /** Human-readable label for logs/UI. */
  readonly label: string;
  /**
   * Experimental adapters are NOT wired into defaults or the user-selectable provider set; they
   * exist so the registry is extensible. See the registry doc-comment for how to promote one.
   */
  readonly experimental?: boolean;
  /** Build the (un-quoted) launch invocation for this provider from the resolved context. */
  buildLaunch(ctx: BuildLaunchContext): LaunchInvocation;
  /** Optional: transform the prompt text before it is written/sent (default: identity). */
  formatPrompt?(text: string): string;
  /** Optional: parse a chunk of the agent's stdout (default: passthrough). */
  parseOutput?(chunk: string): string;
}

/** Re-export of the wired provider union for adapters that need to narrow. */
export type WiredProviderId = AgentType;
