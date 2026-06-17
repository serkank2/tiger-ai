import type { ShellKind } from '~/types';

const DRIVE_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
const POSIX_ABSOLUTE = /^\//;
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

export function usesWindowsPathSyntax(...paths: Array<string | null | undefined>): boolean {
  return paths.some((path) => {
    const p = path?.trim();
    return !!p && (DRIVE_ABSOLUTE.test(p) || p.includes('\\'));
  });
}

export function absoluteLocalPathError(
  value: string,
  label: string,
  requireWindowsDrive: boolean,
): string | null {
  const p = value.trim();
  if (!p) return null;
  if (p.startsWith('\\\\') || p.startsWith('//')) return `${label} must be a local path; UNC paths are not allowed.`;
  if (requireWindowsDrive) {
    return DRIVE_ABSOLUTE.test(p) ? null : `${label} must be an absolute path with a drive letter.`;
  }
  return DRIVE_ABSOLUTE.test(p) || POSIX_ABSOLUTE.test(p) ? null : `${label} must be an absolute path.`;
}

export function customShellPathError(
  kind: ShellKind,
  value: string,
  label: string,
  requireWindowsDrive: boolean,
): string | null {
  if (kind !== 'custom') return null;
  const p = value.trim();
  if (!p) return `${label} is required.`;
  return absoluteLocalPathError(p, label, requireWindowsDrive);
}

export function envTextError(value: string): string | null {
  const lines = value.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    const key = eq >= 0 ? line.slice(0, eq).trim() : '';
    if (eq <= 0 || !key) return `Line ${i + 1} must use KEY=VALUE with a non-empty key.`;
  }
  return null;
}

export function hexColorError(value: string, label = 'Color'): string | null {
  const color = value.trim();
  if (!color) return `${label} is required.`;
  return HEX_COLOR.test(color) ? null : `${label} must be a hex value like #f59e42.`;
}
