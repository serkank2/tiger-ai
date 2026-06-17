import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultTigerConfig } from './config.js';
import type { RunTemplate } from './types.js';
import { BUILTIN_TEMPLATES, parseTemplateMd, serializeTemplateMd, templateSlug } from './templates.js';

test('built-in templates are present, uniquely named, and cover stages', () => {
  assert.ok(BUILTIN_TEMPLATES.length >= 4);
  const names = new Set(BUILTIN_TEMPLATES.map((t) => t.name));
  assert.equal(names.size, BUILTIN_TEMPLATES.length);
  const optimum = BUILTIN_TEMPLATES.find((t) => t.name === 'Optimum')!;
  assert.equal(optimum.builtin, true);
  assert.deepEqual(optimum.configs['brainstorming'], { ...defaultTigerConfig().defaults, mergeAgent: 'claude' });
  const balanced = BUILTIN_TEMPLATES.find((t) => t.name === 'Balanced')!;
  assert.equal(balanced.builtin, true);
  assert.equal(balanced.configs['brainstorming']?.claudeModel, 'opus');
  const thorough = BUILTIN_TEMPLATES.find((t) => t.name === 'Thorough')!;
  assert.equal(thorough.configs['executing-plan']?.claudeModel, 'opus');
  assert.equal(thorough.configs['executing-plan']?.codexModel, 'gpt-5.5');
  assert.equal(thorough.configs['executing-plan']?.claudeEffort, 'xhigh');
  assert.equal(thorough.configs['executing-plan']?.codexEffort, 'high');
  assert.equal(thorough.configs['executing-plan']?.claudeAgents, 3);
  assert.equal(thorough.configs['executing-plan']?.codexAgents, 2);
});

test('templateSlug makes a filesystem-safe slug', () => {
  assert.equal(templateSlug('My Fast Run!'), 'my-fast-run');
  assert.equal(templateSlug('   '), 'template');
});

test('serialize -> parse round-trips a custom template', () => {
  const t: RunTemplate = {
    name: 'My Template',
    description: 'desc here',
    fromStage: 'writing-plan',
    configs: {
      'writing-plan': {
        claudeAgents: 2,
        codexAgents: 1,
        claudeModel: 'opus',
        codexModel: 'gpt-5.5',
        claudeEffort: 'xhigh',
        codexEffort: 'high',
        claudePermission: 'dangerous',
        codexPermission: 'yolo',
        parallel: true,
        mergeAgent: 'claude',
      },
    },
  };
  const md = serializeTemplateMd(t);
  assert.match(md, /```json/);
  const parsed = parseTemplateMd(md, 'fallback')!;
  assert.equal(parsed.name, 'My Template');
  assert.equal(parsed.description, 'desc here');
  assert.equal(parsed.fromStage, 'writing-plan');
  assert.equal(parsed.configs['writing-plan']?.claudeAgents, 2);
  assert.equal(parsed.builtin, false);
});

test('parseTemplateMd returns null without a JSON block', () => {
  assert.equal(parseTemplateMd('# just prose, no json', 'x'), null);
});
