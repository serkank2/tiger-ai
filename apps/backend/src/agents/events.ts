// ---------------------------------------------------------------------------
// Normalized agent event model — the single vocabulary every provider driver
// translates its native stream into. The engine, WS layer, and UI consume ONLY
// these events; nothing downstream ever parses provider-specific JSON again.
// This replaces v1's PTY scraping: instead of watching terminal bytes and
// guessing at completion from idle time, drivers map each provider's machine
// output (claude `--output-format stream-json` NDJSON, codex `exec --json`
// JSONL, agy `--print` text) into this shape as it arrives.
// ---------------------------------------------------------------------------

/** Token/cost accounting for a turn, filled from the provider's own usage report. */
export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  /** Provider-reported total cost in USD (claude reports this directly). */
  costUsd?: number;
}

export type AgentEventType =
  /** The provider acknowledged the turn and (when known) reported its session id. */
  | 'turn-started'
  /** Assistant prose (a complete text block, not a token delta). */
  | 'text'
  /** Assistant reasoning/thinking summary, when the provider surfaces it. */
  | 'thinking'
  /** The agent invoked a tool (file edit, shell command, …). */
  | 'tool-use'
  /** A tool finished and returned to the agent. */
  | 'tool-result'
  /** Incremental or final token/cost usage. */
  | 'usage'
  /** The provider's own end-of-turn record — the authoritative completion signal. */
  | 'result'
  /** A line the driver could not map; preserved so nothing is silently dropped. */
  | 'raw'
  /** Provider stderr output (diagnostics, not part of the conversation). */
  | 'stderr';

export interface AgentToolUse {
  /** Provider-reported tool name (e.g. "Edit", "Bash", "shell"). */
  name: string;
  /** Short human-readable summary of the input (path, command, …), truncated by the driver. */
  detail?: string;
}

export interface AgentEvent {
  type: AgentEventType;
  /** ISO timestamp stamped by the driver when the line was parsed. */
  at: string;
  /** Payload for text / thinking / stderr / raw events. */
  text?: string;
  /** Payload for tool-use / tool-result events. */
  tool?: AgentToolUse;
  /** Payload for usage events (and result events that carry final usage). */
  usage?: AgentUsage;
  /** Provider session/thread/conversation id, when this event revealed it. */
  sessionId?: string;
  /**
   * For result events: whether the provider itself flagged the turn as an error
   * (e.g. claude `is_error`, codex `turn.failed`).
   */
  isError?: boolean;
}

const nowIso = (): string => new Date().toISOString();

/** Convenience constructors keep drivers terse and the `at` stamping uniform. */
export const agentEvent = {
  turnStarted(sessionId?: string): AgentEvent {
    return { type: 'turn-started', at: nowIso(), sessionId };
  },
  text(text: string): AgentEvent {
    return { type: 'text', at: nowIso(), text };
  },
  thinking(text: string): AgentEvent {
    return { type: 'thinking', at: nowIso(), text };
  },
  toolUse(name: string, detail?: string): AgentEvent {
    return { type: 'tool-use', at: nowIso(), tool: { name, detail } };
  },
  toolResult(name: string, detail?: string): AgentEvent {
    return { type: 'tool-result', at: nowIso(), tool: { name, detail } };
  },
  usage(usage: AgentUsage): AgentEvent {
    return { type: 'usage', at: nowIso(), usage };
  },
  result(input: { text?: string; usage?: AgentUsage; sessionId?: string; isError?: boolean }): AgentEvent {
    return { type: 'result', at: nowIso(), ...input };
  },
  raw(text: string): AgentEvent {
    return { type: 'raw', at: nowIso(), text };
  },
  stderr(text: string): AgentEvent {
    return { type: 'stderr', at: nowIso(), text };
  },
};

/** Truncate a value into a short single-line detail string for tool events. */
export function toolDetail(value: unknown, max = 200): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Merge partial usage reports (later reports win field-by-field, totals accumulate nothing). */
export function mergeUsage(base: AgentUsage | undefined, next: AgentUsage | undefined): AgentUsage | undefined {
  if (!base) return next;
  if (!next) return base;
  return { ...base, ...definedFields(next) };
}

function definedFields(usage: AgentUsage): AgentUsage {
  const out: AgentUsage = {};
  if (usage.inputTokens !== undefined) out.inputTokens = usage.inputTokens;
  if (usage.cachedInputTokens !== undefined) out.cachedInputTokens = usage.cachedInputTokens;
  if (usage.outputTokens !== undefined) out.outputTokens = usage.outputTokens;
  if (usage.costUsd !== undefined) out.costUsd = usage.costUsd;
  return out;
}
