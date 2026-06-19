import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { computeTeamChanges } from './changes.js';

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
}

function gitAvailable(): boolean {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-changes-'));
}

test('computeTeamChanges reports a non-git workspace honestly', async () => {
  const dir = await tmpDir();
  try {
    const changes = await computeTeamChanges(dir, '2026-01-01T00:00:00.000Z');
    assert.equal(changes.isGitRepo, false);
    assert.equal(changes.files.length, 0);
    assert.match(changes.note ?? '', /not a git repository/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('computeTeamChanges surfaces tracked modifications, untracked files, and a diff', async (t) => {
  if (!gitAvailable()) return t.skip('git not available');
  const dir = await tmpDir();
  try {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(dir, 'app.txt'), 'original line\n', 'utf8');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'initial']);

    // Simulate what an agent turn would do: modify a tracked file + add a new one.
    await fs.writeFile(path.join(dir, 'app.txt'), 'changed line\nsecond line\n', 'utf8');
    await fs.writeFile(path.join(dir, 'new-feature.ts'), 'export const x = 1;\n', 'utf8');

    const changes = await computeTeamChanges(dir, '2026-01-01T00:00:00.000Z');
    assert.equal(changes.isGitRepo, true);
    assert.ok(changes.head, 'has a HEAD sha');

    const modified = changes.files.find((f) => f.path === 'app.txt');
    assert.equal(modified?.status, 'modified');
    const untracked = changes.files.find((f) => f.path === 'new-feature.ts');
    assert.equal(untracked?.status, 'untracked');

    assert.match(changes.diff, /changed line/);
    assert.ok(changes.summary.insertions >= 1, 'counts at least one insertion');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
