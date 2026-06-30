import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureScaffold } from './scaffold.js';
import { STAGE_META } from './paths.js';
import { EXECUTION_STATUSES, FINAL_DECISIONS, REVIEW_STATUSES, STAGE_ORDER } from './types.js';
import { FIX_FINDING_PROMPT, SYSTEM_PROMPT_BY_STAGE, SYSTEM_PROMPT_FILES } from './prompt-files.js';

function assertContainsAll(haystack: string, tokens: string[], context: string): void {
  for (const token of tokens) {
    assert.ok(haystack.includes(token), `${context} is missing ${token}`);
  }
}

test('writing-tasks prompt preserves the task authoring contract', () => {
  const prompt = SYSTEM_PROMPT_BY_STAGE['writing-tasks'];

  assertContainsAll(
    prompt,
    [
      '## TASK-001: Short imperative title',
      '### Why This Task Exists',
      '### Scope',
      '### Out of Scope',
      '### Acceptance Criteria',
      '### Dependencies',
      '### Risk',
      '### Status',
      'not_started',
    ],
    'writing-tasks prompt',
  );
});

test('merge-tasks prompt preserves parseTasks headings and status vocabulary', () => {
  const prompt = SYSTEM_PROMPT_BY_STAGE['merge-tasks'];

  assertContainsAll(
    prompt,
    [
      '## TASK-001: Title',
      '### Description',
      '### Scope',
      '### Out of Scope',
      '### Acceptance Criteria',
      '### Dependencies',
      '### Execution Status',
      '### Assigned Agent',
      '### Started At',
      '### Completed At',
      '### Review Status',
      '### Review Notes',
    ],
    'merge-tasks prompt',
  );
  assertContainsAll(prompt, [...EXECUTION_STATUSES, ...REVIEW_STATUSES], 'merge-tasks prompt status vocabulary');
});

test('execution, review, fix, and final-review prompts preserve parser markers', () => {
  assertContainsAll(
    SYSTEM_PROMPT_BY_STAGE['executing-plan'],
    ['EXECUTION_RESULT: done', 'EXECUTION_RESULT: blocked'],
    'executing-plan prompt',
  );

  assertContainsAll(
    SYSTEM_PROMPT_BY_STAGE['task-review'],
    ['## FINDING', '### Related Task', '### Severity', '### Problem', '### Recommended Fix', 'No findings.'],
    'task-review prompt',
  );

  assertContainsAll(FIX_FINDING_PROMPT, ['FIX_RESULT: fixed', 'FIX_RESULT: wontfix'], 'fix-finding prompt');

  assertContainsAll(
    SYSTEM_PROMPT_BY_STAGE['requesting-code-review'],
    ['# Final Decision', ...FINAL_DECISIONS],
    'requesting-code-review prompt',
  );
});

test('system prompt stage map and scaffold file list stay aligned', () => {
  const stageKeys = Object.keys(SYSTEM_PROMPT_BY_STAGE).sort();
  assert.deepEqual(stageKeys, [...STAGE_ORDER].sort());

  const expectedFiles = STAGE_ORDER.map((stage) => STAGE_META[stage].promptFile);
  assert.deepEqual(
    SYSTEM_PROMPT_FILES.map((file) => file.filename),
    expectedFiles,
  );

  const filesByName = new Map(SYSTEM_PROMPT_FILES.map((file) => [file.filename, file.content]));
  for (const stage of STAGE_ORDER) {
    assert.equal(filesByName.get(STAGE_META[stage].promptFile), SYSTEM_PROMPT_BY_STAGE[stage]);
  }

  assert.ok(FIX_FINDING_PROMPT.includes('FIX_RESULT: fixed'), 'FIX_FINDING_PROMPT is covered by contract tests');
});

test('ensureScaffold writes system prompts byte-identical to prompt-files source', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-prompt-files-'));
  try {
    const paths = await ensureScaffold(dir, 'Build a reliable product.');

    for (const { filename, content } of SYSTEM_PROMPT_FILES) {
      const written = await fs.readFile(path.join(paths.systemPromptsDir, filename), 'utf8');
      assert.equal(written, content, `${filename} differs from SYSTEM_PROMPT_FILES`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
