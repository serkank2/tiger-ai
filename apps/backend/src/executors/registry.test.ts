import test from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter, providerRegistry, wiredProviderIds } from './registry.js';
import { quoteInvocation } from './shell.js';
import type { BuildLaunchContext } from './types.js';
import { defaultTigerConfig } from '../orchestrator/config.js';
import type { AgentType } from '../orchestrator/types.js';

const cfg = defaultTigerConfig();

/** Build the full shell command via an adapter, mirroring buildLaunchCommand's delegation. */
function buildVia(
  type: AgentType,
  params: BuildLaunchContext['params'],
  allowDangerous: boolean,
): string {
  const adapter = getAdapter(type);
  const { command, args } = adapter.buildLaunch({ cfg, tool: cfg.cli[type], params, allowDangerous });
  return quoteInvocation(command, args);
}

// --- Registry resolution -------------------------------------------------

test('registry resolves the three wired providers', () => {
  assert.deepEqual(wiredProviderIds(), ['claude', 'codex', 'antigravity']);
  for (const id of ['claude', 'codex', 'antigravity']) {
    assert.equal(getAdapter(id).id, id);
    assert.equal(getAdapter(id).experimental ?? false, false);
  }
});

test('registry also resolves the experimental adapters and flags them', () => {
  for (const id of ['opencode', 'gemini', 'copilot']) {
    const a = getAdapter(id);
    assert.equal(a.id, id);
    assert.equal(a.experimental, true);
  }
  // ...but they are not in the wired (user-selectable) set.
  for (const id of ['opencode', 'gemini', 'copilot']) {
    assert.ok(!wiredProviderIds().includes(id));
  }
});

test('unknown provider errors cleanly listing known providers', () => {
  assert.throws(() => getAdapter('nope'), /Unknown provider "nope".*Known providers:/s);
});

// --- Wired adapters reproduce the prior argv (ported from launch-command.test.ts) ----

test('claude adapter: model + effort + permission flags', () => {
  assert.equal(
    buildVia('claude', { model: 'sonnet', effort: 'high', permission: 'acceptEdits' }, false),
    'claude --model sonnet --effort high --permission-mode acceptEdits',
  );
});

test('claude adapter: default permission yields no permission flags', () => {
  assert.equal(buildVia('claude', { model: '', effort: '', permission: 'default' }, false), 'claude');
});

test('claude adapter: dangerous mode applied only when opted in', () => {
  assert.equal(
    buildVia('claude', { model: 'opus', effort: '', permission: 'dangerous' }, true),
    'claude --model opus --dangerously-skip-permissions',
  );
  assert.equal(
    buildVia('claude', { model: 'opus', effort: '', permission: 'dangerous' }, false),
    'claude --model opus',
  );
});

test('codex adapter: model + reasoning effort + sandbox + extra args', () => {
  assert.equal(
    buildVia('codex', { model: 'gpt-5', effort: 'high', permission: 'workspace-write' }, false),
    'codex -m gpt-5 -c model_reasoning_effort=high --ask-for-approval never --sandbox workspace-write --no-alt-screen',
  );
});

test('codex adapter: yolo downgraded but extra args kept', () => {
  assert.equal(
    buildVia('codex', { model: '', effort: '', permission: 'yolo' }, false),
    'codex --no-alt-screen',
  );
});

test('antigravity adapter: quotes label model + dangerous flag, ignores effort', () => {
  assert.equal(
    buildVia('antigravity', { model: 'Gemini 3.1 Pro (High)', effort: 'high', permission: 'dangerous' }, true),
    'agy --model "Gemini 3.1 Pro (High)" --dangerously-skip-permissions',
  );
});

// --- Experimental adapters build something sane --------------------------

test('experimental adapters build a sane command with the model', () => {
  for (const [id, exe] of [
    ['opencode', 'opencode'],
    ['gemini', 'gemini'],
    ['copilot', 'copilot'],
  ] as const) {
    const a = getAdapter(id);
    const out = a.buildLaunch({
      cfg,
      tool: undefined as never,
      params: { model: 'some-model', effort: '', permission: '' },
      allowDangerous: false,
    });
    assert.equal(out.command, exe);
    assert.deepEqual(out.args, ['--model', 'some-model']);
    assert.equal(quoteInvocation(out.command, out.args), `${exe} --model some-model`);
  }
});

test('experimental adapter with no model omits the model flag', () => {
  const out = getAdapter('gemini').buildLaunch({
    cfg,
    tool: undefined as never,
    params: { model: '', effort: '', permission: '' },
    allowDangerous: false,
  });
  assert.deepEqual(out.args, []);
});

test('every registered adapter is keyed by its own id', () => {
  for (const [key, adapter] of providerRegistry) assert.equal(key, adapter.id);
});
