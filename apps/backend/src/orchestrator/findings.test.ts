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
  parseReviewResult,
  reclaimStaleFindings,
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

test('parseFixResult anchors to line start and prefers the final non-empty marker line', () => {
  // An echoed prompt instruction mid-sentence must NOT be parsed as a self-report.
  assert.equal(parseFixResult('As the final line write `FIX_RESULT: fixed` (or wontfix).'), null);
  // List/quote prefixes on a real result line are tolerated.
  assert.deepEqual(parseFixResult('- FIX_RESULT: fixed'), { status: 'fixed', reason: undefined });
  // The LAST genuine result line wins (the agent's true final answer).
  assert.deepEqual(parseFixResult('FIX_RESULT: wontfix: tried\nthen retried\nFIX_RESULT: fixed'), {
    status: 'fixed',
    reason: undefined,
  });
});

test('parseReviewResult requires the sentinel, anchors to line start, takes the last match', () => {
  assert.deepEqual(parseReviewResult('No findings.\nREVIEW_RESULT: clean'), { status: 'clean' });
  assert.deepEqual(parseReviewResult('## FINDING\nREVIEW_RESULT: findings'), { status: 'findings' });
  assert.equal(parseReviewResult('a review with no sentinel at all'), null);
  // An echoed instruction mid-line is not a sentinel.
  assert.equal(parseReviewResult('write `REVIEW_RESULT: clean` as the final line.'), null);
  // Last match wins.
  assert.deepEqual(parseReviewResult('REVIEW_RESULT: findings\n…\nREVIEW_RESULT: clean'), { status: 'clean' });
});

test('relatedTask round-trips through split + listFindings using the strict TASK- form (#6)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-findings-rel-'));
  try {
    await splitFindingsToFiles([{ label: 'claude-01', content: LOG_A }], dir);
    const recs = await listFindings(dir);
    // The id parsed back from the file content must equal the strict id written by split, so the
    // orchestrator's rollup equality (f.relatedTask === t.id) cannot silently drop a finding.
    assert.equal(recs.find((f) => f.id === 'FINDING-001')?.relatedTask, 'TASK-001');
    assert.equal(recs.find((f) => f.id === 'FINDING-002')?.relatedTask, 'TASK-002');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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

test('stale fixing findings are reclaimed, claimed again, and completed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-findings-reclaim-'));
  const locksDir = path.join(dir, 'locks');
  try {
    await splitFindingsToFiles([{ label: 'claude-01', content: LOG_A }], dir);
    const claimed = await claimNextFinding(dir, {
      locksDir,
      agentId: 'claude-01',
      agentType: 'claude',
      ttlMs: 60_000,
    });
    assert.equal(claimed?.id, 'FINDING-001');
    assert.match(claimed!.block, /Missing null check/);

    await fs.writeFile(
      path.join(locksDir, 'FINDING-001.lock'),
      [
        'Task ID: FINDING-001',
        'Agent ID: claude-01',
        'Agent Type: claude',
        'Created: 2020-01-01T00:00:00.000Z',
        `Process ID: ${process.pid}`,
        '',
      ].join('\n'),
      'utf8',
    );

    const reclaimed = await reclaimStaleFindings(dir, {
      locksDir,
      ttlMs: 1000,
      nowMs: Date.parse('2026-01-01T00:00:00.000Z'),
    });
    assert.deepEqual(reclaimed.map((f) => f.id), ['FINDING-001']);
    assert.equal(await fs.stat(path.join(dir, 'FINDING-001__open.md')).then(() => true).catch(() => false), true);
    assert.equal(await fs.stat(path.join(dir, 'FINDING-001__fixing.md')).then(() => true).catch(() => false), false);
    assert.match(await fs.readFile(path.join(dir, 'FINDING-001__open.md'), 'utf8'), /Missing null check/);

    const next = await claimNextFinding(dir, {
      locksDir,
      agentId: 'codex-01',
      agentType: 'codex',
      ttlMs: 1000,
    });
    assert.equal(next?.id, 'FINDING-001');
    await finishFinding(dir, 'FINDING-001', 'fixed');

    const findingFiles = (await fs.readdir(dir)).filter((name) => name.startsWith('FINDING-001__'));
    assert.deepEqual(findingFiles, ['FINDING-001__fixed.md']);
    const f1 = (await listFindings(dir)).find((f) => f.id === 'FINDING-001')!;
    assert.equal(f1.status, 'fixed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('fresh fixing findings are not reclaimed or double-claimed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-findings-fresh-'));
  const locksDir = path.join(dir, 'locks');
  try {
    await splitFindingsToFiles([{ label: 'claude-01', content: LOG_A }], dir);
    await claimNextFinding(dir, {
      locksDir,
      agentId: 'claude-01',
      agentType: 'claude',
      ttlMs: 60_000,
    });

    const reclaimed = await reclaimStaleFindings(dir, { locksDir, ttlMs: 60_000, nowMs: Date.now() });
    assert.equal(reclaimed.length, 0);
    assert.equal(await fs.stat(path.join(dir, 'FINDING-001__fixing.md')).then(() => true).catch(() => false), true);
    assert.equal((await listFindings(dir)).find((f) => f.id === 'FINDING-001')!.status, 'fixing');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
