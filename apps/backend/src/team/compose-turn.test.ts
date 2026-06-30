import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TigerPaths } from '../orchestrator/paths.js';
import { composeRoleTurnPrompt, normalizeTeamRole, type RoleTurnRole } from './compose-turn.js';
import { BUILTIN_ROLE_TEMPLATES } from './templates.js';

async function tmpPaths(projectPrompt?: string): Promise<{ paths: TigerPaths; cleanup: () => Promise<void> }> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-compose-'));
  const paths = new TigerPaths(ws);
  await fs.mkdir(paths.root, { recursive: true });
  if (projectPrompt !== undefined) {
    await fs.writeFile(paths.projectPromptFile, projectPrompt, 'utf8');
  }
  return { paths, cleanup: () => fs.rm(ws, { recursive: true, force: true }) };
}

function baseOpts(paths: TigerPaths, over: Partial<Parameters<typeof composeRoleTurnPrompt>[0]> = {}) {
  return {
    paths,
    runId: 'run-1',
    turnId: 'turn-1',
    role: { id: 'dev', name: 'Developer', persona: 'A careful engineer.', responsibilities: ['Ship code'], agentType: 'claude' as const },
    outputPath: path.join(paths.root, 'team', 'out.md'),
    markerPath: path.join(paths.root, 'team', 'out.done'),
    ...over,
  };
}

function builtInRole(id: string) {
  const role = BUILTIN_ROLE_TEMPLATES.find((item) => item.id === id);
  assert.ok(role, `missing built-in role ${id}`);
  return role;
}

// --- normalizeTeamRole (pure) ---

test('normalizeTeamRole resolves agentType from agentType > agent.tool > tool, defaulting to codex', () => {
  assert.equal(normalizeTeamRole({ id: 'a', name: 'A', agentType: 'claude' }).agentType, 'claude');
  assert.equal(normalizeTeamRole({ id: 'b', name: 'B', agent: { tool: 'antigravity' } }).agentType, 'antigravity');
  assert.equal(normalizeTeamRole({ id: 'c', name: 'C', tool: 'codex' }).agentType, 'codex');
  assert.equal(normalizeTeamRole({ id: 'd', name: 'D' }).agentType, 'codex');
});

test('normalizeTeamRole prefers persona, then description, then a synthesized default', () => {
  assert.equal(normalizeTeamRole({ id: 'a', name: 'A', persona: '  Real persona ' }).persona, 'Real persona');
  assert.equal(normalizeTeamRole({ id: 'b', name: 'B', description: ' From desc ' }).persona, 'From desc');
  assert.equal(normalizeTeamRole({ id: 'c', name: 'Reviewer' }).persona, 'Act as Reviewer for this team turn.');
});

test('normalizeTeamRole falls back to a default responsibility when none/empty are supplied', () => {
  const r = normalizeTeamRole({ id: 'a', name: 'A', responsibilities: [] } as RoleTurnRole);
  assert.equal(r.responsibilities.length, 1);
  assert.match(r.responsibilities[0]!, /Contribute from this role/);
});

// --- composeRoleTurnPrompt ---

test('composeRoleTurnPrompt embeds run/turn/role ids, persona, project prompt and the output contract', async () => {
  const { paths, cleanup } = await tmpPaths('Build a CLI tool.');
  try {
    const { prompt } = await composeRoleTurnPrompt(baseOpts(paths));
    assert.match(prompt, /Your team run ID is: run-1/);
    assert.match(prompt, /Your turn ID is: turn-1/);
    assert.match(prompt, /Your role ID is: dev/);
    assert.match(prompt, /A careful engineer\./);
    assert.match(prompt, /Build a CLI tool\./);
    assert.match(prompt, /STRICT STRUCTURED OUTPUT CONTRACT/);
    assert.match(prompt, /SignOffDirective/);
    // The absolute output + marker paths must be present verbatim.
    assert.ok(prompt.includes(baseOpts(paths).outputPath));
    assert.ok(prompt.includes(baseOpts(paths).markerPath));
  } finally {
    await cleanup();
  }
});

test('composeRoleTurnPrompt uses a clear placeholder when the project prompt file is missing', async () => {
  const { paths, cleanup } = await tmpPaths(); // no project-prompt.md written
  try {
    const { prompt } = await composeRoleTurnPrompt(baseOpts(paths));
    assert.match(prompt, /\(project prompt not found\)/);
    assert.match(prompt, /\(no prior team messages\)/);
  } finally {
    await cleanup();
  }
});

test('composeRoleTurnPrompt renders assigned task, finding, steering, verification and completion-gate context', async () => {
  const { paths, cleanup } = await tmpPaths('goal');
  try {
    const { prompt } = await composeRoleTurnPrompt(
      baseOpts(paths, {
        assignedTask: { id: 'TASK-7', title: 'Wire the bus', content: 'Connect A to B.' },
        finding: { id: 'F-1', title: 'Leak', content: 'A handle leaks.' },
        steering: ['Prefer the smaller change'],
        verification: ['npm test must pass'],
        completionStatus: ['dev has not signed off'],
      }),
    );
    assert.match(prompt, /Assigned Task: TASK-7 -- Wire the bus/);
    assert.match(prompt, /Connect A to B\./);
    assert.match(prompt, /Finding: F-1 -- Leak/);
    assert.match(prompt, /Prefer the smaller change/);
    assert.match(prompt, /npm test must pass/);
    assert.match(prompt, /What The Run Still Needs To Complete/);
    assert.match(prompt, /dev has not signed off/);
  } finally {
    await cleanup();
  }
});

test('composeRoleTurnPrompt shows the no-task placeholder when no task is assigned', async () => {
  const { paths, cleanup } = await tmpPaths('goal');
  try {
    const { prompt } = await composeRoleTurnPrompt(baseOpts(paths));
    assert.match(prompt, /\(no specific task assigned for this turn\)/);
  } finally {
    await cleanup();
  }
});

test('composeRoleTurnPrompt keeps the per-turn assignment intact even when the project prompt is enormous', async () => {
  // A huge project prompt must not starve the priority-spent assignment block (budget order test).
  const huge = 'X'.repeat(2_000_000);
  const { paths, cleanup } = await tmpPaths(huge);
  try {
    const { prompt, size } = await composeRoleTurnPrompt(
      baseOpts(paths, { assignedTask: { id: 'T1', content: 'CRITICAL_ASSIGNMENT_TOKEN do the thing' } }),
    );
    assert.match(prompt, /CRITICAL_ASSIGNMENT_TOKEN/, 'the assignment must survive a transcript/prompt budget squeeze');
    assert.match(prompt, /A careful engineer\./, 'the persona must survive too');
    // The project prompt itself must have been truncated to respect the cap.
    assert.match(prompt, /truncated to respect Tiger context caps/);
    assert.ok(size.characters > 0);
  } finally {
    await cleanup();
  }
});

test('composeRoleTurnPrompt renders the role-system prompt improvements for company-mode teams', async () => {
  const { paths, cleanup } = await tmpPaths('Coordinate a parallel company-mode team.');
  try {
    const lead = await composeRoleTurnPrompt(baseOpts(paths, { role: builtInRole('lead') }));
    assert.match(lead.prompt, /CLI-first autonomous coding agent/);
    assert.match(lead.prompt, /There are NO model API keys/);
    assert.match(lead.prompt, /keep every idle non-Lead role instance busy/);
    assert.match(lead.prompt, /DELEGATE EVERY NON-COORDINATION ACTION/);
    assert.match(lead.prompt, /do NOT inspect source files, diffs, logs, artifacts, or external references/);
    assert.match(lead.prompt, /do NOT research answers yourself/);
    assert.match(lead.prompt, /address a role KIND/);
    assert.match(lead.prompt, /project-complete/);
    assert.match(lead.prompt, /Passing gates is necessary but not sufficient/);
    assert.match(lead.prompt, /Do not assume you are the only role working/);
    assert.match(lead.prompt, /Only the Lead assigns executable work/);
    assert.match(lead.prompt, /Business Analyst's acceptance criteria become the Tester's cases/);

    const ba = await composeRoleTurnPrompt(baseOpts(paths, { role: builtInRole('business-analyst') }));
    assert.match(ba.prompt, /spec schema: success metrics, acceptance criteria, edge-case matrix/);
    assert.match(ba.prompt, /BA-to-Tester cases/);
    assert.match(ba.prompt, /feed the Lead updated requirements/);

    const developer = await composeRoleTurnPrompt(baseOpts(paths, { role: builtInRole('developer') }));
    assert.match(developer.prompt, /other developers may be editing in parallel/);
    assert.match(developer.prompt, /isolated git\s+worktree that is merged back on completion/);

    const tester = await composeRoleTurnPrompt(baseOpts(paths, { role: builtInRole('tester') }));
    assert.match(tester.prompt, /create or modify TEST files/);
    assert.match(tester.prompt, /never product source/);
    assert.match(tester.prompt, /Report defects with this schema: severity, repro steps, expected behavior, actual behavior/);

    const reviewer = await composeRoleTurnPrompt(baseOpts(paths, { role: builtInRole('reviewer') }));
    assert.match(reviewer.prompt, /working tree vs HEAD when the work is uncommitted/);
    assert.match(reviewer.prompt, /finding schema: severity, confidence, quoted path:line, impact, fix, and verification/);
  } finally {
    await cleanup();
  }
});
