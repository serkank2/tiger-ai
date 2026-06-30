import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TigerPaths } from './paths.js';
import { checkUpstreamArtifacts, evaluateCompletionGate, requiredSelfReport } from './completion-gate.js';

test('requiredSelfReport maps stages and review phases to their tokens', () => {
  assert.equal(requiredSelfReport('executing-plan'), 'execution');
  assert.equal(requiredSelfReport('task-review', 'fix'), 'fix');
  // The FIND phase now requires a REVIEW_RESULT sentinel so a crashed/empty review is not auto-approved.
  assert.equal(requiredSelfReport('task-review', 'find'), 'review');
  assert.equal(requiredSelfReport('task-review'), null);
  assert.equal(requiredSelfReport('brainstorming'), null);
  assert.equal(requiredSelfReport('requesting-code-review'), null);
});

test('execution gate blocks a completed run with no EXECUTION_RESULT self-report', () => {
  const r = evaluateCompletionGate('execution', true, '# Log\n\nI did some work but forgot to report.\n');
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /EXECUTION_RESULT/);
});

test('execution gate accepts a completed run that reports done', () => {
  const r = evaluateCompletionGate('execution', true, '# Log\n\nEXECUTION_RESULT: done\n');
  assert.equal(r.ok, true);
});

test('execution gate blocks when the agent self-reports blocked', () => {
  const r = evaluateCompletionGate('execution', true, 'EXECUTION_RESULT: blocked: missing dependency\n');
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /blocked/);
});

test('execution gate blocks when the run itself did not complete', () => {
  const r = evaluateCompletionGate('execution', false, 'EXECUTION_RESULT: done\n');
  assert.equal(r.ok, false);
});

test('fix gate blocks a completed run with no FIX_RESULT self-report', () => {
  const r = evaluateCompletionGate('fix', true, '# Fix\n\nedited a file.\n');
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /FIX_RESULT/);
});

test('fix gate accepts FIX_RESULT: fixed and blocks FIX_RESULT: wontfix', () => {
  assert.equal(evaluateCompletionGate('fix', true, 'FIX_RESULT: fixed\n').ok, true);
  const wontfix = evaluateCompletionGate('fix', true, 'FIX_RESULT: wontfix: not reproducible\n');
  assert.equal(wontfix.ok, false);
  assert.match(wontfix.reason ?? '', /wontfix/);
});

test('review gate blocks a completed FIND run with no REVIEW_RESULT sentinel', () => {
  const r = evaluateCompletionGate('review', true, '## FINDING: x\nrelated task TASK-001\n');
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /REVIEW_RESULT|needs-attention/);
});

test('review gate accepts REVIEW_RESULT: clean and REVIEW_RESULT: findings', () => {
  assert.equal(evaluateCompletionGate('review', true, 'No findings.\nREVIEW_RESULT: clean\n').ok, true);
  assert.equal(evaluateCompletionGate('review', true, '## FINDING: x\nREVIEW_RESULT: findings\n').ok, true);
});

test('review gate blocks when the run itself did not complete', () => {
  assert.equal(evaluateCompletionGate('review', false, 'REVIEW_RESULT: clean\n').ok, false);
});

test('null gate accepts any completed run', () => {
  assert.equal(evaluateCompletionGate(null, true, 'anything').ok, true);
  assert.equal(evaluateCompletionGate(null, false, 'anything').ok, false);
});

test('checkUpstreamArtifacts passes for the first stage with no upstream', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-upstream-first-'));
  try {
    const paths = new TigerPaths(ws);
    assert.equal((await checkUpstreamArtifacts(paths, 'brainstorming')).ok, true);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('checkUpstreamArtifacts refuses execution when the merged task list is missing', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-upstream-exec-'));
  try {
    const paths = new TigerPaths(ws);
    const r = await checkUpstreamArtifacts(paths, 'executing-plan');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /Merge Tasks/);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('checkUpstreamArtifacts accepts execution once the merged task list has content', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-upstream-exec-ok-'));
  try {
    const paths = new TigerPaths(ws);
    await fs.mkdir(path.dirname(paths.mergedTasksFile), { recursive: true });
    await fs.writeFile(paths.mergedTasksFile, '## TASK-001: x\n', 'utf8');
    assert.equal((await checkUpstreamArtifacts(paths, 'executing-plan')).ok, true);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('checkUpstreamArtifacts refuses a fan-out stage with an empty upstream dir', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-upstream-fanout-'));
  try {
    const paths = new TigerPaths(ws);
    await fs.mkdir(paths.dirByName('brainstorming'), { recursive: true });
    // whitespace-only file must not count as content
    await fs.writeFile(path.join(paths.dirByName('brainstorming'), 'claude-01-brainstorming.md'), '   \n', 'utf8');
    const r = await checkUpstreamArtifacts(paths, 'writing-plan');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /brainstorming/);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('checkUpstreamArtifacts accepts a fan-out stage with a non-empty upstream output', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'tiger-upstream-fanout-ok-'));
  try {
    const paths = new TigerPaths(ws);
    await fs.mkdir(paths.dirByName('brainstorming'), { recursive: true });
    await fs.writeFile(path.join(paths.dirByName('brainstorming'), 'claude-01-brainstorming.md'), '# Ideas\n', 'utf8');
    assert.equal((await checkUpstreamArtifacts(paths, 'writing-plan')).ok, true);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});
