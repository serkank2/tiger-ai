import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultTigerConfig } from '../orchestrator/config.js';
import {
  BUILTIN_ROLE_TEMPLATES,
  BUILTIN_TEAM_TEMPLATES,
  validateRoleTemplate,
  validateTeamTemplate,
  type RoleTemplate,
} from '../team/templates.js';
import { InMemoryTeamTemplateRepository, TeamTemplateService } from './team-templates.js';

function service(): TeamTemplateService {
  return new TeamTemplateService(new InMemoryTeamTemplateRepository(), () => defaultTigerConfig());
}

/** A minimal valid custom role; override individual fields to build invalid cases. */
function validRole(overrides: Partial<RoleTemplate> = {}): RoleTemplate {
  return {
    id: 'developer',
    name: 'Developer',
    persona: 'You implement the agreed work items as minimal, correct changes.',
    responsibilities: ['Implement assigned tasks'],
    agent: { tool: 'claude', model: 'sonnet', effort: 'high', permission: 'acceptEdits' },
    canWriteCode: true,
    requiredForSignoff: true,
    ...overrides,
  };
}

function validReviewer(overrides: Partial<RoleTemplate> = {}): RoleTemplate {
  return {
    id: 'reviewer',
    name: 'Reviewer',
    persona: 'You review changes for correctness and convention adherence.',
    responsibilities: ['Review changes'],
    agent: { tool: 'claude', model: 'opus', effort: 'high', permission: 'default' },
    canWriteCode: false,
    requiredForSignoff: true,
    ...overrides,
  };
}

test('every built-in role and team template validates against the default TigerConfig', () => {
  const config = defaultTigerConfig();
  for (const role of BUILTIN_ROLE_TEMPLATES) {
    assert.doesNotThrow(() => validateRoleTemplate(config, role), `role ${role.id} should validate`);
  }
  for (const team of BUILTIN_TEAM_TEMPLATES) {
    assert.doesNotThrow(() => validateTeamTemplate(config, team), `team ${team.name} should validate`);
    // Each built-in team must have at least one role required for sign-off.
    assert.ok(team.roles.some((r) => r.requiredForSignoff), `team ${team.name} needs a sign-off role`);
  }
  // The minimum required built-in teams exist.
  const names = BUILTIN_TEAM_TEMPLATES.map((t) => t.name);
  assert.ok(names.includes('Minimal Team'));
  assert.ok(names.includes('Standard Product Team'));
});

test('built-in roles follow least privilege: only code-writing roles use write-capable modes', () => {
  const writeCapable = new Set(['acceptEdits', 'dangerous', 'workspace-write', 'yolo']);
  for (const role of BUILTIN_ROLE_TEMPLATES) {
    assert.equal(
      role.canWriteCode,
      writeCapable.has(role.agent.permission),
      `role ${role.id} write capability and permission mode must agree`,
    );
  }
});

test('team template service seeds built-ins idempotently and keeps them read-only', async () => {
  const templates = service();
  await templates.initialize();
  const first = await templates.list();
  assert.equal(first.length, BUILTIN_TEAM_TEMPLATES.length);
  assert.ok(first.every((t) => t.builtin));

  const minimal = first.find((t) => t.name === 'Minimal Team');
  assert.ok(minimal);
  assert.equal(minimal.builtin, true);

  // Re-running initialize across a "restart" does not duplicate or change the count.
  await templates.initialize();
  const second = await templates.list();
  assert.equal(second.length, BUILTIN_TEAM_TEMPLATES.length);

  // Built-ins cannot be edited or archived.
  await assert.rejects(() => templates.update(minimal.id!, { description: 'changed' }), /built-in team templates cannot/);
  await assert.rejects(() => templates.archive(minimal.id!), /built-in team templates cannot/);
});

test('custom team templates round-trip: create, update, duplicate, archive', async () => {
  const templates = service();
  await templates.initialize();

  const created = await templates.create({
    name: 'My Team',
    description: 'custom',
    roles: [validRole(), validReviewer()],
  });
  assert.equal(created.builtin, false);
  assert.equal(created.roles.length, 2);
  assert.ok(created.id);

  const updated = await templates.update(created.id!, {
    name: 'My Team',
    roles: [validRole(), validReviewer(), validReviewer({ id: 'reviewer-2', name: 'Second Reviewer' })],
  });
  assert.equal(updated.roles.length, 3);
  assert.equal(updated.version, 2);

  const duplicate = await templates.duplicate(created.id!);
  assert.equal(duplicate.name, 'My Team Copy');
  assert.equal(duplicate.builtin, false);
  assert.notEqual(duplicate.id, created.id);

  await templates.archive(created.id!);
  const remaining = await templates.list();
  assert.ok(!remaining.some((t) => t.id === created.id));
  // The duplicate and the built-ins survive the archive.
  assert.ok(remaining.some((t) => t.id === duplicate.id));
});

test('invalid custom team templates are rejected with clear English errors', async () => {
  const templates = service();

  // Empty name.
  await assert.rejects(() => templates.create({ name: '   ', roles: [validRole()] }), /name is required/);

  // Unknown permission mode.
  await assert.rejects(
    () =>
      templates.create({
        name: 'Bad Perm',
        roles: [validRole({ agent: { tool: 'claude', model: 'sonnet', effort: 'high', permission: 'nope' } })],
      }),
    /not a known claude permission mode/,
  );

  // Unknown model.
  await assert.rejects(
    () =>
      templates.create({
        name: 'Bad Model',
        roles: [validRole({ agent: { tool: 'claude', model: 'gpt-4', effort: 'high', permission: 'acceptEdits' } })],
      }),
    /not a configured claude model/,
  );

  // Unknown CLI tool.
  await assert.rejects(
    () =>
      templates.create({
        name: 'Bad CLI',
        roles: [validRole({ agent: { tool: 'gemini' as never, model: 'sonnet', effort: 'high', permission: 'acceptEdits' } })],
      }),
    /role tool must be one of/,
  );

  // A read-only role using a write-capable mode violates least privilege.
  await assert.rejects(
    () =>
      templates.create({
        name: 'Over Priv',
        roles: [validReviewer({ agent: { tool: 'claude', model: 'opus', effort: 'high', permission: 'dangerous' } })],
      }),
    /least privilege/,
  );

  // No role is required for sign-off → the team could never complete.
  await assert.rejects(
    () =>
      templates.create({
        name: 'No Signoff',
        roles: [validRole({ requiredForSignoff: false }), validReviewer({ requiredForSignoff: false })],
      }),
    /at least one role required for sign-off/,
  );

  // No roles at all.
  await assert.rejects(() => templates.create({ name: 'Empty', roles: [] }), /at least one role/);
});

test('duplicate role ids within a team are rejected', async () => {
  const templates = service();
  await assert.rejects(
    () => templates.create({ name: 'Dupe Ids', roles: [validRole(), validRole()] }),
    /duplicate role id/,
  );
});
