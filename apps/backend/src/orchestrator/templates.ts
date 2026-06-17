import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultTigerConfig } from './config.js';
import type { RunTemplate, StageId, StageRunConfig } from './types.js';
import { STAGE_ORDER } from './types.js';

// ---------------------------------------------------------------------------
// Run All templates. A template is a saved per-stage configuration the user can
// apply in the Run All dialog. Built-in templates always exist; custom templates
// are stored one-per-file as Markdown (frontmatter + a JSON block) under
// .tiger/run-templates/.
// ---------------------------------------------------------------------------

const BASE: StageRunConfig = {
  claudeAgents: 1,
  codexAgents: 1,
  claudeModel: 'opus',
  codexModel: 'gpt-5.5',
  claudeEffort: 'xhigh',
  codexEffort: 'xhigh',
  claudePermission: 'dangerous',
  codexPermission: 'yolo',
  parallel: true,
  mergeAgent: 'claude',
};

const OPTIMUM: StageRunConfig = {
  ...defaultTigerConfig().defaults,
  mergeAgent: 'claude',
};

function allStages(
  base: Partial<StageRunConfig>,
  overrides: Partial<Record<StageId, Partial<StageRunConfig>>> = {},
): Partial<Record<StageId, StageRunConfig>> {
  const out: Partial<Record<StageId, StageRunConfig>> = {};
  for (const s of STAGE_ORDER) out[s] = { ...BASE, ...base, ...(overrides[s] ?? {}) };
  return out;
}

export const BUILTIN_TEMPLATES: RunTemplate[] = [
  {
    name: 'Optimum',
    description: 'Default cost-aware autonomous profile: lighter models, medium effort, parallel.',
    builtin: true,
    fromStage: 'brainstorming',
    configs: allStages(OPTIMUM),
  },
  {
    name: 'Balanced',
    description: '1 Claude + 1 Codex per stage, top models, maximum effort, parallel.',
    builtin: true,
    fromStage: 'brainstorming',
    configs: allStages({}),
  },
  {
    name: 'Fast',
    description: 'Lightest allowed agent mix, cheaper Claude model, low effort, brainstorming skipped.',
    builtin: true,
    fromStage: 'writing-plan',
    configs: allStages({ claudeAgents: 1, codexAgents: 1, claudeModel: 'sonnet', claudeEffort: 'low' }),
  },
  {
    name: 'Thorough',
    description: 'Several agents on the heavy stages, maximum effort, parallel.',
    builtin: true,
    fromStage: 'brainstorming',
    configs: allStages(
      {},
      {
        'brainstorming': { claudeAgents: 2, codexAgents: 1 },
        'writing-plan': { claudeAgents: 2, codexAgents: 1 },
        'writing-tasks': { claudeAgents: 2, codexAgents: 2 },
        'executing-plan': { claudeAgents: 3, codexAgents: 2 },
        'task-review': { claudeAgents: 2, codexAgents: 1 },
      },
    ),
  },
];

/** A filesystem-safe slug for a template name (used as the .md filename). */
export function templateSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'template';
}

/** Serialize a template to Markdown: frontmatter (name/description) + a JSON block. */
export function serializeTemplateMd(t: RunTemplate): string {
  const payload = { fromStage: t.fromStage, configs: t.configs };
  return (
    `---\nname: ${t.name}\ndescription: ${t.description ?? ''}\n---\n\n` +
    `# Run All template: ${t.name}\n\n` +
    `${t.description ? t.description + '\n\n' : ''}` +
    '```json\n' +
    JSON.stringify(payload, null, 2) +
    '\n```\n'
  );
}

/** Parse a template Markdown file. Returns null if it has no JSON block. */
export function parseTemplateMd(content: string, fallbackName: string): RunTemplate | null {
  const json = /```json\s*([\s\S]*?)```/.exec(content);
  if (!json) return null;
  let parsed: { fromStage?: StageId; configs?: Partial<Record<StageId, StageRunConfig>> };
  try {
    parsed = JSON.parse(json[1]!);
  } catch {
    return null;
  }
  const nameM = /^name:\s*(.+)$/m.exec(content);
  const descM = /^description:\s*(.*)$/m.exec(content);
  const desc = descM?.[1]?.trim();
  return {
    name: (nameM?.[1] ?? fallbackName).trim(),
    description: desc ? desc : undefined,
    fromStage: parsed.fromStage,
    configs: parsed.configs ?? {},
    builtin: false,
  };
}

/** Read all custom templates from a directory (sorted by name). */
export async function listCustomTemplates(dir: string): Promise<RunTemplate[]> {
  const names = (await fs.readdir(dir).catch(() => [] as string[]))
    .filter((n) => n.toLowerCase().endsWith('.md'))
    .sort();
  const out: RunTemplate[] = [];
  for (const n of names) {
    const content = await fs.readFile(path.join(dir, n), 'utf8').catch(() => '');
    const t = parseTemplateMd(content, n.replace(/\.md$/i, ''));
    if (t) out.push(t);
  }
  return out;
}

/** Built-in templates followed by the project's custom templates. */
export async function listTemplates(dir: string | null): Promise<RunTemplate[]> {
  const custom = dir ? await listCustomTemplates(dir) : [];
  return [...BUILTIN_TEMPLATES, ...custom];
}

export async function saveTemplate(dir: string, t: RunTemplate): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${templateSlug(t.name)}.md`), serializeTemplateMd({ ...t, builtin: false }), 'utf8');
}

export async function deleteTemplate(dir: string, name: string): Promise<void> {
  await fs.rm(path.join(dir, `${templateSlug(name)}.md`), { force: true }).catch(() => {});
}
