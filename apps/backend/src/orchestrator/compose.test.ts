import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureScaffold } from './scaffold.js';
import { composePrompt, composeWorkdir, measurePromptSize } from './compose.js';

type TestPaths = Awaited<ReturnType<typeof ensureScaffold>>;

function legacyPreamble(paths: TestPaths, label: string, outputPath: string, markerPath: string): string {
  const outputRel = paths.rel(outputPath);
  const markerRel = paths.rel(markerPath);
  return `# AUTOMATION CONTEXT — READ THIS FIRST

You are running as an autonomous background agent inside the **Tiger** multi-agent software-team
pipeline. There is NO human available to answer questions or approve actions during your run.

Rules:
- Do NOT ask any questions and do NOT wait for confirmation. Make reasonable, well-justified
  assumptions and proceed on your own.
- Complete the assigned task to the highest possible quality.
- Work only toward the project goal described below; avoid unrelated changes.
- Every document, log, report, and comment you produce MUST be written in clear, professional English.
- Your agent ID is: ${label}
- Your working directory is the .tiger/ root: ${paths.root}
- WORKSPACE BOUNDARY — STRICT: stay entirely within the .tiger/ root above. Never read from, write
  to, or run commands against anything outside it; never use absolute paths or ".." to escape it.
  Treat this root as the whole world for your run; escaping it corrupts the pipeline state.
- Save your deliverable to exactly this file (absolute path):
    ${outputPath}
    (relative to the .tiger root: ${outputRel})
- COMPLETION SIGNAL: when you have completely finished AND your deliverable file is written, your
  FINAL action MUST be to create this marker file and write the single word "done" into it:
    ${markerPath}
    (relative to the .tiger root: ${markerRel})
  The orchestrator watches for this marker to know you are done. Do not create it early.
`;
}

function replaceCurrentPreamble(prompt: string, legacy: string): string {
  const stageStart = prompt.indexOf('---\n\n# STAGE INSTRUCTIONS');
  assert.notEqual(stageStart, -1, 'prompt includes stage instructions');
  return legacy + '\n\n' + prompt.slice(stageStart);
}

test('composePrompt assembles preamble, system prompt, project prompt, and paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-compose-'));
  try {
    const paths = await ensureScaffold(dir, 'Build a todo app in English.');
    const outputPath = paths.outputFile('brainstorming', 'claude', 1);
    const markerPath = paths.markerFile('brainstorming', 'run-xyz');
    const prompt = await composePrompt({
      paths,
      stage: 'brainstorming',
      label: 'claude-01',
      outputPath,
      markerPath,
    });

    assert.match(prompt, /AUTOMATION CONTEXT/);
    assert.match(prompt, /never ask|Do NOT ask/i);
    assert.match(prompt, /senior software analyst/); // from the brainstorming system prompt
    assert.match(prompt, /Build a todo app in English\./); // original project prompt embedded
    assert.ok(prompt.includes(outputPath), 'includes the absolute output path');
    assert.ok(prompt.includes(markerPath), 'includes the marker path');
    assert.match(prompt, /clear, professional English/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('executing-plan prompt includes the assigned task and result convention', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-compose-exec-'));
  try {
    const paths = await ensureScaffold(dir, 'Build something.');
    const prompt = await composePrompt({
      paths,
      stage: 'executing-plan',
      label: 'codex-01',
      outputPath: paths.outputFile('executing-plan', 'codex', 1),
      markerPath: paths.markerFile('executing-plan', 'run-1'),
      taskId: 'TASK-005',
      taskBlock: '## TASK-005: Do the thing\n\n### Description\nDetails.',
    });
    assert.match(prompt, /TASK-005/);
    assert.match(prompt, /EXECUTION_RESULT: done/);
    assert.match(prompt, /EXECUTION_RESULT: blocked/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('composePrompt reports measurable size and is smaller than the legacy preamble baseline', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-compose-size-'));
  try {
    const paths = await ensureScaffold(dir, 'Improve the project while keeping prompts lean.');
    await fs.writeFile(path.join(paths.stageDir('brainstorming'), 'claude-01-brainstorming.md'), '# Analysis\nA'.repeat(80));
    await fs.writeFile(path.join(paths.stageDir('brainstorming'), 'codex-01-brainstorming.md'), '# Risks\nB'.repeat(60));
    await fs.writeFile(path.join(paths.stageDir('brainstorming'), 'codex-02-brainstorming.md'), '# Success\nC'.repeat(70));

    const planOutputPath = paths.outputFile('writing-plan', 'claude', 1);
    const planMarkerPath = paths.markerFile('writing-plan', 'run-plan');
    const planPrompt = await composePrompt({
      paths,
      stage: 'writing-plan',
      label: 'claude-01',
      outputPath: planOutputPath,
      markerPath: planMarkerPath,
    });
    const legacyPlanPrompt = replaceCurrentPreamble(
      planPrompt,
      legacyPreamble(paths, 'claude-01', planOutputPath, planMarkerPath),
    );

    const execOutputPath = paths.outputFile('executing-plan', 'codex', 1);
    const execMarkerPath = paths.markerFile('executing-plan', 'run-exec');
    const execPrompt = await composePrompt({
      paths,
      stage: 'executing-plan',
      label: 'codex-01',
      outputPath: execOutputPath,
      markerPath: execMarkerPath,
      taskId: 'TASK-001',
      taskBlock: '## TASK-001: Tighten prompts\n\n### Acceptance Criteria\n- Prompts are smaller.',
    });
    const legacyExecPrompt = replaceCurrentPreamble(
      execPrompt,
      legacyPreamble(paths, 'codex-01', execOutputPath, execMarkerPath),
    );

    const planSize = measurePromptSize(planPrompt);
    const legacyPlanSize = measurePromptSize(legacyPlanPrompt);
    const execSize = measurePromptSize(execPrompt);
    const legacyExecSize = measurePromptSize(legacyExecPrompt);

    assert.equal(planSize.approximateTokens, Math.ceil(planSize.characters / 4));
    assert.ok(
      planSize.characters < legacyPlanSize.characters,
      `writing-plan prompt should shrink (${legacyPlanSize.characters} -> ${planSize.characters} chars)`,
    );
    assert.ok(
      execSize.characters < legacyExecSize.characters,
      `executing-plan prompt should shrink (${legacyExecSize.characters} -> ${execSize.characters} chars)`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('composeWorkdir returns the tiger root by default and the worktree path when isolating (#1)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-compose-wd-'));
  try {
    const paths = await ensureScaffold(dir, 'Build something.');
    // No workdir, or workdir === root -> the shared .tiger root (default-off behavior).
    assert.equal(composeWorkdir({ paths }), paths.root);
    assert.equal(composeWorkdir({ paths, workdir: paths.root }), paths.root);
    // A distinct worktree path -> that worktree path.
    const wt = path.join(dir, '.tiger', 'worktrees', 'TASK-001');
    assert.equal(composeWorkdir({ paths, workdir: wt }), wt);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('executing-plan prompt rebases working dir + boundary onto the worktree when isolating (#1)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-compose-wt-'));
  try {
    const paths = await ensureScaffold(dir, 'Build something.');
    const worktree = path.join(dir, '.tiger', 'worktrees', 'TASK-007');
    const outputPath = paths.outputFile('executing-plan', 'codex', 1);
    const markerPath = paths.markerFile('executing-plan', 'run-wt');

    const isolated = await composePrompt({
      paths,
      stage: 'executing-plan',
      label: 'codex-01',
      outputPath,
      markerPath,
      taskId: 'TASK-007',
      taskBlock: '## TASK-007: Do it',
      workdir: worktree,
    });
    // The stated working directory + boundary are the worktree, not the .tiger root.
    assert.ok(isolated.includes(`isolated task worktree: ${worktree}`), 'states the worktree as the working dir');
    assert.match(isolated, /worktree is the project working copy/);
    assert.ok(isolated.includes(`worktree root (${worktree})`), 'the task section points at the worktree');
    // The deliverable + marker remain the absolute .tiger paths (orchestration artifacts), carved out
    // as the only permitted writes outside the boundary so the orchestrator can still read them.
    assert.ok(isolated.includes(outputPath), 'keeps the absolute deliverable path under .tiger');
    assert.ok(isolated.includes(markerPath), 'keeps the absolute marker path under .tiger');
    assert.match(isolated, /EXCEPTION — orchestration artifacts only/);

    // Default mode (no workdir): boundary is the .tiger root, exactly as before.
    const shared = await composePrompt({
      paths,
      stage: 'executing-plan',
      label: 'codex-01',
      outputPath,
      markerPath,
      taskId: 'TASK-007',
      taskBlock: '## TASK-007: Do it',
    });
    assert.ok(shared.includes(`Your working directory is the .tiger/ root: ${paths.root}`));
    assert.ok(!shared.includes('isolated task worktree'), 'default mode has no worktree language');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('context selection prioritizes compact useful files and preserves budget signals', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-compose-context-'));
  try {
    const paths = await ensureScaffold(dir, 'Build something useful.');
    const brainstormingDir = paths.stageDir('brainstorming');
    await fs.writeFile(path.join(brainstormingDir, 'zzz-useful.md'), 'compact upstream context that should survive');
    for (let i = 0; i < 9; i++) {
      await fs.writeFile(path.join(brainstormingDir, `aaa-noise-${i}.md`), `large ${i}\n${'x'.repeat(40_000)}`);
    }

    const prompt = await composePrompt({
      paths,
      stage: 'writing-plan',
      label: 'claude-01',
      outputPath: paths.outputFile('writing-plan', 'claude', 1),
      markerPath: paths.markerFile('writing-plan', 'run-context'),
    });

    assert.match(prompt, /#### File: brainstorming\/zzz-useful\.md/);
    assert.match(prompt, /_\(truncated\)_/);
    assert.match(prompt, /Additional context files omitted to respect the size budget/i);
    const firstNoisePath = prompt.match(/brainstorming\/aaa-noise-\d+\.md/)?.[0];
    assert.ok(firstNoisePath, 'at least one oversized context file is retained');
    assert.ok(
      prompt.indexOf('brainstorming/zzz-useful.md') < prompt.indexOf(firstNoisePath),
      'compact context is retained before alphabetically earlier oversized context',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
