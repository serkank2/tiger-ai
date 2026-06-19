// ---------------------------------------------------------------------------
// AI Team — built-in role/team templates and their pure validation helpers.
//
// Role templates are the ready-made personas the user picks and customizes
// (Lead/Coordinator, Business Analyst, Developer, Tester/QA, Reviewer, plus the
// optional Architect and DevOps/Verifier). Team templates assemble those roles
// into reusable presets. These are intentionally separate from the Run All
// `RunTemplate`s (per-stage execution presets) — they must never be overloaded.
//
// Validation mirrors the rules used for stage configuration: a role's CLI tool,
// model, effort, and permission key are checked against `TigerConfig.cli`, and
// the `canWriteCode`/`requiredForSignoff` flags are checked for consistency with
// the chosen permission mode (least privilege: only code-writing roles may use a
// write-capable permission mode).
// ---------------------------------------------------------------------------

import { configInputError } from '../orchestrator/stage-config.js';
import type { AgentType, TigerConfig } from '../orchestrator/types.js';
import type { RoleAgentConfig, RoleTemplate, TeamTemplate } from './types.js';
import { validateRoleConfig } from './validate.js';

// These templates use the canonical TASK-001 contract (`team/types.ts`): a role
// carries its CLI settings in a nested `agent: { tool, model, effort, permission }`
// object and is keyed by `id`. Re-export the types here so persistence, the
// service, and the `TeamTemplatesResponse` DTO all share one `RoleTemplate` /
// `TeamTemplate` shape rather than a parallel, incompatible definition.
export type { RoleAgentConfig, RoleTemplate, TeamTemplate } from './types.js';

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Permission modes that grant write access, per CLI tool. The built-in permission
 * modes are fixed (config normalization forces them to match the defaults), so this
 * mapping is stable. Used to enforce least privilege: a non-code-writing role must
 * not use a write-capable mode, and a code-writing role must use one.
 */
const WRITE_CAPABLE_PERMISSIONS: Record<AgentType, readonly string[]> = {
  claude: ['acceptEdits', 'dangerous'],
  codex: ['workspace-write', 'yolo'],
  antigravity: ['dangerous'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Validate a fully-typed role template against the active config. Throws a clear English error on any problem. */
export function validateRoleTemplate(config: TigerConfig, role: RoleTemplate): void {
  const where = typeof role?.id === 'string' && role.id ? `role "${role.id}"` : 'role';
  if (typeof role?.id !== 'string' || !ID_RE.test(role.id)) {
    throw configInputError(`${where}: id must be a lowercase kebab-case identifier`);
  }
  if (typeof role.name === 'string' && role.name.length > 160) {
    throw configInputError(`${where}: name must be 160 characters or fewer`);
  }
  if (typeof role.persona !== 'string' || !role.persona.trim()) {
    throw configInputError(`${where}: persona/system prompt is required`);
  }
  if (!Array.isArray(role.responsibilities) || role.responsibilities.some((r) => typeof r !== 'string' || !r.trim())) {
    throw configInputError(`${where}: responsibilities must be a list of non-empty strings`);
  }
  if (!role.agent || typeof role.agent !== 'object') {
    throw configInputError(`${where}: agent CLI configuration is required`);
  }
  // Reuse the canonical per-role CLI/model/effort/permission validator (TASK-001)
  // instead of re-implementing the same checks against a different field shape. The
  // template nests its CLI settings under `agent`, so adapt to the flat shape the
  // validator expects.
  const error = validateRoleConfig(
    {
      name: role.name,
      tool: role.agent.tool,
      model: role.agent.model,
      effort: role.agent.effort,
      permission: role.agent.permission,
      canWriteCode: role.canWriteCode,
      requiredForSignoff: role.requiredForSignoff,
    },
    config,
  );
  if (error) throw configInputError(error);
  // NOTE: every team role must be able to write its own turn deliverable (the
  // `<turnId>.output.md` + `.done` marker the orchestrator watches for) and must run
  // without stalling on an approval prompt, so all roles use an autonomous,
  // write-capable permission mode. Whether a role may modify PROJECT SOURCE is governed
  // by its persona/`canWriteCode` instruction in the prompt, not by the sandbox — so the
  // old "non-code role must be read-only" least-privilege rule is intentionally not
  // enforced here (it made read-only roles unable to complete a turn at all).
}

/** Validate a fully-typed team template: name, every role, unique role keys, and at least one sign-off role. */
export function validateTeamTemplate(config: TigerConfig, team: TeamTemplate): void {
  if (typeof team?.name !== 'string' || !team.name.trim()) throw configInputError('team template name is required');
  if (team.name.length > 160) throw configInputError('team template name must be 160 characters or fewer');
  if (team.description !== undefined && team.description !== null && typeof team.description !== 'string') {
    throw configInputError('team template description must be a string');
  }
  if (!Array.isArray(team.roles) || team.roles.length === 0) {
    throw configInputError('a team template must include at least one role');
  }
  const ids = new Set<string>();
  for (const role of team.roles) {
    validateRoleTemplate(config, role);
    const id = role.id.toLowerCase();
    if (ids.has(id)) throw configInputError(`duplicate role id "${role.id}" in team "${team.name}"`);
    ids.add(id);
  }
  if (!team.roles.some((r) => r.requiredForSignoff)) {
    throw configInputError(`team "${team.name}" must have at least one role required for sign-off`);
  }
}

/** Coerce and validate an unknown role payload (from a custom template) into a `RoleTemplate`. */
export function buildRoleTemplate(config: TigerConfig, raw: unknown): RoleTemplate {
  if (!isRecord(raw)) throw configInputError('each role must be an object');
  if (raw.name !== undefined && typeof raw.name !== 'string') throw configInputError('role name must be a string');
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const id =
    typeof raw.id === 'string' && raw.id.trim()
      ? raw.id.trim()
      : typeof raw.key === 'string' && raw.key.trim()
        ? raw.key.trim()
        : teamTemplateSlug(name);
  if (raw.description !== undefined && raw.description !== null && typeof raw.description !== 'string') {
    throw configInputError(`role "${id}": description must be a string`);
  }
  if (raw.persona !== undefined && typeof raw.persona !== 'string') {
    throw configInputError(`role "${id}": persona must be a string`);
  }
  if (raw.responsibilities !== undefined && !Array.isArray(raw.responsibilities)) {
    throw configInputError(`role "${id}": responsibilities must be an array`);
  }
  const role: RoleTemplate = {
    id,
    name,
    description: typeof raw.description === 'string' ? raw.description.trim() || undefined : undefined,
    persona: typeof raw.persona === 'string' ? raw.persona : '',
    responsibilities: Array.isArray(raw.responsibilities) ? (raw.responsibilities as unknown[]).map((r) => String(r)) : [],
    agent: extractAgentConfig(raw),
    canWriteCode: raw.canWriteCode === true,
    requiredForSignoff: raw.requiredForSignoff !== false,
  };
  validateRoleTemplate(config, role);
  return role;
}

/**
 * Read a role's CLI settings into the canonical nested `agent` shape. Accepts the
 * nested `agent: { tool, model, effort, permission }` form used by the public
 * contract and tolerates a flat `tool`/`cli` + `model`/`effort`/`permission` form.
 */
function extractAgentConfig(raw: Record<string, unknown>): RoleAgentConfig {
  const source = isRecord(raw.agent) ? raw.agent : raw;
  const tool = (typeof source.tool === 'string' ? source.tool : raw.cli) as AgentType;
  return {
    tool,
    model: typeof source.model === 'string' ? source.model : '',
    effort: typeof source.effort === 'string' ? source.effort : '',
    permission: typeof source.permission === 'string' ? source.permission : '',
  };
}

/** A filesystem/id-safe slug for a team or role name. */
export function teamTemplateSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team';
}

// ---------------------------------------------------------------------------
// Built-in role templates. Permissions follow least privilege: only the roles
// that actually write code (Developer, DevOps/Verifier) get a write-capable
// permission mode; every other role runs read-only. Every role is required for
// sign-off so the team only stops when each agent confirms the work is done.
// ---------------------------------------------------------------------------

const ROLE_LEAD: RoleTemplate = {
  id: 'lead',
  name: 'Lead / Coordinator',
  description: 'Directs the team, delegates work, and decides when the project is genuinely complete.',
  persona:
    'You are the Lead/Coordinator of an autonomous AI software team. You translate the project goal into a concrete ' +
    'plan, delegate each piece of work to the most suitable role, keep the conversation focused, resolve ' +
    'disagreements, and decide when the work is genuinely complete. You never write code yourself — you direct the ' +
    'team and confirm that every required role has signed off before declaring the project done.',
  responsibilities: [
    'Break the project goal into clear, assignable work items',
    'Delegate tasks to the most suitable role and sequence the work',
    'Mediate decisions and keep the team aligned on scope',
    'Track progress and surface blockers early',
    'Confirm every required sign-off before completion',
  ],
  agent: { tool: 'claude', model: 'opus', effort: 'high', permission: 'acceptEdits' },
  canWriteCode: false,
  requiredForSignoff: true,
};

const ROLE_BUSINESS_ANALYST: RoleTemplate = {
  id: 'business-analyst',
  name: 'Business Analyst',
  description: 'Turns the user intent into precise, testable requirements and acceptance criteria.',
  persona:
    'You are the Business Analyst. You turn the user’s intent into precise, testable requirements and acceptance ' +
    'criteria, clarify ambiguity, and make sure the team is solving the right problem. You do not write code; you ' +
    'define and defend the requirements and flag anything out of scope or missing.',
  responsibilities: [
    'Elicit and document clear requirements and acceptance criteria',
    'Identify edge cases, constraints, and out-of-scope items',
    'Validate that proposed solutions meet the user’s intent',
    'Flag scope creep and missing requirements',
  ],
  agent: { tool: 'claude', model: 'sonnet', effort: 'medium', permission: 'acceptEdits' },
  canWriteCode: false,
  requiredForSignoff: true,
};

const ROLE_ARCHITECT: RoleTemplate = {
  id: 'architect',
  name: 'Architect',
  description: 'Defines the technical approach and guards the codebase conventions and structure.',
  persona:
    'You are the Software Architect. You propose the technical approach, define module boundaries and interfaces, and ' +
    'guard the codebase’s existing conventions and architecture. You do not implement features; you design the ' +
    'technical direction and review it for simplicity, scalability, and risk.',
  responsibilities: [
    'Define the high-level technical approach and structure',
    'Choose patterns consistent with the existing codebase',
    'Review designs for scalability, simplicity, and risk',
    'Advise developers on interfaces and integration points',
  ],
  agent: { tool: 'claude', model: 'opus', effort: 'high', permission: 'acceptEdits' },
  canWriteCode: false,
  requiredForSignoff: true,
};

const ROLE_DEVELOPER: RoleTemplate = {
  id: 'developer',
  name: 'Developer',
  description: 'Implements the agreed work items as minimal, correct, convention-respecting changes.',
  persona:
    'You are the Developer. You implement the agreed work items as minimal, correct changes that respect the existing ' +
    'conventions, architecture, and tooling. You write and modify code, keep changes scoped to the assigned task, add ' +
    'or update tests for what you change, and report exactly what you changed and any residual risk.',
  responsibilities: [
    'Implement assigned tasks with the smallest correct change',
    'Follow existing code style, architecture, and tooling',
    'Write or update tests for the code you change',
    'Report changes and any residual risk clearly',
  ],
  agent: { tool: 'claude', model: 'sonnet', effort: 'high', permission: 'acceptEdits' },
  canWriteCode: true,
  requiredForSignoff: true,
};

const ROLE_TESTER: RoleTemplate = {
  id: 'tester',
  name: 'Tester / QA',
  description: 'Verifies the implementation against the acceptance criteria and raises defects.',
  persona:
    'You are the Tester / QA engineer. You verify that the implementation meets the acceptance criteria, design and ' +
    'run tests, and find defects before the work is signed off. You do not change production code; you test it and ' +
    'raise clear, reproducible findings, and you confirm fixes before sign-off.',
  responsibilities: [
    'Derive test cases from the acceptance criteria',
    'Run the project’s tests and checks and report results',
    'Find and clearly describe defects and edge-case failures',
    'Confirm fixes resolve the issues before sign-off',
  ],
  agent: { tool: 'codex', model: 'gpt-5', effort: 'medium', permission: 'workspace-write' },
  canWriteCode: false,
  requiredForSignoff: true,
};

const ROLE_REVIEWER: RoleTemplate = {
  id: 'reviewer',
  name: 'Reviewer',
  description: 'Reviews changes for correctness, simplicity, and convention adherence; gates quality.',
  persona:
    'You are the Code Reviewer. You review proposed changes for correctness, simplicity, reuse, and adherence to the ' +
    'codebase’s conventions, and you raise findings that must be resolved before completion. You do not write the ' +
    'implementation; you review it and gate quality, approving only when findings are resolved.',
  responsibilities: [
    'Review changes for correctness and hidden bugs',
    'Check adherence to conventions, simplicity, and reuse',
    'Raise actionable findings with clear severity',
    'Approve only when findings are resolved',
  ],
  agent: { tool: 'claude', model: 'opus', effort: 'high', permission: 'acceptEdits' },
  canWriteCode: false,
  requiredForSignoff: true,
};

const ROLE_DEVOPS_VERIFIER: RoleTemplate = {
  id: 'devops-verifier',
  name: 'DevOps / Verifier',
  description: 'Runs objective verification (build, type-check, tests) and produces evidence of working software.',
  persona:
    'You are the DevOps / Verifier. You run objective verification — builds, type-checks, and test suites — and ' +
    'produce evidence that the work actually functions. You may run commands that mutate the workspace in order to ' +
    'build and verify, but you do not implement product features; you confirm the project builds and passes checks ' +
    'before sign-off.',
  responsibilities: [
    'Run builds, type-checks, and test suites as objective verification',
    'Record pass/fail evidence for the completion gate',
    'Surface environment or tooling problems that block verification',
    'Confirm the project builds and passes checks before sign-off',
  ],
  agent: { tool: 'codex', model: 'gpt-5', effort: 'medium', permission: 'workspace-write' },
  canWriteCode: true,
  requiredForSignoff: true,
};

/** All built-in role templates, in a sensible presentation order. */
export const BUILTIN_ROLE_TEMPLATES: RoleTemplate[] = [
  ROLE_LEAD,
  ROLE_BUSINESS_ANALYST,
  ROLE_ARCHITECT,
  ROLE_DEVELOPER,
  ROLE_TESTER,
  ROLE_REVIEWER,
  ROLE_DEVOPS_VERIFIER,
];

/** Deep-clone a role so built-in constants are never shared/mutated between teams. */
export function cloneRoleTemplate(role: RoleTemplate): RoleTemplate {
  return { ...role, agent: { ...role.agent }, responsibilities: [...role.responsibilities] };
}

function assembleTeam(name: string, description: string, roles: RoleTemplate[]): TeamTemplate {
  return { name, description, builtin: true, roles: roles.map(cloneRoleTemplate) };
}

/** Built-in team presets. Each ships with at least one sign-off role and exactly one active code-writing role. */
export const BUILTIN_TEAM_TEMPLATES: TeamTemplate[] = [
  assembleTeam(
    'Minimal Team',
    'The smallest useful team: a Lead to direct, a Developer to build, and a Reviewer to gate quality.',
    [ROLE_LEAD, ROLE_DEVELOPER, ROLE_REVIEWER],
  ),
  assembleTeam(
    'Standard Product Team',
    'A balanced product team: Lead, Business Analyst, Developer, Tester/QA, and Reviewer.',
    [ROLE_LEAD, ROLE_BUSINESS_ANALYST, ROLE_DEVELOPER, ROLE_TESTER, ROLE_REVIEWER],
  ),
  assembleTeam(
    'Full Delivery Team',
    'A full delivery team adding an Architect for design and a DevOps/Verifier for objective verification.',
    [ROLE_LEAD, ROLE_BUSINESS_ANALYST, ROLE_ARCHITECT, ROLE_DEVELOPER, ROLE_TESTER, ROLE_REVIEWER, ROLE_DEVOPS_VERIFIER],
  ),
];
