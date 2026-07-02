import path from 'node:path';
import type { CliToolConfig } from '../../orchestrator/types.js';
import { agentEvent, toolDetail, type AgentEvent, type AgentUsage } from '../events.js';
import type { ProviderDriver, TurnInvocation, TurnRequest, TurnStreamParser, TurnStreamSummary } from './types.js';

// ---------------------------------------------------------------------------
// Codex headless driver.
//
//   codex exec --json [-m M] [-c model_reasoning_effort=E] [sandbox argv]
//              [--output-schema FILE] [-o FILE] -            (prompt on stdin)
//   codex exec resume <SESSION_ID> --json …                  (follow-up turns)
//
// - `--json` prints JSONL events; the parser tolerates BOTH generations of the
//   event shape (newer `thread.started`/`item.completed`/`turn.completed` and
//   older `{id,msg:{type:…}}`), because the installed CLI version varies.
// - `-o <file>` writes the final agent message to a file — used as the
//   resultText fallback so a stream hiccup can't lose the result.
// - `--output-schema <file>` makes the CLI enforce the TurnResult contract.
// ---------------------------------------------------------------------------

/** Translate a built-in permission key into `codex exec` argv (non-interactive: no approval flags). */
function permissionArgs(request: TurnRequest): string[] {
  const key = request.permission?.trim() || 'workspace-write';
  if (key === 'yolo') {
    return request.allowDangerous ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'workspace-write'];
  }
  if (key === 'read-only') return ['--sandbox', 'read-only'];
  if (key === 'workspace-write') return ['--sandbox', 'workspace-write'];
  // Unknown key: safest write-capable sandbox rather than failing the turn.
  return ['--sandbox', 'workspace-write'];
}

function buildInvocation(request: TurnRequest, tool: CliToolConfig): TurnInvocation {
  const args: string[] = ['exec'];
  if (request.resumeSessionId) args.push('resume', request.resumeSessionId);
  args.push('--json', '--skip-git-repo-check');

  const model = request.model?.trim();
  if (model && tool.modelFlag) args.push(tool.modelFlag, model);
  const effort = request.effort?.trim();
  if (effort && tool.effortConfigKey) args.push('-c', `${tool.effortConfigKey}=${effort}`);

  args.push(...permissionArgs(request));

  const preludeFiles: Record<string, string> = {};
  let resultFile: string | undefined;
  if (request.scratchDir) {
    resultFile = path.join(request.scratchDir, 'last-message.txt');
    args.push('-o', resultFile);
    if (request.resultSchema) {
      const schemaFile = path.join(request.scratchDir, 'output-schema.json');
      preludeFiles[schemaFile] = JSON.stringify(request.resultSchema);
      args.push('--output-schema', schemaFile);
    }
  }

  if (request.extraArgs?.length) args.push(...request.extraArgs);
  if (tool.extraArgs?.length) {
    // v1 config carries `--skip-git-repo-check` in extraArgs; avoid doubling it.
    args.push(...tool.extraArgs.filter((arg) => arg !== '--skip-git-repo-check'));
  }

  // `-` = read the prompt from stdin (avoids Windows argv length limits).
  args.push('-');

  return {
    command: tool.executable,
    args,
    stdinText: request.prompt,
    resultFile,
    preludeFiles: Object.keys(preludeFiles).length ? preludeFiles : undefined,
  };
}

type JsonRecord = Record<string, unknown>;

function createParser(): TurnStreamParser {
  const summary: TurnStreamSummary = {};
  let announced = false;

  const announce = (sessionId?: string): AgentEvent[] => {
    if (sessionId) summary.sessionId = sessionId;
    if (announced) return [];
    announced = true;
    return [agentEvent.turnStarted(sessionId)];
  };

  const push = (line: string): AgentEvent[] => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let payload: JsonRecord;
    try {
      payload = JSON.parse(trimmed) as JsonRecord;
    } catch {
      return [agentEvent.raw(trimmed)];
    }

    // ---- newer `codex exec --json` generation -----------------------------
    const type = typeof payload.type === 'string' ? payload.type : undefined;
    if (type === 'thread.started') {
      return announce(typeof payload.thread_id === 'string' ? payload.thread_id : undefined);
    }
    if (type === 'turn.started') return announce();
    if (type === 'item.completed' || type === 'item.started' || type === 'item.updated') {
      // Only completed items become events; started/updated would double-report.
      if (type !== 'item.completed') return [];
      return itemEvents(payload.item as JsonRecord | undefined, summary);
    }
    if (type === 'turn.completed') {
      const usage = readNewUsage(payload.usage as JsonRecord | undefined);
      if (usage) summary.usage = usage;
      return [agentEvent.result({ text: summary.resultText, usage: summary.usage, sessionId: summary.sessionId })];
    }
    if (type === 'turn.failed' || type === 'error') {
      summary.isError = true;
      summary.errorDetail = errorMessage(payload) ?? 'codex reported a failed turn';
      return [agentEvent.result({ text: summary.resultText, usage: summary.usage, isError: true })];
    }

    // ---- older `{id, msg:{type}}` generation -------------------------------
    const msg = payload.msg as JsonRecord | undefined;
    if (msg && typeof msg.type === 'string') {
      switch (msg.type) {
        case 'session_configured':
          return announce(typeof msg.session_id === 'string' ? msg.session_id : undefined);
        case 'task_started':
          return announce();
        case 'agent_message':
          if (typeof msg.message === 'string' && msg.message.trim()) {
            summary.resultText = msg.message;
            return [agentEvent.text(msg.message)];
          }
          return [];
        case 'agent_reasoning':
          return typeof msg.text === 'string' && msg.text.trim() ? [agentEvent.thinking(msg.text)] : [];
        case 'exec_command_begin':
          return [agentEvent.toolUse('shell', toolDetail(msg.command))];
        case 'exec_command_end':
          return [
            agentEvent.toolResult(
              'shell',
              toolDetail(msg.exit_code !== undefined ? `exit ${msg.exit_code}` : undefined),
            ),
          ];
        case 'token_count': {
          const usage = readOldUsage(msg);
          if (usage) {
            summary.usage = usage;
            return [agentEvent.usage(usage)];
          }
          return [];
        }
        case 'task_complete':
          if (typeof msg.last_agent_message === 'string' && msg.last_agent_message.trim()) {
            summary.resultText = msg.last_agent_message;
          }
          return [agentEvent.result({ text: summary.resultText, usage: summary.usage, sessionId: summary.sessionId })];
        case 'error':
          summary.isError = true;
          summary.errorDetail = typeof msg.message === 'string' ? msg.message : 'codex reported an error';
          return [agentEvent.result({ text: summary.resultText, usage: summary.usage, isError: true })];
        default:
          return [];
      }
    }

    return [agentEvent.raw(trimmed)];
  };

  return { push, finish: () => summary };
}

/** Map a completed item (new event generation) to normalized events. */
function itemEvents(item: JsonRecord | undefined, summary: TurnStreamSummary): AgentEvent[] {
  if (!item) return [];
  const itemType = typeof item.item_type === 'string' ? item.item_type : typeof item.type === 'string' ? item.type : '';
  const text = typeof item.text === 'string' ? item.text : undefined;
  switch (itemType) {
    case 'assistant_message':
    case 'agent_message':
      if (text?.trim()) {
        summary.resultText = text;
        return [agentEvent.text(text)];
      }
      return [];
    case 'reasoning':
      return text?.trim() ? [agentEvent.thinking(text)] : [];
    case 'command_execution':
      return [agentEvent.toolUse('shell', toolDetail(item.command ?? item.aggregated_output, 200))];
    case 'file_change':
      return [agentEvent.toolUse('edit', toolDetail(item.changes ?? item.path))];
    case 'mcp_tool_call':
      return [agentEvent.toolUse(typeof item.tool === 'string' ? item.tool : 'mcp', toolDetail(item.arguments))];
    case 'web_search':
      return [agentEvent.toolUse('web_search', toolDetail(item.query))];
    default:
      return [];
  }
}

function readNewUsage(usage: JsonRecord | undefined): AgentUsage | undefined {
  if (!usage) return undefined;
  const out: AgentUsage = {};
  if (typeof usage.input_tokens === 'number') out.inputTokens = usage.input_tokens;
  if (typeof usage.cached_input_tokens === 'number') out.cachedInputTokens = usage.cached_input_tokens;
  if (typeof usage.output_tokens === 'number') out.outputTokens = usage.output_tokens;
  return Object.keys(out).length ? out : undefined;
}

function readOldUsage(msg: JsonRecord): AgentUsage | undefined {
  // Older CLIs emitted either flat token fields or `{info:{total_token_usage:{…}}}`.
  const info = msg.info as JsonRecord | undefined;
  const total = (info?.total_token_usage ?? info?.last_token_usage) as JsonRecord | undefined;
  const source = total ?? msg;
  const out: AgentUsage = {};
  if (typeof source.input_tokens === 'number') out.inputTokens = source.input_tokens;
  if (typeof source.cached_input_tokens === 'number') out.cachedInputTokens = source.cached_input_tokens;
  if (typeof source.output_tokens === 'number') out.outputTokens = source.output_tokens;
  return Object.keys(out).length ? out : undefined;
}

function errorMessage(payload: JsonRecord): string | undefined {
  const error = payload.error as JsonRecord | undefined;
  if (error && typeof error.message === 'string') return error.message;
  if (typeof payload.message === 'string') return payload.message;
  return undefined;
}

export const codexDriver: ProviderDriver = {
  id: 'codex',
  label: 'Codex (exec --json)',
  supportsResume: true,
  supportsResultSchema: true,
  buildInvocation,
  createParser,
};
