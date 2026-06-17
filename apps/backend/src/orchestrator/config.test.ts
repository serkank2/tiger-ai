import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultTigerConfig, normalizeConfig } from './config.js';

test('defaultTigerConfig uses the cost-aware autonomous profile', () => {
  const defaults = defaultTigerConfig().defaults;

  assert.equal(defaults.claudeAgents, 1);
  assert.equal(defaults.codexAgents, 1);
  assert.equal(defaults.claudeModel, 'sonnet');
  assert.equal(defaults.codexModel, 'gpt-5');
  assert.equal(defaults.claudeEffort, 'medium');
  assert.equal(defaults.codexEffort, 'medium');
  assert.equal(defaults.claudePermission, 'dangerous');
  assert.equal(defaults.codexPermission, 'yolo');
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
