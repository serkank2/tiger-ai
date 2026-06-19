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

test('validateConfigPatch rejects an unknown antigravity default permission/model/effort', () => {
  const current = defaultTigerConfig();
  assert.match(
    String(validateConfigPatch({ defaults: { antigravityPermission: 'nope' } }, current)),
    /antigravityPermission/,
  );
  assert.match(
    String(validateConfigPatch({ defaults: { antigravityModel: 'Not A Model' } }, current)),
    /antigravityModel/,
  );
  assert.match(
    String(validateConfigPatch({ defaults: { antigravityEffort: 'high' } }, current)),
    /antigravityEffort/,
  );
});
