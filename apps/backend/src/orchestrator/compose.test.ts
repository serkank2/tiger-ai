import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureScaffold } from './scaffold.js';
import { composePrompt } from './compose.js';

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
    assert.match(prompt, /All content must be written in English\./);
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
