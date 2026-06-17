import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimNextFinding,
  finishFinding,
  hasFindings,
  listFindings,
  parseFindingBlocks,
  parseFindingFileName,
  parseFixResult,
  splitFindingsToFiles,
  summarizeFindings,
} from './findings.js';

const LOG_A = `# Review Summary
Reviewed TASK-001 and TASK-002.

## FINDING: Missing null check
### Related Task
TASK-001
### Severity
high
### Problem
foo() crashes on null input in src/foo.ts.
### Recommended Fix
Guard against null.

## FINDING: Wrong status code
### Related Task
TASK-002
### Severity
medium
### Problem
Returns 200 on error.
### Recommended Fix
Return 500.
`;

const LOG_CLEAN = `No findings.`;

test('parseFindingBlocks extracts FINDING blocks + related tasks; clean log yields none', () => {
  const blocks = parseFindingBlocks(LOG_A);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.relatedTask, 'TASK-001');
  assert.match(blocks[0]!.title, /Missing null check/);
  assert.equal(parseFindingBlocks(LOG_CLEAN).length, 0);
});

test('parseFixResult parses fixed / wontfix', () => {
  assert.deepEqual(parseFixResult('done\nFIX_RESULT: fixed'), { status: 'fixed', reason: undefined });
  assert.deepEqual(parseFixResult('FIX_RESULT: wontfix: not reproducible'), {
    status: 'wontfix',
    reason: 'not reproducible',
  });
  assert.equal(parseFixResult('no marker here'), null);
});

test('findings queue: split, claim-by-rename, finish, summarize', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-findings-'));
  try {
    const recs = await splitFindingsToFiles(
      [
        { label: 'claude-01', content: LOG_A },
        { label: 'codex-01', content: LOG_CLEAN },
      ],
      dir,
    );
    assert.equal(recs.length, 2);
    assert.equal(await hasFindings(dir), true);
    assert.ok((await listFindings(dir)).every((f) => f.status === 'open'));

    // Claim is an atomic rename open -> fixing.
    const c1 = await claimNextFinding(dir);
    assert.equal(c1?.id, 'FINDING-001');
    assert.match(c1!.block, /Missing null check/);
    assert.equal(parseFindingFileName('FINDING-001__fixing.md')?.status, 'fixing');

    await finishFinding(dir, 'FINDING-001', 'fixed');
    const c2 = await claimNextFinding(dir);
    assert.equal(c2?.id, 'FINDING-002');
    await finishFinding(dir, 'FINDING-002', 'wontfix');

    assert.equal(await claimNextFinding(dir), null); // nothing open remains

    const sum = summarizeFindings(await listFindings(dir));
    assert.deepEqual(sum, { total: 2, open: 0, fixing: 0, fixed: 1, wontfix: 1 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
