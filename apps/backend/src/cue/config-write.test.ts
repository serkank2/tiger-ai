import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CUE_CONFIG_RELPATH, readRawCueConfig, validateSubscriptionStrict, writeCueConfig } from './config-loader.js';

async function tmpWs(): Promise<{ ws: string; cleanup: () => Promise<void> }> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-write-'));
  return { ws, cleanup: () => fs.rm(ws, { recursive: true, force: true }) };
}

// --- validateSubscriptionStrict ---

test('validateSubscriptionStrict accepts a well-formed file.changed subscription', () => {
  const { sub, errors } = validateSubscriptionStrict({
    id: 'run-tests',
    event: 'file.changed',
    prompt: 'Run the tests.',
    target: { kind: 'queue' },
    watch: 'src',
  });
  assert.deepEqual(errors, []);
  assert.equal(sub?.id, 'run-tests');
  assert.equal(sub?.event, 'file.changed');
});

test('validateSubscriptionStrict rejects a missing id', () => {
  const { sub, errors } = validateSubscriptionStrict({ event: 'cli.trigger', prompt: 'x', target: { kind: 'team' } });
  assert.equal(sub, null);
  assert.ok(errors.length > 0);
});

test('validateSubscriptionStrict rejects an id with illegal characters', () => {
  const { sub, errors } = validateSubscriptionStrict({
    id: 'bad id!',
    event: 'cli.trigger',
    prompt: 'x',
    target: { kind: 'team' },
  });
  assert.equal(sub, null);
  assert.ok(errors.some((e) => /id may only contain|letters/i.test(e)));
});

test('validateSubscriptionStrict elevates "time.once needs at" to a hard error', () => {
  const { sub, errors } = validateSubscriptionStrict({
    id: 'one',
    event: 'time.once',
    prompt: 'x',
    target: { kind: 'team' },
  });
  assert.equal(sub, null);
  assert.ok(errors.some((e) => /time\.once/.test(e)));
});

test('validateSubscriptionStrict requires a prompt or promptFile', () => {
  const { sub, errors } = validateSubscriptionStrict({ id: 'np', event: 'cli.trigger', target: { kind: 'team' } });
  assert.equal(sub, null);
  assert.ok(errors.some((e) => /prompt/i.test(e)));
});

// --- write / read roundtrip ---

test('writeCueConfig + readRawCueConfig roundtrips and creates the .kaplan dir', async () => {
  const { ws, cleanup } = await tmpWs();
  try {
    const written = await writeCueConfig(ws, {
      subscriptions: [{ id: 'a', event: 'cli.trigger', prompt: 'hi', target: { kind: 'team' }, enabled: true }],
    });
    assert.equal(written, path.join(ws, CUE_CONFIG_RELPATH));
    const onDisk = await fs.readFile(written, 'utf8');
    assert.match(onDisk, /"id": "a"/); // pretty-printed
    const { config } = await readRawCueConfig(ws);
    assert.equal(config.subscriptions.length, 1);
    assert.equal(config.subscriptions[0]!.id, 'a');
  } finally {
    await cleanup();
  }
});

test('readRawCueConfig returns an empty config when the file is missing', async () => {
  const { ws, cleanup } = await tmpWs();
  try {
    const { config, configPath } = await readRawCueConfig(ws);
    assert.deepEqual(config.subscriptions, []);
    assert.equal(configPath, path.join(ws, CUE_CONFIG_RELPATH));
  } finally {
    await cleanup();
  }
});
