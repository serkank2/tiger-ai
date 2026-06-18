import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defaultTigerConfig } from '../orchestrator/config.js';
import { serializeTemplateMd } from '../orchestrator/templates.js';
import { InMemoryRunTemplateRepository, RunTemplateService } from './run-templates.js';

function service(): RunTemplateService {
  return new RunTemplateService(new InMemoryRunTemplateRepository(), () => defaultTigerConfig());
}

const stageConfig = {
  claudeAgents: 1,
  codexAgents: 1,
  claudeModel: 'sonnet',
  codexModel: 'gpt-5',
  claudeEffort: 'medium',
  codexEffort: 'medium',
  claudePermission: 'dangerous',
  codexPermission: 'yolo',
  parallel: true,
  mergeAgent: 'claude' as const,
};

test('run template service seeds built-ins and keeps them read-only', async () => {
  const templates = service();
  await templates.initialize();

  const list = await templates.list();
  const optimum = list.find((template) => template.name === 'Optimum');
  assert.ok(optimum);
  assert.equal(optimum.builtin, true);
  await assert.rejects(() => templates.update(optimum.id!, { description: 'changed' }), /built-in templates cannot/);
  await assert.rejects(() => templates.archive(optimum.id!), /built-in templates cannot/);
});

test('run template service imports legacy markdown templates idempotently', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-run-templates-'));
  try {
    await fs.writeFile(
      path.join(dir, 'legacy.md'),
      serializeTemplateMd({
        name: 'Legacy Imported',
        description: 'from md',
        fromStage: 'writing-plan',
        configs: { 'writing-plan': stageConfig },
      }),
      'utf8',
    );

    const templates = service();
    await templates.initialize({ legacyTemplateDirs: [dir] });
    await templates.importLegacyTemplates([dir]);

    const imported = (await templates.list()).filter((template) => template.name === 'Legacy Imported');
    assert.equal(imported.length, 1);
    assert.equal(imported[0]!.builtin, false);
    assert.equal(imported[0]!.configs['writing-plan']?.claudeAgents, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
