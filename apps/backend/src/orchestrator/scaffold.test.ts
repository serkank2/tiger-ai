import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureScaffold } from './scaffold.js';
import { SCAFFOLD_DIRS } from './paths.js';
import { SYSTEM_PROMPT_FILES } from './prompt-files.js';

async function tmpWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tiger-scaffold-'));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

test('ensureScaffold creates the .tiger tree, all stage dirs, the 7 system prompts, the prompt + config + run-log', async () => {
  const ws = await tmpWorkspace();
  try {
    const paths = await ensureScaffold(ws, 'Improve the thing.');

    assert.equal(paths.root, path.join(ws, '.tiger'));
    assert.equal(await exists(paths.root), true);

    for (const dir of SCAFFOLD_DIRS) {
      assert.equal(await exists(path.join(paths.root, dir)), true, `missing scaffold dir: ${dir}`);
    }
    for (const { filename } of SYSTEM_PROMPT_FILES) {
      assert.equal(
        await exists(path.join(paths.systemPromptsDir, filename)),
        true,
        `missing system prompt: ${filename}`,
      );
    }

    assert.equal(await fs.readFile(paths.projectPromptFile, 'utf8'), 'Improve the thing.');
    assert.equal(await exists(paths.configFile), true);
    assert.equal(await exists(paths.runLogFile), true);
    assert.match(await fs.readFile(paths.runLogFile, 'utf8'), /Tiger Orchestration Run Log/);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('ensureScaffold preserves the original project prompt and a user-edited config across re-init', async () => {
  const ws = await tmpWorkspace();
  try {
    const paths = await ensureScaffold(ws, 'Original prompt (non-English ok).');

    // Simulate a user editing config.json after the first scaffold.
    await fs.writeFile(paths.configFile, '{"customized": true}', 'utf8');

    // Re-scaffold with a DIFFERENT prompt — must not clobber the original prompt or config.
    await ensureScaffold(ws, 'A completely different prompt that must NOT overwrite the first.');

    assert.equal(
      await fs.readFile(paths.projectPromptFile, 'utf8'),
      'Original prompt (non-English ok).',
      'the original project prompt must be preserved verbatim',
    );
    assert.equal(
      await fs.readFile(paths.configFile, 'utf8'),
      '{"customized": true}',
      'a user-edited config must survive re-initialization',
    );
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('ensureScaffold rewrites the authoritative system prompts on every re-init', async () => {
  const ws = await tmpWorkspace();
  try {
    const paths = await ensureScaffold(ws, 'prompt');
    const target = path.join(paths.systemPromptsDir, SYSTEM_PROMPT_FILES[0]!.filename);
    await fs.writeFile(target, 'tampered', 'utf8');

    await ensureScaffold(ws, 'prompt');

    // System prompts are authoritative, so the tampered content must be restored.
    assert.equal(await fs.readFile(target, 'utf8'), SYSTEM_PROMPT_FILES[0]!.content);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('ensureScaffold is idempotent — a second run does not throw and the run-log is not reset', async () => {
  const ws = await tmpWorkspace();
  try {
    const paths = await ensureScaffold(ws, 'prompt');
    await fs.appendFile(paths.runLogFile, '\n- a real run happened\n', 'utf8');

    await ensureScaffold(ws, 'prompt');

    const log = await fs.readFile(paths.runLogFile, 'utf8');
    assert.match(log, /a real run happened/, 'the run-log must not be re-seeded when it already exists');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});
