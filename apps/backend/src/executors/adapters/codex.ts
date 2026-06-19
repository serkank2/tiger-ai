import type { BuildLaunchContext, LaunchInvocation, ProviderAdapter } from '../types.js';
import { pushModelArgs, resolvePermissionArgs } from '../shell.js';

/**
 * Codex (`codex`) adapter. Argv layout (unchanged from the original buildLaunchCommand):
 *   <executable> [-m M] [-c <key>=<effort>] [...permission] [...extraArgs]
 * Reasoning effort is applied via a `-c` TOML override (`model_reasoning_effort=<effort>`),
 * not a dedicated flag.
 */
export const codexAdapter: ProviderAdapter = {
  id: 'codex',
  label: 'Codex',
  buildLaunch({ tool, params, allowDangerous }: BuildLaunchContext): LaunchInvocation {
    const args: string[] = [];
    pushModelArgs(args, tool, params.model);

    const effort = params.effort.trim();
    if (effort && tool.effortConfigKey) args.push('-c', `${tool.effortConfigKey}=${effort}`);

    args.push(...resolvePermissionArgs(tool, params.permission, allowDangerous));
    if (tool.extraArgs?.length) args.push(...tool.extraArgs);

    return { command: tool.executable, args };
  },
};
