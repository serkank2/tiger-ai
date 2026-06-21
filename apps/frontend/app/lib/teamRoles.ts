export type TeamRoleKind = 'lead' | 'coordinator' | 'analyst' | 'developer' | 'tester' | 'reviewer' | 'signoff';

export interface TeamRoleLike {
  id?: string;
  name: string;
  canWriteCode?: boolean;
  requiredForSignoff?: boolean;
}

const ROLE_KIND_LABELS: Record<TeamRoleKind, string> = {
  lead: 'Lead',
  coordinator: 'Coordinator',
  analyst: 'Analyst',
  developer: 'Developer',
  tester: 'Tester',
  reviewer: 'Reviewer',
  signoff: 'Sign-off',
};

export function deriveTeamRoleKind(role: TeamRoleLike): TeamRoleKind {
  const text = `${role.id ?? ''} ${role.name}`.toLowerCase();
  if (/\blead\b|tech ?lead|team ?lead/.test(text)) return 'lead';
  if (/coordinat|manager|product owner|\bpm\b/.test(text)) return 'coordinator';
  if (/analy|requirement|business/.test(text)) return 'analyst';
  if (/develop|engineer|programmer|coder|implement/.test(text)) return 'developer';
  if (/test|\bqa\b|quality/.test(text)) return 'tester';
  if (/review/.test(text)) return 'reviewer';
  if (role.canWriteCode) return 'developer';
  if (role.requiredForSignoff) return 'signoff';
  return 'coordinator';
}

export function isLeadRole(role: TeamRoleLike): boolean {
  return deriveTeamRoleKind(role) === 'lead';
}

export function roleKindLabel(kind: TeamRoleKind): string {
  return ROLE_KIND_LABELS[kind];
}

export function stripInstanceNumber(name: string): string {
  return name.trim().replace(/\s+#\d+$/, '').trim();
}

export function roleBaseName(role: TeamRoleLike): string {
  return stripInstanceNumber(role.name) || roleKindLabel(deriveTeamRoleKind(role));
}

function roleAt<T extends TeamRoleLike>(roles: readonly T[], role: T, index?: number): number {
  if (typeof index === 'number' && index >= 0 && index < roles.length) return index;
  const sameObject = roles.findIndex((entry) => entry === role);
  if (sameObject >= 0) return sameObject;
  if (role.id) {
    const sameId = roles.findIndex((entry) => entry.id === role.id);
    if (sameId >= 0) return sameId;
  }
  return 0;
}

export function displayRoleName<T extends TeamRoleLike>(roles: readonly T[], role: T, index?: number): string {
  const targetIndex = roleAt(roles, role, index);
  const kind = deriveTeamRoleKind(role);
  const base = roleBaseName(role);
  const sameBase = roles
    .map((entry, entryIndex) => ({ entry, entryIndex }))
    .filter(({ entry }) => deriveTeamRoleKind(entry) === kind && roleBaseName(entry) === base);
  if (sameBase.length <= 1) return role.name.trim() || base;
  const ordinal = sameBase.filter(({ entryIndex }) => entryIndex <= targetIndex).length;
  return ordinal <= 1 ? base : `${base} #${ordinal}`;
}

export function nextRoleName<T extends TeamRoleLike>(roles: readonly T[], source: TeamRoleLike): string {
  const kind = deriveTeamRoleKind(source);
  const base = roleBaseName(source);
  const count = roles.filter((entry) => deriveTeamRoleKind(entry) === kind && roleBaseName(entry) === base).length;
  return count <= 0 ? base : `${base} #${count + 1}`;
}

export function roleSlug(name: string): string {
  return stripInstanceNumber(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'role';
}

export function uniqueRoleId<T extends TeamRoleLike>(roles: readonly T[], name: string, currentIndex?: number): string {
  const used = new Set(
    roles
      .map((role, index) => (index === currentIndex ? '' : role.id?.trim()))
      .filter((id): id is string => Boolean(id)),
  );
  const base = roleSlug(name);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
