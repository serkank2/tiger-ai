import type { PromptMeta } from './types.js';

// Leading `--- \n ... \n ---` block. Kept minimal on purpose: a flat key:value
// subset, so we need no YAML dependency and the files stay trivial to hand-edit.
const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function unquote(v: string): string {
  return v.replace(/^["']|["']$/g, '');
}

function parseFlat(block: string): PromptMeta {
  const meta: PromptMeta = {};
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    if (key === 'title' || key === 'description' || key === 'target') meta[key] = unquote(val);
    else if (key === 'run') meta.run = /^true$/i.test(val);
    else if (key === 'tags') {
      meta.tags = val
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    }
  }
  return meta;
}

/** Split a .md file into frontmatter meta + body. No frontmatter ⇒ whole file is body. */
export function parsePrompt(content: string): { meta: PromptMeta; body: string } {
  const m = FM.exec(content);
  if (!m) return { meta: {}, body: content };
  return { meta: parseFlat(m[1]!), body: content.slice(m[0].length) };
}

// Collapse newlines so a metadata value can't inject extra frontmatter lines or a
// stray `---` that would terminate the block.
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();

/** Compose meta + body back into file content. Omits the block entirely if meta is empty. */
export function serializePrompt(meta: PromptMeta, body: string): string {
  const out: string[] = [];
  if (meta.title) out.push(`title: ${oneLine(meta.title)}`);
  if (meta.description) out.push(`description: ${oneLine(meta.description)}`);
  if (meta.tags?.length) {
    const tags = meta.tags.map((t) => oneLine(t).replace(/[[\],]/g, ' ').trim()).filter(Boolean);
    if (tags.length) out.push(`tags: [${tags.join(', ')}]`);
  }
  if (meta.target) out.push(`target: ${oneLine(meta.target)}`);
  if (meta.run !== undefined) out.push(`run: ${meta.run}`);
  return out.length ? `---\n${out.join('\n')}\n---\n${body}` : body;
}
