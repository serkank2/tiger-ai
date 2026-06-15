import type { ShellSpec } from '../store/types.js';

const SHELL_KINDS = new Set<ShellSpec['kind']>([
  'system-default',
  'powershell',
  'pwsh',
  'cmd',
  'bash',
  'zsh',
  'fish',
  'custom',
]);

/** Validate + normalize a shell spec from request input. Returns null if invalid. */
export function normalizeShell(input: unknown): ShellSpec | null {
  if (!input || typeof input !== 'object') return null;
  const s = input as { kind?: unknown; path?: unknown; args?: unknown };
  if (typeof s.kind !== 'string' || !SHELL_KINDS.has(s.kind as ShellSpec['kind'])) return null;
  const out: ShellSpec = { kind: s.kind as ShellSpec['kind'] };
  if (typeof s.path === 'string') out.path = s.path;
  if (Array.isArray(s.args)) out.args = s.args.filter((a): a is string => typeof a === 'string');
  if (out.kind === 'custom' && !out.path) return null;
  return out;
}

export function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');
}

export function toFiniteNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
