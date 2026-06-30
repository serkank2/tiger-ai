import type { PromptMeta } from '~/types';

// Collapse newlines so a value can't inject frontmatter lines / terminate the block.
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();

/** Compose meta + body into .md content. Mirrors the backend serializer (flat subset). */
export function serializePrompt(meta: PromptMeta, body: string): string {
  const out: string[] = [];
  if (meta.title) out.push(`title: ${oneLine(meta.title)}`);
  if (meta.description) out.push(`description: ${oneLine(meta.description)}`);
  if (meta.tags?.length) {
    const tags = meta.tags
      .map((t) =>
        oneLine(t)
          .replace(/[[\],]/g, ' ')
          .trim(),
      )
      .filter(Boolean);
    if (tags.length) out.push(`tags: [${tags.join(', ')}]`);
  }
  if (meta.target) out.push(`target: ${oneLine(meta.target)}`);
  if (meta.run !== undefined) out.push(`run: ${meta.run}`);
  return out.length ? `---\n${out.join('\n')}\n---\n${body}` : body;
}
