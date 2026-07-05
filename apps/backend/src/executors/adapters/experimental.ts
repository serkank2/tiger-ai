import type { BuildLaunchContext, LaunchInvocation, ProviderAdapter } from '../types.js';

/**
 * EXPERIMENTAL adapters — NOT wired into Tiger defaults, the AgentType union, or the
 * user-selectable provider set. They exist only to prove the registry is extensible: adding a
 * provider is "write an adapter + register it". Their flag layouts are best-effort guesses based
 * on each CLI's documented interface and may change.
 *
 * To PROMOTE one to a real, user-selectable provider:
 *   1. Add its id to `AgentType` / `AGENT_TYPES` / `isAgentType` in orchestrator/types.ts.
 *   2. Add a `cli.<id>` CliToolConfig (executable, models, modelFlag, permissionModes, ...) to
 *      defaultTigerConfig() in orchestrator/config.ts and to the frontend defaults/UI.
 *   3. Rewrite this adapter's buildLaunch to read `ctx.tool` (cfg.cli[id]) and use the shared
 *      helpers (pushModelArgs / resolvePermissionArgs) like the wired adapters, then drop
 *      `experimental: true`.
 *   4. Move it from `EXPERIMENTAL_ADAPTERS` to the wired set in registry.ts.
 *
 * Until promoted, `ctx.tool` is `undefined` for these ids (no cli config exists), so each builds
 * a self-contained invocation from `ctx.params` alone.
 */

/** opencode (sst/opencode) — open-source terminal coding agent. */
export const opencodeAdapter: ProviderAdapter = {
  id: 'opencode',
  label: 'OpenCode (experimental)',
  experimental: true,
  buildLaunch({ params }: BuildLaunchContext): LaunchInvocation {
    const args: string[] = [];
    const model = params.model.trim();
    if (model) args.push('--model', model);
    return { command: 'opencode', args };
  },
};

/** Gemini CLI (`gemini`) — Google's official terminal agent. */
export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',
  label: 'Gemini CLI (experimental)',
  experimental: true,
  buildLaunch({ params }: BuildLaunchContext): LaunchInvocation {
    const args: string[] = [];
    const model = params.model.trim();
    if (model) args.push('--model', model);
    return { command: 'gemini', args };
  },
};

/** GitHub Copilot CLI (`copilot`). */
export const copilotAdapter: ProviderAdapter = {
  id: 'copilot',
  label: 'GitHub Copilot CLI (experimental)',
  experimental: true,
  buildLaunch({ params }: BuildLaunchContext): LaunchInvocation {
    const args: string[] = [];
    const model = params.model.trim();
    if (model) args.push('--model', model);
    return { command: 'copilot', args };
  },
};

export const EXPERIMENTAL_ADAPTERS: ProviderAdapter[] = [opencodeAdapter, geminiAdapter, copilotAdapter];
