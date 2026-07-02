// ---------------------------------------------------------------------------
// The structured turn-result contract. v1 asked agents to hand-write fenced
// `TeamMessage` JSON blocks into a deliverable file and treated any parse
// failure as a wasted turn. v2 instead asks the CLI itself to enforce a small
// JSON schema on the final message (`claude --json-schema` / `codex
// --output-schema`), so a malformed result is impossible-by-construction on
// those providers; `parseTurnResult` stays tolerant for providers (agy) that
// cannot enforce a schema and for older CLI versions.
// ---------------------------------------------------------------------------

export type TurnResultStatus = 'done' | 'blocked';

/** A follow-up work item the agent proposes (the engine decides whether to add it). */
export interface TurnFollowUpTask {
  title: string;
  description?: string;
}

/**
 * What every work turn must end with. Kept deliberately small: status + evidence.
 * Verification is NOT part of this contract — Kaplan runs checks itself (RT-04),
 * so an agent has nothing to self-certify.
 */
export interface TurnResult {
  status: TurnResultStatus;
  /** One-paragraph summary of what was actually done (or why blocked), with evidence. */
  summary: string;
  /** Optional longer detail (what changed, decisions taken, caveats). */
  details?: string;
  /** Proposed follow-up tasks discovered while working. */
  followUpTasks?: TurnFollowUpTask[];
}

/**
 * JSON Schema handed to the CLIs (`--json-schema` for claude, `--output-schema`
 * file for codex) so the provider enforces the contract on its final message.
 */
export const TURN_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary'],
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    summary: { type: 'string' },
    details: { type: 'string' },
    followUpTasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
  },
} as const;

/**
 * Tolerant extraction of a TurnResult from final-message text. Accepts, in order:
 * direct JSON, a fenced ```json block, or the last `{…}` object in the text.
 * Returns null when nothing parseable is found — the caller decides the policy
 * (retry once for agy, degrade to a blocked result with the raw text as summary).
 */
export function parseTurnResult(text: string | undefined | null): TurnResult | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const candidates: string[] = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) {
    candidates.push((match[1] ?? '').trim());
  }
  const lastObject = extractLastObject(trimmed);
  if (lastObject) candidates.push(lastObject);

  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed) return parsed;
  }
  return null;
}

/** Build a degraded-but-honest result when a provider produced prose instead of the contract. */
export function fallbackTurnResult(text: string | undefined, error?: string): TurnResult {
  const summary = (text ?? '').trim().slice(0, 2000);
  return {
    status: 'blocked',
    summary: summary || (error ?? 'turn produced no parseable result'),
    details: error,
  };
}

function tryParse(candidate: string): TurnResult | null {
  if (!candidate.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return null;
  }
  return coerceTurnResult(value);
}

/** Validate + narrow an unknown value into a TurnResult (no external deps, no `any`). */
export function coerceTurnResult(value: unknown): TurnResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const status = record.status;
  const summary = record.summary;
  if (status !== 'done' && status !== 'blocked') return null;
  if (typeof summary !== 'string' || !summary.trim()) return null;
  const out: TurnResult = { status, summary: summary.trim() };
  if (typeof record.details === 'string' && record.details.trim()) out.details = record.details.trim();
  if (Array.isArray(record.followUpTasks)) {
    const tasks: TurnFollowUpTask[] = [];
    for (const entry of record.followUpTasks) {
      if (typeof entry !== 'object' || entry === null) continue;
      const task = entry as Record<string, unknown>;
      if (typeof task.title !== 'string' || !task.title.trim()) continue;
      const item: TurnFollowUpTask = { title: task.title.trim() };
      if (typeof task.description === 'string' && task.description.trim()) item.description = task.description.trim();
      tasks.push(item);
    }
    if (tasks.length) out.followUpTasks = tasks;
  }
  return out;
}

/** Return the last balanced `{…}` object in the text, or null. */
function extractLastObject(text: string): string | null {
  const end = text.lastIndexOf('}');
  if (end < 0) return null;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return null;
}
