import type { BuildLaunchContext, LaunchInvocation, ProviderAdapter } from '../types.js';
import { pushModelArgs, resolvePermissionArgs } from '../shell.js';

/**
 * Claude (`claude`) adapter. Argv layout (unchanged from the original buildLaunchCommand):
 *   <executable> [--model M] [--effort E] [...permission] [...extraArgs]
 * Reasoning effort is a first-class flag (`--effort`).
 */
export const claudeAdapter: ProviderAdapter = {
  id: 'claude',
  label: 'Claude',
  buildLaunch({ tool, params, allowDangerous }: BuildLaunchContext): LaunchInvocation {
    const args: string[] = [];
    pushModelArgs(args, tool, params.model);

    const effort = params.effort.trim();
    if (effort && tool.effortFlag) args.push(tool.effortFlag, effort);

    args.push(...resolvePermissionArgs(tool, params.permission, allowDangerous));
    if (tool.extraArgs?.length) args.push(...tool.extraArgs);

    return { command: tool.executable, args };
  },
};
