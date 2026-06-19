import type { CueEventPayload } from './types.js';

/** How much of an upstream agent's output we splice into a prompt before truncating. */
export const CUE_SOURCE_OUTPUT_MAX = 4000;

/** Truncate a long string to `max` chars with a trailing marker noting the elision. */
export function truncate(value: string, max = CUE_SOURCE_OUTPUT_MAX): string {
  if (value.length <= max) return value;
  const omitted = value.length - max;
  return `${value.slice(0, max)}\n…[truncated ${omitted} chars]`;
}

/**
 * Build the `{{VAR}}` substitution table for a fired event. Stable, documented var names so a
 * cue.json author always knows what is available:
 *   CUE_EVENT          — the event type ('file.changed', etc.)
 *   CUE_FILE_PATH      — absolute path of the changed file (file.changed)
 *   CUE_CHANGE_TYPE    — 'created' | 'modified' | 'deleted'
 *   CUE_SOURCE         — the upstream source name (agent.completed: runId / stage)
 *   CUE_SOURCE_OUTPUT  — truncated upstream output (agent.completed)
 *   CUE_TIMESTAMP      — ISO time the event was rendered
 * plus any `payload.extra` keys, verbatim.
 */
export function buildVars(payload: CueEventPayload, now = new Date()): Record<string, string> {
  const vars: Record<string, string> = {
    CUE_EVENT: payload.event,
    CUE_TIMESTAMP: now.toISOString(),
  };
  if (payload.filePath) vars.CUE_FILE_PATH = payload.filePath;
  if (payload.changeType) vars.CUE_CHANGE_TYPE = payload.changeType;
  if (payload.source) vars.CUE_SOURCE = payload.source;
  if (payload.sourceOutput !== undefined) vars.CUE_SOURCE_OUTPUT = truncate(payload.sourceOutput);
  if (payload.extra) {
    for (const [k, v] of Object.entries(payload.extra)) vars[k] = v;
  }
  return vars;
}

/**
 * Render a prompt template, replacing every `{{VAR}}` (whitespace-tolerant) with its value from
 * `vars`. Unknown placeholders render to the empty string (so a half-populated payload never
 * leaks `{{...}}` literals into an agent prompt). Pure and deterministic.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_m, name: string) => vars[name] ?? '');
}

/** Convenience: render a template directly from an event payload. */
export function renderPrompt(template: string, payload: CueEventPayload, now = new Date()): string {
  return renderTemplate(template, buildVars(payload, now));
}
