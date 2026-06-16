/** Parsed frontmatter of a prompt .md file. All fields optional. */
export interface PromptMeta {
  title?: string;
  description?: string;
  tags?: string[];
  /** 'all' | 'selected' | `group:<name>` — a hint the composer pre-selects. */
  target?: string;
  /** false = Paste (no trailing newline), true = Run (append newline). */
  run?: boolean;
}

/** Listing entry: metadata + file identity, no body. */
export interface PromptSummary extends PromptMeta {
  path: string; // relative to prompts dir, forward-slashed, e.g. "dev/restart.md"
  size: number;
  mtimeMs: number;
  version: string; // `${mtimeMs}:${size}` — used for optimistic concurrency
}

/** Full file: summary + raw content + body (content minus frontmatter). */
export interface PromptFile extends PromptSummary {
  content: string;
  body: string;
}
