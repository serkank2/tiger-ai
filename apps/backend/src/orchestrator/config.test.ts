import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultTigerConfig, normalizeConfig, validateConfigPatch } from './config.js';

test('defaultTigerConfig uses the high-capability default profile', () => {
  const defaults = defaultTigerConfig().defaults;

  assert.equal(defaults.claudeAgents, 1);
  assert.equal(defaults.codexAgents, 1);
  assert.equal(defaults.claudeModel, 'opus');
  assert.equal(defaults.codexModel, 'gpt-5.5');
  assert.equal(defaults.claudeEffort, 'xhigh');
  assert.equal(defaults.codexEffort, 'xhigh');
  assert.equal(defaults.claudePermission, 'dangerous');
  assert.equal(defaults.codexPermission, 'yolo');
});

test('defaultTigerConfig execution: unlimited concurrency, one retry, continue-on-failure', () => {
  const e = defaultTigerConfig().execution;
  assert.equal(e.maxConcurrent, 0); // 0 = unlimited: every selected agent starts at once
  assert.equal(e.maxAttempts, 2); // one automatic retry of a failed agent run
  assert.equal(e.continueOnFailure, true); // skip a failed-but-partial stage and keep advancing
});

test('defaultTigerConfig adds Antigravity (agy) as a backward-compatible off-by-default provider', () => {
  const cfg = defaultTigerConfig();
  const d = cfg.defaults;
  assert.equal(d.antigravityAgents, 0); // off by default — existing two-provider runs are unchanged
  assert.equal(d.antigravityModel, 'Gemini 3.1 Pro (High)');
  assert.equal(d.antigravityEffort, '');
  assert.equal(d.antigravityPermission, 'dangerous');

  const agy = cfg.cli.antigravity;
  assert.equal(agy.executable, 'agy');
  assert.equal(agy.modelFlag, '--model');
  assert.ok(agy.models?.includes('Gemini 3.1 Pro (High)'));
  assert.ok(agy.models?.includes('Claude Sonnet 4.6 (Thinking)'));
  assert.deepEqual(Object.keys(agy.permissionModes).sort(), ['dangerous', 'default', 'sandbox']);
});

test('normalizeConfig keeps source-defined defaults over stale persisted defaults', () => {
  const normalized = normalizeConfig({
    version: 1,
    defaults: {
      claudeAgents: 1,
      codexAgents: 1,
      claudeModel: 'opus',
      codexModel: 'gpt-5.5',
      claudeEffort: 'xhigh',
      codexEffort: 'high',
      claudePermission: 'acceptEdits',
      codexPermission: 'workspace-write',
      parallel: true,
    },
  });

  assert.deepEqual(normalized.defaults, defaultTigerConfig().defaults);
});

test('normalizeConfig backfills the antigravity CLI for a legacy two-provider config.json', () => {
  // A config persisted before Antigravity existed has only claude/codex under cli.
  const legacy = { version: 1, cli: { claude: { executable: 'claude' }, codex: { executable: 'codex' } } };
  const normalized = normalizeConfig(legacy);
  assert.equal(normalized.cli.antigravity.executable, 'agy');
  assert.ok((normalized.cli.antigravity.models ?? []).includes('Gemini 3.1 Pro (High)'));
  assert.deepEqual(normalized.defaults, defaultTigerConfig().defaults);
});

test('validateConfigPatch accepts antigravity model labels with spaces and parentheses', () => {
  const current = defaultTigerConfig();
  const ok = validateConfigPatch(
    { cli: { antigravity: { models: ['Gemini 3.1 Pro (High)', 'GPT-OSS 120B (Medium)'] } } },
    current,
  );
  assert.equal(ok, null);
});

test('validateConfigPatch rejects shell metacharacters in an antigravity model label', () => {
  const current = defaultTigerConfig();
  const err = validateConfigPatch({ cli: { antigravity: { models: ['Gemini; rm -rf /'] } } }, current);
  assert.match(String(err), /antigravity\.models/);
});

test('validateConfigPatch rejects any defaults patch (defaults are source-authoritative, non-lossy)', () => {
  const current = defaultTigerConfig();
  // normalizeConfig always reseeds defaults from code on load, so persisting a defaults patch would be
  // a lossy round-trip (saved, then discarded on next load). The API rejects defaults patches outright
  // so the contract is consistent: defaults change only in code.
  for (const patch of [
    { defaults: { antigravityPermission: 'nope' } },
    { defaults: { claudeAgents: 3 } },
    { defaults: { parallel: false } },
  ]) {
    assert.match(String(validateConfigPatch(patch, current)), /defaults are managed in code/);
  }
});

test('validateConfigPatch still accepts non-defaults patches (cli/timing/execution)', () => {
  const current = defaultTigerConfig();
  assert.equal(validateConfigPatch({ execution: { maxConcurrent: 8 } }, current), null);
  assert.equal(validateConfigPatch({ timing: { markerPollMs: 2000 } }, current), null);
});

test('validateConfigPatch accepts the new execution fields and still rejects out-of-range/bad-type', () => {
  const current = defaultTigerConfig();
  // maxConcurrent 0 (= unlimited) is now valid; the new fields are accepted.
  assert.equal(validateConfigPatch({ execution: { maxConcurrent: 0 } }, current), null);
  assert.equal(validateConfigPatch({ execution: { maxAttempts: 3 } }, current), null);
  assert.equal(validateConfigPatch({ execution: { continueOnFailure: false } }, current), null);
  // Still rejected: above the cap, below the floor, and wrong type.
  assert.notEqual(validateConfigPatch({ execution: { maxConcurrent: 65 } }, current), null);
  assert.notEqual(validateConfigPatch({ execution: { maxAttempts: 0 } }, current), null);
  assert.notEqual(validateConfigPatch({ execution: { continueOnFailure: 'yes' as never } }, current), null);
});

test('normalizeConfig fills the new execution fields and keeps the default for out-of-range maxAttempts', () => {
  const n = normalizeConfig({
    version: 1,
    execution: { maxConcurrent: 0, maxAttempts: 999, continueOnFailure: false },
  });
  assert.equal(n.execution.maxConcurrent, 0);
  assert.equal(n.execution.continueOnFailure, false);
  // 999 is above the max (10), so normalizeNumberRecord keeps the source default (2).
  assert.equal(n.execution.maxAttempts, 2);
});
