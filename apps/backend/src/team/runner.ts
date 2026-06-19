import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { TerminalManager } from '../terminal/TerminalManager.js';
import { AgentSession, type AgentRunResult } from '../orchestrator/AgentSession.js';
import type { RoleCliSession } from './role-session.js';
import { buildLaunchCommand, type LaunchParams } from '../orchestrator/launch-command.js';
import type { TigerConfig } from '../orchestrator/types.js';
import type { TigerPaths } from '../orchestrator/paths.js';
import { checkOutputFile } from '../orchestrator/validate.js';
import {
  composeRoleTurnPrompt,
  normalizeTeamRole,
  type ComposeRoleTurnOptions,
  type RoleTurnRole,
  type TeamContextBlock,
} from './compose-turn.js';
import {
  appendTranscriptMessages,
  artifactsFile,
  parseTeamOutput,
  systemBlockerMessage,
  teamRuntimeDir,
  turnsFile,
  type ParsedTeamOutput,
} from './message-bus.js';
import type { TeamMessage } from './types.js';

export interface RunRoleTurnOptions {
  manager: TerminalManager;
  paths: TigerPaths;
  config: TigerConfig;
  runId: string;
  role: RoleTurnRole;
  assignedTask?: TeamContextBlock;
  finding?: TeamContextBlock;
  steering?: string[];
  verification?: string[];
  completionStatus?: string[];
  transcriptMaxMessages?: number;
  model?: string;
  effort?: string;
  permission?: string;
  signal?: AbortSignal;
  /** Caller-supplied turn id; makes the live terminal id deterministic for the UI. */
  turnId?: string;
  /** Stable terminal id to use (per-role for persistent sessions); defaults to per-turn. */
  terminalId?: string;
  /**
   * A live, persistent CLI session to feed this turn's prompt to. When provided, the
   * turn reuses the running REPL (preserving context) instead of launching a fresh
   * one-shot AgentSession. Standalone callers omit it for the one-shot path.
   */
  session?: RoleCliSession;
  /**
   * Whether this turn appends its parsed messages to the run's `conversation.jsonl`.
   * Standalone callers leave this `true` so the runner owns persistence. When the
   * {@link TeamOrchestrator} drives the turn it sets this `false`: the orchestrator
   * is the single authoritative writer of the conversation (it stamps `seq` and
   * emits the WS `message` event), so the runner must only parse-and-return here,
   * otherwise every message would be written twice with conflicting sequence numbers.
   */
  persistTranscript?: boolean;
}

export interface RunRoleTurnResult {
  runId: string;
  turnId: string;
  terminalId: string;
  promptPath: string;
  outputPath: string;
  markerPath: string;
  command: string;
  outcome: AgentRunResult;
  parsed: ParsedTeamOutput;
  messages: TeamMessage[];
}

export async function runRoleTurn(opts: RunRoleTurnOptions): Promise<RunRoleTurnResult> {
  const role = normalizeTeamRole(opts.role);
  const runOpts: RunRoleTurnOptions = { ...opts, role };
  // Use the caller-supplied turn id when given (the orchestrator passes its own turn
  // id so the live terminal id is deterministic and known to the UI before the turn
  // finishes); otherwise generate one for standalone callers.
  const turnId = opts.turnId ?? nanoid();
  // The team works on the REAL project, so the agent's working directory is the
  // workspace (project root), not the .tiger metadata root. Team bookkeeping (prompt,
  // output, marker) still lives under .tiger via the absolute paths below.
  const workspace = path.dirname(runOpts.paths.root);
  const runtimeDir = teamRuntimeDir(runOpts.paths, runOpts.runId);
  const promptPath = path.join(runtimeDir, `${turnId}.prompt.md`);
  const outputPath = path.join(runtimeDir, `${turnId}.output.md`);
  const markerPath = path.join(runtimeDir, `${turnId}.done`);
  const terminalId = opts.terminalId ?? safeTerminalId(`team-${runOpts.runId}-${turnId}`);
  // Build launch params from the raw opts.role, NOT the normalized runOpts.role:
  // normalizeTeamRole() keeps only { id, name, agentType, persona, responsibilities } and drops the
  // role's agent/model/effort/permission. roleLaunchParams must see the un-normalized role so
  // roleAgentString can read those per-role CLI settings; it re-normalizes internally to resolve agentType.
  const launchParams = roleLaunchParams(opts);
  const command = buildLaunchCommand(runOpts.config, role.agentType, launchParams);
  const startedAt = new Date().toISOString();

  await fs.mkdir(runtimeDir, { recursive: true });
  await Promise.all([fs.rm(outputPath, { force: true }), fs.rm(markerPath, { force: true })]);

  const composed = await composeRoleTurnPrompt({
    paths: opts.paths,
    runId: opts.runId,
    turnId,
    role,
    outputPath,
    markerPath,
    assignedTask: opts.assignedTask,
    finding: opts.finding,
    steering: opts.steering,
    verification: opts.verification,
    completionStatus: opts.completionStatus,
    transcriptMaxMessages: opts.transcriptMaxMessages,
  } satisfies ComposeRoleTurnOptions);
  await fs.writeFile(promptPath, composed.prompt, 'utf8');

  const now = new Date().toISOString();
  opts.manager.upsertDefinition({
    id: terminalId,
    name: `${role.name} (${turnId.slice(0, 6)})`,
    groupId: null,
    cwd: workspace,
    initialCommand: command,
    shell: { kind: 'system-default' },
    protected: true,
    createdAt: now,
    updatedAt: now,
  });

  const signal = runOpts.signal ?? new AbortController().signal;
  let sessionResult: AgentRunResult;
  if (opts.session) {
    // Persistent path: feed this prompt to the role's live REPL, which retains its
    // context across turns instead of relaunching the CLI every turn.
    opts.session.noteFed(composed.size.characters);
    const r = await opts.session.runPrompt({ promptPath, outputPath, markerPath, signal });
    sessionResult = { state: r.state, exitCode: r.exitCode, error: r.error };
  } else {
    // One-shot path (standalone / Tiger-style): launch, prompt, wait, stop.
    const session = new AgentSession({
      manager: opts.manager,
      termId: terminalId,
      label: role.id,
      command,
      cwd: workspace,
      promptPath,
      outputPath,
      markerPath,
      timing: runOpts.config.timing,
    });
    sessionResult = await session.run(signal);
  }
  const parsed = await parseCompletedOrBlocker(runOpts, turnId, outputPath, sessionResult);
  // When an orchestrator drives the turn it owns conversation persistence (and seq
  // assignment), so we only parse-and-return; standalone callers persist here.
  const messages =
    runOpts.persistTranscript === false
      ? parsed.messages
      : await appendTranscriptMessages(runOpts.paths, runOpts.runId, parsed.messages);
  const persistedParsed: ParsedTeamOutput = { ...parsed.parsed, messages };

  const endedAt = new Date().toISOString();
  await recordTurn(runOpts, {
    turnId,
    terminalId,
    promptPath,
    outputPath,
    markerPath,
    command,
    startedAt,
    endedAt,
    outcome: parsed.outcome,
    messageCount: messages.length,
    promptCharacters: composed.size.characters,
  });
  await recordArtifacts(runOpts, {
    turnId,
    terminalId,
    promptPath,
    outputPath,
    markerPath,
  });

  return {
    runId: opts.runId,
    turnId,
    terminalId,
    promptPath,
    outputPath,
    markerPath,
    command,
    outcome: parsed.outcome,
    parsed: persistedParsed,
    messages,
  };
}

interface ParseOutcome {
  outcome: AgentRunResult;
  parsed: ParsedTeamOutput;
  messages: TeamMessage[];
}

async function parseCompletedOrBlocker(
  opts: RunRoleTurnOptions,
  turnId: string,
  outputPath: string,
  sessionResult: AgentRunResult,
): Promise<ParseOutcome> {
  const outputCheck = await checkOutputFile(outputPath);
  const outputText = outputCheck.ok ? await fs.readFile(outputPath, 'utf8') : '';
  if (sessionResult.state === 'completed' && outputCheck.ok) {
    try {
      const parsed = parseTeamOutput(outputText, {
        runId: opts.runId,
        turnId,
        roleId: opts.role.id,
        roleName: opts.role.name,
      });
      if (parsed.messages.length === 0) {
        throw new Error('output did not contain any TeamMessage blocks');
      }
      return { outcome: sessionResult, parsed, messages: parsed.messages };
    } catch (err) {
      return blockerOutcome(opts, turnId, `Role turn output was invalid: ${messageOf(err)}`);
    }
  }

  const detail =
    sessionResult.error ??
    outputCheck.reason ??
    (sessionResult.state === 'stopped' ? 'role turn was stopped before completion' : 'role turn did not complete');
  const failed: AgentRunResult = {
    ...sessionResult,
    state: sessionResult.state === 'stopped' ? 'stopped' : 'failed',
    error: detail,
  };
  const blocker = systemBlockerMessage({
    runId: opts.runId,
    turnId,
    taskId: opts.assignedTask?.id,
    content: `Role turn failed for ${opts.role.name}: ${detail}`,
  });
  const parsed: ParsedTeamOutput = { messages: [blocker], taskDirectives: [], signOffDirectives: [] };
  return { outcome: failed, parsed, messages: parsed.messages };
}

function blockerOutcome(opts: RunRoleTurnOptions, turnId: string, reason: string): ParseOutcome {
  const blocker = systemBlockerMessage({
    runId: opts.runId,
    turnId,
    taskId: opts.assignedTask?.id,
    content: reason,
  });
  const parsed: ParsedTeamOutput = { messages: [blocker], taskDirectives: [], signOffDirectives: [] };
  return { outcome: { state: 'failed', error: reason }, parsed, messages: parsed.messages };
}

function roleLaunchParams(opts: RunRoleTurnOptions): LaunchParams {
  const defaults = opts.config.defaults;
  const role = normalizeTeamRole(opts.role);
  // Fall back to the defaults of the role's actual provider so an Antigravity role never
  // inherits Codex/Claude model/effort/permission values it cannot use.
  const providerDefaults =
    role.agentType === 'claude'
      ? { model: defaults.claudeModel, effort: defaults.claudeEffort, permission: defaults.claudePermission }
      : role.agentType === 'antigravity'
        ? {
            model: defaults.antigravityModel,
            effort: defaults.antigravityEffort,
            permission: defaults.antigravityPermission,
          }
        : { model: defaults.codexModel, effort: defaults.codexEffort, permission: defaults.codexPermission };
  return {
    model: opts.model ?? roleAgentString(opts.role, 'model') ?? providerDefaults.model,
    effort: opts.effort ?? roleAgentString(opts.role, 'effort') ?? providerDefaults.effort,
    permission: opts.permission ?? roleAgentString(opts.role, 'permission') ?? providerDefaults.permission,
  };
}

function roleAgentString(role: RoleTurnRole, key: 'model' | 'effort' | 'permission'): string | undefined {
  const raw = role as { agent?: Partial<Record<typeof key, unknown>> } & Partial<Record<typeof key, unknown>>;
  const direct = raw[key];
  if (typeof direct === 'string') return direct;
  const nested = raw.agent?.[key];
  return typeof nested === 'string' ? nested : undefined;
}

async function recordTurn(
  opts: RunRoleTurnOptions,
  input: {
    turnId: string;
    terminalId: string;
    promptPath: string;
    outputPath: string;
    markerPath: string;
    command: string;
    startedAt: string;
    endedAt: string;
    outcome: AgentRunResult;
    messageCount: number;
    promptCharacters: number;
  },
): Promise<void> {
  await appendJsonLine(turnsFile(opts.paths, opts.runId), {
    runId: opts.runId,
    turnId: input.turnId,
    terminalId: input.terminalId,
    roleId: opts.role.id,
    roleName: opts.role.name,
    agentType: opts.role.agentType,
    command: input.command,
    promptPath: input.promptPath,
    outputPath: input.outputPath,
    markerPath: input.markerPath,
    outcome: input.outcome,
    messageCount: input.messageCount,
    promptCharacters: input.promptCharacters,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  });
}

async function recordArtifacts(
  opts: RunRoleTurnOptions,
  input: {
    turnId: string;
    terminalId: string;
    promptPath: string;
    outputPath: string;
    markerPath: string;
  },
): Promise<void> {
  for (const [kind, absPath] of [
    ['prompt', input.promptPath],
    ['output', input.outputPath],
    ['marker', input.markerPath],
  ] as const) {
    const stat = await fs.stat(absPath).catch(() => null);
    await appendJsonLine(artifactsFile(opts.paths, opts.runId), {
      runId: opts.runId,
      turnId: input.turnId,
      terminalId: input.terminalId,
      roleId: opts.role.id,
      kind,
      absPath,
      relPath: opts.paths.rel(absPath),
      sizeBytes: stat?.isFile() ? stat.size : null,
      recordedAt: new Date().toISOString(),
    });
  }
}

async function appendJsonLine(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(value) + '\n', 'utf8');
}

function safeTerminalId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/** Stable per-role terminal id for a run — one live CLI session per role. */
export function teamRoleTerminalId(runId: string, roleId: string): string {
  return safeTerminalId(`team-${runId}-${roleId}`);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
