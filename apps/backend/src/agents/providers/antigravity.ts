import path from 'node:path';
import type { CliToolConfig } from '../../orchestrator/types.js';
import { agentEvent, type AgentEvent } from '../events.js';
import type { ProviderDriver, TurnInvocation, TurnRequest, TurnStreamParser, TurnStreamSummary } from './types.js';

// ---------------------------------------------------------------------------
// Antigravity (`agy`) headless driver.
//
//   agy --print <PROMPT> [--model M] [permission argv] [--conversation ID]
//
// agy's print-mode stdout is empirically unreliable (it can swallow or
// interleave the final answer), so this driver adds a RESULT-FILE contract:
// the prompt is suffixed with an instruction to write the final TurnResult
// JSON to a scratch file, and the runner prefers that file over stdout.
// There is no schema enforcement and no reliable way to learn a fresh
// conversation id from print output, so `supportsResume` is false — the
// engine compensates with recap briefs. When a caller DOES know a
// conversation id (e.g. user-provided), `--conversation` is still honored.
// ---------------------------------------------------------------------------

const RESULT_FILE_NAME = 'agy-result.json';

/** The trailer that turns the unreliable-stdout CLI into a file-contract CLI. */
function resultTrailer(resultFile: string): string {
  return (
    `\n\n---\nFINAL OUTPUT CONTRACT: as your very last action, write your final result as a single JSON object ` +
    `to this exact file (create it): ${resultFile}\n` +
    `The JSON shape is {"status":"done"|"blocked","summary":"…","details":"…","followUpTasks":[{"title":"…","description":"…"}]}. ` +
    `"summary" is required. Do not wrap the JSON in markdown fences inside the file.`
  );
}

function permissionArgs(request: TurnRequest): string[] {
  const key = request.permission?.trim() || 'sandbox';
  if (key === 'dangerous') {
    return request.allowDangerous ? ['--dangerously-skip-permissions'] : ['--sandbox'];
  }
  if (key === 'sandbox') return ['--sandbox'];
  return [];
}

function buildInvocation(request: TurnRequest, tool: CliToolConfig): TurnInvocation {
  const scratchDir = request.scratchDir ?? process.cwd();
  const resultFile = path.join(scratchDir, RESULT_FILE_NAME);

  const args: string[] = [];
  const model = request.model?.trim();
  if (model && tool.modelFlag) args.push(tool.modelFlag, model);
  args.push(...permissionArgs(request));
  if (request.resumeSessionId) args.push('--conversation', request.resumeSessionId);
  // Generous CLI-side ceiling; the runner enforces the real per-turn timeout.
  args.push('--print-timeout', '120m');
  if (request.extraArgs?.length) args.push(...request.extraArgs);
  if (tool.extraArgs?.length) args.push(...tool.extraArgs);

  args.push('--print', request.prompt + resultTrailer(resultFile));

  return { command: tool.executable, args, resultFile };
}

function createParser(): TurnStreamParser {
  const summary: TurnStreamSummary = {};
  const tail: string[] = [];
  let announced = false;

  const push = (line: string): AgentEvent[] => {
    const events: AgentEvent[] = [];
    if (!announced) {
      announced = true;
      events.push(agentEvent.turnStarted());
    }
    const text = line.trimEnd();
    if (text.trim()) {
      tail.push(text);
      if (tail.length > 50) tail.shift();
      events.push(agentEvent.text(text));
    }
    return events;
  };

  return {
    push,
    finish: (): TurnStreamSummary => {
      // stdout is only the fallback; the runner prefers the result file.
      if (tail.length) summary.resultText = tail.join('\n');
      return summary;
    },
  };
}

export const antigravityDriver: ProviderDriver = {
  id: 'antigravity',
  label: 'Antigravity (print + result file)',
  supportsResume: false,
  supportsResultSchema: false,
  buildInvocation,
  createParser,
};
