import type { CliToolConfig } from '../orchestrator/types.js';

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

/** Join a resolved invocation (command + args) into a shell command line with safe quoting. */
export function quoteInvocation(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

/** Tokens that mark a permission mode as the documented dangerous/unrestricted mode. */
const DANGEROUS_PERMISSION_TOKENS = new Set([
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
]);

/** True if the given permission argv is a documented dangerous/unrestricted mode. */
export function isDangerousPermissionArgv(perm: string[] | undefined): boolean {
  if (!perm) return false;
  return perm.some((a) => DANGEROUS_PERMISSION_TOKENS.has(a));
}

/**
 * Resolve the permission argv for a permission key, applying the dangerous-mode opt-in gate.
 * When the mode is dangerous and `allowDangerous` is false, returns `[]` (the CLI's own safe
 * default) instead of the blanket flag. Safe/fine-grained modes pass through untouched.
 */
export function resolvePermissionArgs(tool: CliToolConfig, permission: string, allowDangerous: boolean): string[] {
  const perm = tool.permissionModes[permission];
  if (!perm || !perm.length) return [];
  if (!allowDangerous && isDangerousPermissionArgv(perm)) return [];
  return perm;
}

/** Append the model flag + value when both a model and a model flag are configured. */
export function pushModelArgs(args: string[], tool: CliToolConfig, model: string): void {
  const m = model.trim();
  if (m && tool.modelFlag) args.push(tool.modelFlag, m);
}
