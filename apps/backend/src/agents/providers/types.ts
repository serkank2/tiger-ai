import type { CliToolConfig } from '../../orchestrator/types.js';
import type { AgentEvent, AgentUsage } from '../events.js';

// ---------------------------------------------------------------------------
// Provider driver contract — the v2 replacement for driving interactive TUIs.
// A driver knows two things about its CLI: how to build a HEADLESS invocation
// (argv + stdin) for one turn, and how to translate the CLI's machine output
// stream into normalized AgentEvents. Everything else (spawning, timeouts,
// aborts, result assembly) lives in the shared TurnRunner.
// ---------------------------------------------------------------------------

/** One MCP server the turn should have mounted (Kaplan's coordination bus). */
export interface TurnMcpServer {
  name: string;
  /** stdio transport: the command + args to launch the server. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Everything a driver needs to build one turn's invocation. */
export interface TurnRequest {
  /** The composed brief for this turn (sent via stdin or argv per driver). */
  prompt: string;
  /** Provider model id (empty = CLI default). */
  model?: string;
  /** Provider reasoning effort (empty = CLI default). */
  effort?: string;
  /**
   * Permission-mode key into the provider's built-in `permissionModes`
   * (config.ts fixes the key set per provider). Drivers translate the key to
   * headless-appropriate argv; a dangerous key is only honored when
   * `allowDangerous` is true, otherwise it degrades to the provider's safest
   * write-capable mode.
   */
  permission?: string;
  allowDangerous?: boolean;
  /** Resume this provider session (send only the new prompt). */
  resumeSessionId?: string;
  /**
   * Pin the new session to this id when the provider supports choosing one
   * (claude `--session-id`); ignored elsewhere. Lets the engine know the id
   * before the process even starts.
   */
  newSessionId?: string;
  /** JSON schema the provider should enforce on the final message, when supported. */
  resultSchema?: object;
  /**
   * Absolute path the driver may use for file-based artifacts it needs
   * (codex `--output-schema` file, agy result file). The runner creates the
   * directory; drivers derive file names under it.
   */
  scratchDir?: string;
  /** MCP servers to mount for this turn (drivers that support it). */
  mcpServers?: TurnMcpServer[];
  /** Additional raw argv appended verbatim (config extraArgs). */
  extraArgs?: string[];
}

/** A fully-built headless invocation, ready for the spawn helper. */
export interface TurnInvocation {
  command: string;
  args: string[];
  /** Text to write to the child's stdin (then close). Omit to close stdin immediately. */
  stdinText?: string;
  /**
   * File the provider (or the prompt contract) writes the final message to.
   * The runner reads it after exit as the resultText fallback (codex `-o`,
   * agy result file whose stdout is unreliable).
   */
  resultFile?: string;
  /** Files the driver needs written before spawn (path → content), e.g. codex schema file. */
  preludeFiles?: Record<string, string>;
}

/** What the parser distills once the process has exited. */
export interface TurnStreamSummary {
  /** Provider session id captured from the stream, when revealed. */
  sessionId?: string;
  /** The provider's own final-message text (claude result.result, codex agent_message…). */
  resultText?: string;
  /** Final usage/cost as reported by the provider. */
  usage?: AgentUsage;
  /** Whether the provider itself flagged the turn as failed. */
  isError?: boolean;
  /** Human-readable error detail when isError. */
  errorDetail?: string;
}

/** Incremental stdout parser: one instance per turn, fed line-by-line. */
export interface TurnStreamParser {
  /** Parse one stdout line into zero or more normalized events. Must never throw. */
  push(line: string): AgentEvent[];
  /** Called after process exit; returns the distilled summary. Must never throw. */
  finish(): TurnStreamSummary;
}

export interface ProviderDriver {
  readonly id: 'claude' | 'codex' | 'antigravity';
  readonly label: string;
  /** Whether the provider can resume a prior session by id in headless mode. */
  readonly supportsResume: boolean;
  /** Whether the provider can enforce a JSON schema on its final message. */
  readonly supportsResultSchema: boolean;
  buildInvocation(request: TurnRequest, tool: CliToolConfig): TurnInvocation;
  createParser(): TurnStreamParser;
}
