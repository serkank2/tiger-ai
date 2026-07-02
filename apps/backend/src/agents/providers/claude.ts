import type { CliToolConfig } from '../../orchestrator/types.js';
import { agentEvent, toolDetail, type AgentEvent, type AgentUsage } from '../events.js';
import type { ProviderDriver, TurnInvocation, TurnRequest, TurnStreamParser, TurnStreamSummary } from './types.js';

// ---------------------------------------------------------------------------
// Claude Code headless driver.
//
//   claude -p --verbose --output-format stream-json [--model M] [--effort E]
//          [permission argv] [--session-id U | --resume ID] [--json-schema S]
//          [--mcp-config JSON]   (prompt on stdin)
//
// - `-p` skips the workspace trust dialog by design (no `\r` typing).
// - stdout is NDJSON; the `result` event is the authoritative completion
//   signal and carries `total_cost_usd`, `usage`, and the session id.
// - Session continuity: `--session-id` pins a fresh session's id so the engine
//   knows it up-front; `--resume` continues it with ONLY the new prompt.
// ---------------------------------------------------------------------------

/** Translate a built-in permission key into headless-safe argv. */
function permissionArgs(request: TurnRequest, tool: CliToolConfig): string[] {
  const key = request.permission?.trim() || 'default';
  if (key === 'dangerous') {
    // The blanket bypass stays opt-in; otherwise degrade to the strongest safe
    // write mode instead of silently dropping write ability.
    return request.allowDangerous ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'acceptEdits'];
  }
  if (key === 'acceptEdits') return ['--permission-mode', 'acceptEdits'];
  if (key === 'plan') return ['--permission-mode', 'plan'];
  if (key === 'default') return [];
  // Unknown key: fall back to the user-configured argv for it, if any.
  return tool.permissionModes[key] ?? [];
}

function buildInvocation(request: TurnRequest, tool: CliToolConfig): TurnInvocation {
  const args: string[] = ['-p', '--verbose', '--output-format', 'stream-json'];

  const model = request.model?.trim();
  if (model && tool.modelFlag) args.push(tool.modelFlag, model);
  const effort = request.effort?.trim();
  if (effort && tool.effortFlag) args.push(tool.effortFlag, effort);

  args.push(...permissionArgs(request, tool));

  if (request.resumeSessionId) {
    args.push('--resume', request.resumeSessionId);
  } else if (request.newSessionId) {
    args.push('--session-id', request.newSessionId);
  }

  if (request.resultSchema) {
    args.push('--json-schema', JSON.stringify(request.resultSchema));
  }

  if (request.mcpServers?.length) {
    const mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
    for (const server of request.mcpServers) {
      mcpServers[server.name] = { command: server.command, args: server.args, env: server.env };
    }
    args.push('--mcp-config', JSON.stringify({ mcpServers }));
  }

  // `tool.extraArgs` is interactive-era config and is deliberately ignored here
  // (see the codex driver note); only engine-supplied per-turn args apply.
  if (request.extraArgs?.length) args.push(...request.extraArgs);

  // No resultFile: the stream's `result` event carries the final message.
  return { command: tool.executable, args, stdinText: request.prompt };
}

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

function createParser(): TurnStreamParser {
  const summary: TurnStreamSummary = {};
  let announced = false;

  const push = (line: string): AgentEvent[] => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return [agentEvent.raw(trimmed)];
    }
    const events: AgentEvent[] = [];
    const type = payload.type;

    if (type === 'system') {
      const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
      if (sessionId) summary.sessionId = sessionId;
      if (!announced) {
        announced = true;
        events.push(agentEvent.turnStarted(sessionId));
      }
      return events;
    }

    if (type === 'assistant' || type === 'user') {
      const message = payload.message as { content?: unknown } | undefined;
      const content = Array.isArray(message?.content) ? (message.content as ClaudeContentBlock[]) : [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          events.push(agentEvent.text(block.text));
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          events.push(agentEvent.thinking(block.thinking));
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          events.push(agentEvent.toolUse(block.name, toolDetail(block.input)));
        } else if (block.type === 'tool_result') {
          events.push(agentEvent.toolResult('tool', toolDetail(block.content, 120)));
        }
      }
      return events;
    }

    if (type === 'result') {
      const usage = readUsage(payload);
      if (usage) summary.usage = usage;
      const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
      if (sessionId) summary.sessionId = sessionId;
      // With --json-schema newer CLIs surface the validated object separately;
      // fall back to the plain result text otherwise.
      const structured = payload.structured_output;
      summary.resultText =
        structured !== undefined && structured !== null
          ? JSON.stringify(structured)
          : typeof payload.result === 'string'
            ? payload.result
            : summary.resultText;
      summary.isError = payload.is_error === true;
      if (summary.isError) {
        summary.errorDetail =
          typeof payload.subtype === 'string' && payload.subtype !== 'success'
            ? `claude reported ${payload.subtype}`
            : 'claude reported an error result';
      }
      events.push(
        agentEvent.result({
          text: summary.resultText,
          usage: summary.usage,
          sessionId: summary.sessionId,
          isError: summary.isError,
        }),
      );
      return events;
    }

    return [agentEvent.raw(trimmed)];
  };

  return {
    push,
    finish: () => summary,
  };
}

function readUsage(payload: Record<string, unknown>): AgentUsage | undefined {
  const usage = payload.usage as Record<string, unknown> | undefined;
  const out: AgentUsage = {};
  if (usage) {
    if (typeof usage.input_tokens === 'number') out.inputTokens = usage.input_tokens;
    if (typeof usage.cache_read_input_tokens === 'number') out.cachedInputTokens = usage.cache_read_input_tokens;
    if (typeof usage.output_tokens === 'number') out.outputTokens = usage.output_tokens;
  }
  if (typeof payload.total_cost_usd === 'number') out.costUsd = payload.total_cost_usd;
  return Object.keys(out).length ? out : undefined;
}

export const claudeDriver: ProviderDriver = {
  id: 'claude',
  label: 'Claude Code (headless)',
  supportsResume: true,
  supportsResultSchema: true,
  buildInvocation,
  createParser,
};
