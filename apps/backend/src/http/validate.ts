import path from 'node:path';
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
  if (out.kind === 'custom') {
    if (!out.path) return null;
    if (out.path.startsWith('\\\\') || out.path.startsWith('//')) return null; // no UNC/device shell
    const resolved = path.resolve(out.path);
    if (!path.isAbsolute(resolved) || resolved.startsWith('\\\\')) return null; // require an absolute local path
    out.path = resolved;
  }
  return out;
}

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
/** Accept only hex colors for group swatches (rejects arbitrary CSS like url(...)). */
export function isValidColor(v: unknown): v is string {
  return typeof v === 'string' && HEX_COLOR.test(v.trim());
}

export function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');
}

/** A valid terminal dimension: a positive integer in a sane range, else undefined. */
export function toDimension(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 2000 ? v : undefined;
}

/** Strict boolean: only an actual boolean counts (avoids "false" -> true coercion). */
export function asBool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
