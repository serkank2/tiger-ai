import { describe, expect, it } from 'vitest';
import { deriveTeamRoleKind, displayRoleName, isLeadRole, nextRoleName, uniqueRoleId } from '~/lib/teamRoles';

describe('team role helpers', () => {
  it('labels repeated same-kind instances distinctly', () => {
    const roles = [
      { id: 'developer', name: 'Developer', canWriteCode: true, requiredForSignoff: true },
      { id: 'developer-2', name: 'Developer #2', canWriteCode: true, requiredForSignoff: true },
      { id: 'developer-3', name: 'Developer', canWriteCode: true, requiredForSignoff: true },
    ];

    expect(displayRoleName(roles, roles[0]!, 0)).toBe('Developer');
    expect(displayRoleName(roles, roles[1]!, 1)).toBe('Developer #2');
    expect(displayRoleName(roles, roles[2]!, 2)).toBe('Developer #3');
  });

  it('keeps different same-kind names as their own labels', () => {
    const roles = [
      { id: 'frontend', name: 'Frontend Developer', canWriteCode: true },
      { id: 'backend', name: 'Backend Developer', canWriteCode: true },
    ];

    expect(displayRoleName(roles, roles[0]!, 0)).toBe('Frontend Developer');
    expect(displayRoleName(roles, roles[1]!, 1)).toBe('Backend Developer');
  });

  it('identifies Lead roles and generates the next non-Lead instance name/id', () => {
    const lead = { id: 'lead', name: 'Lead / Coordinator', requiredForSignoff: true };
    const dev = { id: 'developer', name: 'Developer', canWriteCode: true, requiredForSignoff: true };
    const roles = [lead, dev];

    expect(isLeadRole(lead)).toBe(true);
    expect(deriveTeamRoleKind(dev)).toBe('developer');
    expect(nextRoleName(roles, dev)).toBe('Developer #2');
    expect(uniqueRoleId(roles, 'Developer #2')).toBe('developer-2');
  });
});
