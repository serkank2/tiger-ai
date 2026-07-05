import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { CliToolConfig } from '../orchestrator/types.js';
import { logger } from '../obs/logger.js';
import { mergeUsage, agentEvent, type AgentEvent, type AgentUsage } from './events.js';
import { parseTurnResult, type TurnResult } from './result.js';
import type { ProviderDriver, TurnRequest, TurnStreamParser, TurnStreamSummary } from './providers/types.js';
import { killProcessTree, spawnAgentProcess } from './spawn.js';

// ---------------------------------------------------------------------------
// TurnRunner — runs ONE headless agent turn end-to-end:
//   build invocation → spawn (no shell) → stream-parse stdout into normalized
//   AgentEvents → completion on process exit → assemble the TurnReport.
//
// This file is the v2 replacement for the entire v1 completion apparatus:
// no marker files, no output-idle heuristics, no dead-stall detection, no
// trust-dialog keystrokes. The ONLY timers are a hard per-turn timeout and
// the caller's AbortSignal.
// ---------------------------------------------------------------------------

export type AgentTurnState = 'completed' | 'failed' | 'stopped';

export interface RunAgentTurnOptions {
  driver: ProviderDriver;
  tool: CliToolConfig;
  request: TurnRequest;
  /** Working directory for the agent process (workspace or per-task worktree). */
  cwd: string;
  /** Hard ceiling for the whole turn; the only timeout in v2. */
  hardTimeoutMs: number;
  signal?: AbortSignal;
  /** Live event sink (WS fan-out, persistence). Errors in the sink are swallowed. */
  onEvent?: (event: AgentEvent) => void;
  /** Extra environment for the child (e.g. per-turn MCP identity token). */
  env?: NodeJS.ProcessEnv;
}

export interface AgentTurnReport {
  state: AgentTurnState;
  exitCode: number | null;
  /** Provider session id (for resume on the next turn), when revealed. */
  sessionId?: string;
  /** The provider's final message text (or result-file content). */
  resultText?: string;
  /** The parsed structured result; null when the text held no valid contract. */
  result: TurnResult | null;
  usage?: AgentUsage;
  eventCount: number;
  durationMs: number;
  /** The exact invocation for logs/UI (argv joined with spaces, un-quoted). */
  command: string;
  error?: string;
}

export async function runAgentTurn(opts: RunAgentTurnOptions): Promise<AgentTurnReport> {
  const startedAt = Date.now();
  const invocation = opts.driver.buildInvocation(opts.request, opts.tool);
  const commandLine = [invocation.command, ...invocation.args].join(' ');

  if (opts.request.scratchDir) {
    await fs.mkdir(opts.request.scratchDir, { recursive: true });
  }
  for (const [file, content] of Object.entries(invocation.preludeFiles ?? {})) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
  }
  if (invocation.resultFile) {
    await fs.rm(invocation.resultFile, { force: true }).catch(() => {});
  }

  const parser = opts.driver.createParser();
  let eventCount = 0;
  let liveUsage: AgentUsage | undefined;
  const stderrTail: string[] = [];

  const emit = (event: AgentEvent): void => {
    eventCount += 1;
    if (event.usage) liveUsage = mergeUsage(liveUsage, event.usage);
    try {
      opts.onEvent?.(event);
    } catch {
      /* the sink must never break the turn */
    }
  };

  if (opts.signal?.aborted) {
    return report('stopped', null, undefined, 'turn aborted before start');
  }

  const child = spawnAgentProcess(invocation.command, invocation.args, { cwd: opts.cwd, env: opts.env });

  let timedOut = false;
  let aborted = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void killProcessTree(child);
  }, opts.hardTimeoutMs);
  const onAbort = (): void => {
    aborted = true;
    void killProcessTree(child);
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  // Feed the prompt and close stdin — headless CLIs read to EOF. A child that
  // exits early (bad flag, auth failure, missing CLI) can break the pipe while
  // a large prompt is still buffered; an unhandled stdin `error` would crash the
  // whole process, so swallow it here (the exit/error is handled below).
  if (child.stdin) {
    child.stdin.on('error', () => {});
    if (invocation.stdinText !== undefined) child.stdin.write(invocation.stdinText);
    child.stdin.end();
  }

  if (child.stdout) {
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      for (const event of safePush(parser, line)) emit(event);
    });
  }
  if (child.stderr) {
    const errLines = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    errLines.on('line', (line) => {
      const text = line.trimEnd();
      if (!text.trim()) return;
      stderrTail.push(text);
      if (stderrTail.length > 40) stderrTail.shift();
      emit(agentEvent.stderr(text));
    });
  }

  const { exitCode, spawnError } = await new Promise<{ exitCode: number | null; spawnError?: string }>((resolve) => {
    child.once('error', (err) => resolve({ exitCode: null, spawnError: err.message }));
    child.once('close', (code) => resolve({ exitCode: code }));
  });

  clearTimeout(timeout);
  opts.signal?.removeEventListener('abort', onAbort);

  const summary = safeFinish(parser);
  const usage = mergeUsage(liveUsage, summary.usage);

  // Prefer the result file when the driver declared one (codex `-o`, agy):
  // it survives stream hiccups and IS the final message by contract.
  let resultText = summary.resultText;
  if (invocation.resultFile) {
    const fileText = await fs.readFile(invocation.resultFile, 'utf8').catch(() => '');
    if (fileText.trim()) resultText = fileText.trim();
  }
  const result = parseTurnResult(resultText);

  if (aborted) return report('stopped', exitCode, summary.sessionId, 'turn aborted', resultText, result, usage);
  if (timedOut) {
    return report(
      'failed',
      exitCode,
      summary.sessionId,
      `agent turn exceeded the hard timeout (${Math.round(opts.hardTimeoutMs / 60_000)} min)`,
      resultText,
      result,
      usage,
    );
  }
  if (spawnError) {
    return report(
      'failed',
      exitCode,
      summary.sessionId,
      `failed to launch ${invocation.command}: ${spawnError}`,
      resultText,
      result,
      usage,
    );
  }
  if (summary.isError) {
    return report(
      'failed',
      exitCode,
      summary.sessionId,
      summary.errorDetail ?? 'provider reported an error',
      resultText,
      result,
      usage,
    );
  }
  if (exitCode !== 0) {
    const detail = stderrTail.slice(-8).join('\n');
    return report(
      'failed',
      exitCode,
      summary.sessionId,
      `agent CLI exited with code ${exitCode}${detail ? `: ${detail}` : ''}`,
      resultText,
      result,
      usage,
    );
  }
  return report('completed', exitCode, summary.sessionId, undefined, resultText, result, usage);

  function report(
    state: AgentTurnState,
    exit: number | null,
    sessionId: string | undefined,
    error?: string,
    text?: string,
    parsed?: TurnResult | null,
    turnUsage?: AgentUsage,
  ): AgentTurnReport {
    const durationMs = Date.now() - startedAt;
    if (state !== 'completed') {
      logger.warn('agent turn did not complete', { provider: opts.driver.id, state, exit, error, durationMs });
    }
    return {
      state,
      exitCode: exit,
      sessionId,
      resultText: text,
      result: parsed ?? null,
      usage: turnUsage,
      eventCount,
      durationMs,
      command: commandLine,
      error,
    };
  }
}

function safePush(parser: { push(line: string): AgentEvent[] }, line: string): AgentEvent[] {
  try {
    return parser.push(line);
  } catch (err) {
    logger.warn('agent stream parser threw; line preserved as raw', { err });
    return [agentEvent.raw(line)];
  }
}

function safeFinish(parser: TurnStreamParser): TurnStreamSummary {
  try {
    return parser.finish();
  } catch (err) {
    logger.warn('agent stream parser finish() threw', { err });
    return {};
  }
}
