import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkOutputFile, markerExists } from './validate.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tiger-validate-'));
}

test('checkOutputFile reports a missing file as not-ok / not-exists', async () => {
  const dir = await tmpDir();
  try {
    const chk = await checkOutputFile(path.join(dir, 'nope.md'));
    assert.equal(chk.ok, false);
    assert.equal(chk.exists, false);
    assert.equal(chk.size, 0);
    assert.match(chk.reason ?? '', /not created/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('checkOutputFile rejects a directory at the output path', async () => {
  const dir = await tmpDir();
  try {
    const sub = path.join(dir, 'a-dir');
    await fs.mkdir(sub);
    const chk = await checkOutputFile(sub);
    assert.equal(chk.ok, false);
    assert.match(chk.reason ?? '', /not a file/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('checkOutputFile rejects a zero-byte file', async () => {
  const dir = await tmpDir();
  try {
    const f = path.join(dir, 'empty.md');
    await fs.writeFile(f, '');
    const chk = await checkOutputFile(f);
    assert.equal(chk.ok, false);
    assert.equal(chk.exists, true);
    assert.equal(chk.size, 0);
    assert.match(chk.reason ?? '', /empty/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('checkOutputFile rejects a whitespace-only file even when its byte size is non-zero', async () => {
  const dir = await tmpDir();
  try {
    const f = path.join(dir, 'blank.md');
    await fs.writeFile(f, '   \n\t  \r\n');
    const chk = await checkOutputFile(f);
    assert.equal(chk.ok, false);
    assert.equal(chk.exists, true);
    assert.ok(chk.size > 0, 'byte size must be non-zero so this exercises the content trim path');
    assert.match(chk.reason ?? '', /whitespace/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('checkOutputFile accepts a file with real content and reports its size', async () => {
  const dir = await tmpDir();
  try {
    const f = path.join(dir, 'good.md');
    await fs.writeFile(f, '# real deliverable\n');
    const chk = await checkOutputFile(f);
    assert.equal(chk.ok, true);
    assert.equal(chk.exists, true);
    assert.ok(chk.size > 0);
    assert.equal(chk.reason, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('markerExists is false before and true after the marker is written', async () => {
  const dir = await tmpDir();
  try {
    const marker = path.join(dir, 'run.done');
    assert.equal(await markerExists(marker), false);
    await fs.writeFile(marker, 'done');
    assert.equal(await markerExists(marker), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('markerExists treats a directory at the marker path as present (access succeeds)', async () => {
  const dir = await tmpDir();
  try {
    // fs.access only checks reachability, so a directory counts as "exists".
    assert.equal(await markerExists(dir), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
