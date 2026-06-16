// Practical single-line input limits per shell. cmd.exe truncates command lines at
// ~8191 chars; Windows PowerShell at ~16K; bash/zsh/custom are effectively unbounded
// for our purposes. Shared by the command bar and the prompt composer (DRY).
export const SHELL_LIMITS: Record<string, number> = {
  cmd: 8190,
  'system-default': 8190, // may resolve to cmd.exe on Windows — stay conservative
  powershell: 16380,
  pwsh: 16380,
};

export function limitFor(kind?: string): number {
  return SHELL_LIMITS[kind ?? 'system-default'] ?? Infinity;
}

/** Strictest (smallest) limit across a set of shell kinds; Infinity if none. */
export function strictestLimit(kinds: (string | undefined)[]): number {
  return kinds.length ? Math.min(...kinds.map(limitFor)) : Infinity;
}
