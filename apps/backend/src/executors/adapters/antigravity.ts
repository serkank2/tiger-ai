import type { BuildLaunchContext, LaunchInvocation, ProviderAdapter } from '../types.js';
import { pushModelArgs, resolvePermissionArgs } from '../shell.js';

/**
 * Antigravity (`agy`) adapter. Argv layout (unchanged from the original buildLaunchCommand):
 *   <executable> [--model "Label"] [...permission] [...extraArgs]
 * Antigravity exposes NO reasoning-effort flag — the reasoning level is baked into the model
 * label (e.g. "Gemini 3.1 Pro (High)"), so effort is intentionally ignored here. Model labels
 * contain spaces/parentheses; the caller's shellQuote turns each into a single argument.
 */
export const antigravityAdapter: ProviderAdapter = {
  id: 'antigravity',
  label: 'Antigravity',
  buildLaunch({ tool, params, allowDangerous }: BuildLaunchContext): LaunchInvocation {
    const args: string[] = [];
    pushModelArgs(args, tool, params.model);
    // No effort flag: reasoning level is part of the model label.
    args.push(...resolvePermissionArgs(tool, params.permission, allowDangerous));
    if (tool.extraArgs?.length) args.push(...tool.extraArgs);

    return { command: tool.executable, args };
  },
};
