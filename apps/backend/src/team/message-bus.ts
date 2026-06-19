import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { PER_FILE_CAP, TOTAL_CONTEXT_CAP } from '../orchestrator/compose.js';
import type { TigerPaths } from '../orchestrator/paths.js';
import { TeamPaths } from './paths.js';
import type { TeamMessage, TeamMessageKind } from './types.js';

export type { TeamMessage } from './types.js';

export type TaskDirectiveAction = 'claim' | 'complete' | 'block' | 'request_review' | 'needs_work';

export interface TaskDirective {
  kind: 'task';
  taskId: string;
  action: TaskDirectiveAction;
  summary?: string;
}

export type SignOffStatus = 'done' | 'blocked' | 'pending';

export interface SignOffDirective {
  kind: 'signoff';
  roleId: string;
  status: SignOffStatus;
  summary: string;
}

export type VerificationDirectiveOutcome = 'passed' | 'failed' | 'inconclusive';

/**
 * A structured self-report of a verification a role actually ran (a build/test/check). This
 * replaces inferring pass/fail from prose: the role states the exact command, its exit code,
 * the outcome, and a short output excerpt. Recorded as a first-class verification record so
 * the done-gate's "objective checks passed" requirement is satisfied by explicit evidence,
 * not regex guessing. `roleId` is forced to the executing role (trust boundary), like sign-offs.
 */
export interface VerificationDirective {
  kind: 'verification';
  roleId: string;
  command?: string;
  exitCode?: number;
  outcome: VerificationDirectiveOutcome;
  summary?: string;
}

export type CoordinationVerb = 'handoff' | 'assign' | 'sendMessage';

/**
 * A parsed coordination directive (CAO `handoff` / `assign` / `sendMessage`). The delegating
 * identity (`fromRoleId`) is FORCED to the executing role — same trust boundary as sign-offs /
 * verification — so a worker can never forge a delegation as the Lead. The target (`toRoleId`)
 * stays agent-controlled; the orchestrator validates it against the run's roles when applying.
 *  - `handoff`     — synchronous delegation; the delegator's done-gate blocks until the target
 *                    completes the handed-off task.
 *  - `assign`      — asynchronous delegation; fire-and-forget (no blocking dependency).
 *  - `sendMessage` — deliver a message to the target role's inbox (surfaced at its next turn).
 */
export interface CoordinationDirective {
  kind: 'coordination';
  verb: CoordinationVerb;
  fromRoleId: string;
  toRoleId: string;
  title?: string;
  body: string;
}

export interface ParsedTeamOutput {
  messages: TeamMessage[];
  taskDirectives: TaskDirective[];
  signOffDirectives: SignOffDirective[];
  verificationDirectives: VerificationDirective[];
  coordinationDirectives: CoordinationDirective[];
}

export interface ParseTeamOutputDefaults {
  runId: string;
  turnId: string;
  roleId: string;
  roleName: string;
  startingSeq?: number;
  timestamp?: string;
}

export function teamRunDir(paths: TigerPaths, runId: string): string {
  return new TeamPaths(paths).runDir(safeSegment(runId));
}

export function teamRuntimeDir(paths: TigerPaths, runId: string): string {
  return new TeamPaths(paths).runtimeDir(safeSegment(runId));
}

export function transcriptFile(paths: TigerPaths, runId: string): string {
  return new TeamPaths(paths).conversationFile(safeSegment(runId));
}

export function turnsFile(paths: TigerPaths, runId: string): string {
  return path.join(teamRunDir(paths, runId), 'turns.ndjson');
}

export function artifactsFile(paths: TigerPaths, runId: string): string {
  return path.join(teamRunDir(paths, runId), 'artifacts.ndjson');
}

export async function appendTranscriptMessages(
  paths: TigerPaths,
  runId: string,
  messages: TeamMessage[],
): Promise<TeamMessage[]> {
  if (messages.length === 0) return [];
  const file = transcriptFile(paths, runId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const nextSeq = await nextMessageSeq(paths, runId);
  const persisted = messages.map((message, index) => ({ ...message, seq: nextSeq + index }));
  const lines = persisted.map((m) => JSON.stringify(m)).join('\n') + '\n';
  await fs.appendFile(file, lines, 'utf8');
  return persisted;
}

export async function readTranscriptMessages(paths: TigerPaths, runId: string): Promise<TeamMessage[]> {
  const raw = await fs.readFile(transcriptFile(paths, runId), 'utf8').catch(() => '');
  const out: TeamMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isTeamMessage(parsed)) out.push(parsed);
    } catch {
      // Ignore a corrupt historical line rather than blocking a new turn.
    }
  }
  return out;
}

export async function renderTranscriptWindow(
  paths: TigerPaths,
  runId: string,
  options: { maxCharacters?: number; maxMessages?: number } = {},
): Promise<string> {
  const maxCharacters = Math.min(options.maxCharacters ?? TOTAL_CONTEXT_CAP, TOTAL_CONTEXT_CAP);
  const maxMessages = Math.max(1, options.maxMessages ?? 80);
  const messages = await readTranscriptMessages(paths, runId);
  const selected: string[] = [];
  let used = 0;

  for (const message of messages.slice(-maxMessages).reverse()) {
    const rendered = renderMessageForPrompt(message);
    const capped = rendered.length > PER_FILE_CAP ? `${rendered.slice(0, PER_FILE_CAP)}\n_(truncated)_` : rendered;
    const next = capped.length + (selected.length ? 2 : 0);
    if (used + next > maxCharacters) break;
    selected.push(capped);
    used += next;
  }

  return selected.reverse().join('\n\n');
}

export function parseTeamOutput(output: string, defaults: ParseTeamOutputDefaults): ParsedTeamOutput {
  const parsed: ParsedTeamOutput = {
    messages: [],
    taskDirectives: [],
    signOffDirectives: [],
    verificationDirectives: [],
    coordinationDirectives: [],
  };
  const timestamp = defaults.timestamp ?? new Date().toISOString();
  const blocks = extractBlocks(output);

  for (const block of blocks) {
    const value = parseBlockJson(block);
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (block.kind === 'TeamMessage') {
        parsed.messages.push(normalizeMessage(item, defaults, timestamp));
      } else if (block.kind === 'TaskDirective') {
        parsed.taskDirectives.push(normalizeTaskDirective(item));
      } else if (block.kind === 'VerificationDirective') {
        parsed.verificationDirectives.push(normalizeVerificationDirective(item, defaults.roleId));
      } else if (block.kind === 'CoordinationDirective') {
        parsed.coordinationDirectives.push(normalizeCoordinationDirective(item, defaults.roleId));
      } else {
        parsed.signOffDirectives.push(normalizeSignOffDirective(item, defaults.roleId));
      }
    }
  }

  return parsed;
}

export function systemBlockerMessage(input: {
  runId: string;
  turnId: string;
  content: string;
  taskId?: string;
  timestamp?: string;
}): TeamMessage {
  return {
    id: nanoid(),
    runId: input.runId,
    turnId: input.turnId,
    seq: 0,
    from: 'system',
    to: 'all',
    kind: 'blocker',
    body: input.content,
    refs: input.taskId ? [{ kind: 'task', value: input.taskId }] : undefined,
    createdAt: input.timestamp ?? new Date().toISOString(),
  };
}

interface OutputBlock {
  kind: 'TeamMessage' | 'TaskDirective' | 'SignOffDirective' | 'VerificationDirective' | 'CoordinationDirective';
  body: string;
}

function extractBlocks(output: string): OutputBlock[] {
  const blocks: OutputBlock[] = [];
  const re =
    /```[ \t]*(TeamMessage|TaskDirective|SignOffDirective|VerificationDirective|CoordinationDirective)[^\r\n]*\r?\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(output)) !== null) {
    const kind = normalizeBlockKind(match[1]);
    const body = match[2];
    if (kind && body !== undefined) blocks.push({ kind, body: body.trim() });
  }
  return blocks;
}

function normalizeBlockKind(value: string | undefined): OutputBlock['kind'] | null {
  const lower = value?.toLowerCase();
  if (lower === 'teammessage') return 'TeamMessage';
  if (lower === 'taskdirective') return 'TaskDirective';
  if (lower === 'signoffdirective') return 'SignOffDirective';
  if (lower === 'verificationdirective') return 'VerificationDirective';
  if (lower === 'coordinationdirective') return 'CoordinationDirective';
  return null;
}

function parseBlockJson(block: OutputBlock): unknown {
  try {
    return JSON.parse(block.body);
  } catch (err) {
    throw new Error(`${block.kind} block contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function normalizeMessage(raw: unknown, defaults: ParseTeamOutputDefaults, timestamp: string): TeamMessage {
  if (!isRecord(raw)) throw new Error('TeamMessage block must contain a JSON object');
  const body = (stringField(raw, 'body') || stringField(raw, 'content')).trim();
  if (!body) throw new Error('TeamMessage.body is required');
  const kind = parseMessageKind(stringField(raw, 'kind') || stringField(raw, 'type', 'chat'));
  // SECURITY / trust boundary: an agent's output may only ever speak AS ITSELF. The sender
  // identity is forced to the executing role and is NEVER read from an agent-supplied
  // `roleId`/`roleName`. Otherwise a worker could emit a message with `roleId: "<lead>"` and
  // impersonate the Lead — the orchestrator treats `from === leadId` as authorization to
  // queue executable work and to delegate, so a forged `from` would bypass Lead-owned
  // sequencing entirely. `to` (the recipient) stays agent-controlled; only `from` is locked.
  const from = defaults.roleId;
  const taskId = optionalString(raw, 'taskId');
  const to = stringField(raw, 'to') || stringArrayField(raw, 'to', ['all'])[0] || 'all';
  return {
    id: optionalString(raw, 'id') ?? nanoid(),
    runId: defaults.runId,
    turnId: defaults.turnId,
    seq: defaults.startingSeq ?? 0,
    from,
    to,
    channel: optionalString(raw, 'channel'),
    kind,
    body,
    refs: taskId ? [{ kind: 'task', value: taskId }] : undefined,
    createdAt: timestamp,
  };
}

function normalizeTaskDirective(raw: unknown): TaskDirective {
  if (!isRecord(raw)) throw new Error('TaskDirective block must contain a JSON object');
  const taskId = stringField(raw, 'taskId').trim();
  if (!taskId) throw new Error('TaskDirective.taskId is required');
  const action = parseTaskDirectiveAction(stringField(raw, 'action'));
  return { kind: 'task', taskId, action, summary: optionalString(raw, 'summary') };
}

function normalizeSignOffDirective(raw: unknown, executingRoleId: string): SignOffDirective {
  if (!isRecord(raw)) throw new Error('SignOffDirective block must contain a JSON object');
  const status = parseSignOffStatus(stringField(raw, 'status'));
  const summary = stringField(raw, 'summary').trim();
  if (!summary) throw new Error('SignOffDirective.summary is required');
  // Trust boundary: a turn can only sign off for ITSELF. The directive's identity is forced
  // to the executing role and any agent-supplied `roleId` is ignored, so one agent can never
  // sign off on behalf of another required role and falsely satisfy the done-gate.
  return { kind: 'signoff', roleId: executingRoleId, status, summary };
}

function normalizeVerificationDirective(raw: unknown, executingRoleId: string): VerificationDirective {
  if (!isRecord(raw)) throw new Error('VerificationDirective block must contain a JSON object');
  const outcome = parseVerificationOutcome(stringField(raw, 'outcome') || stringField(raw, 'status'));
  const exitRaw = raw.exitCode;
  const exitCode = typeof exitRaw === 'number' && Number.isFinite(exitRaw) ? exitRaw : undefined;
  // Trust boundary: a turn can only report a verification AS ITSELF. The reporting identity is
  // forced to the executing role; any agent-supplied `roleId` is ignored — same rule as sign-offs.
  return {
    kind: 'verification',
    roleId: executingRoleId,
    command: optionalString(raw, 'command'),
    exitCode,
    outcome,
    summary: optionalString(raw, 'summary') ?? optionalString(raw, 'output'),
  };
}

function normalizeCoordinationDirective(raw: unknown, executingRoleId: string): CoordinationDirective {
  if (!isRecord(raw)) throw new Error('CoordinationDirective block must contain a JSON object');
  const verb = parseCoordinationVerb(stringField(raw, 'verb') || stringField(raw, 'action'));
  // `to` / `toRoleId` is the target role (agent-controlled, validated by the orchestrator).
  const toRoleId = (stringField(raw, 'to') || stringField(raw, 'toRoleId') || stringField(raw, 'roleId')).trim();
  if (!toRoleId) throw new Error('CoordinationDirective.to (target role id) is required');
  const body = (stringField(raw, 'body') || stringField(raw, 'content') || stringField(raw, 'message')).trim();
  if (!body) throw new Error('CoordinationDirective.body is required');
  // Trust boundary: the DELEGATING identity is FORCED to the executing role. An agent-supplied
  // `from`/`fromRoleId` is ignored — exactly like sign-offs/verification — so a worker can never
  // forge a handoff/assign/sendMessage AS THE LEAD and bypass Lead-owned delegation authority.
  return {
    kind: 'coordination',
    verb,
    fromRoleId: executingRoleId,
    toRoleId,
    title: optionalString(raw, 'title'),
    body,
  };
}

function parseCoordinationVerb(value: string): CoordinationVerb {
  switch (value) {
    case 'handoff':
      return 'handoff';
    case 'assign':
      return 'assign';
    case 'sendMessage':
    case 'sendmessage':
    case 'message':
    case 'send_message':
      return 'sendMessage';
    default:
      throw new Error(`unsupported CoordinationDirective.verb: ${value}`);
  }
}

function parseVerificationOutcome(value: string): VerificationDirectiveOutcome {
  switch (value) {
    case 'passed':
    case 'pass':
    case 'ok':
    case 'success':
      return 'passed';
    case 'failed':
    case 'fail':
    case 'error':
      return 'failed';
    case 'inconclusive':
    case 'skipped':
    case 'unknown':
    case '':
      return 'inconclusive';
    default:
      throw new Error(`unsupported VerificationDirective.outcome: ${value}`);
  }
}

function parseMessageKind(value: string): TeamMessageKind {
  switch (value) {
    case 'chat':
    case 'decision':
    case 'task':
    case 'handoff':
    case 'tool':
    case 'verification':
    case 'finding':
    case 'steering':
    case 'signoff':
    case 'system':
    case 'blocker':
      return value;
    case 'status':
    case 'instruction':
    case 'question':
      return 'chat';
    default:
      throw new Error(`unsupported TeamMessage.kind: ${value}`);
  }
}

function parseTaskDirectiveAction(value: string): TaskDirectiveAction {
  switch (value) {
    case 'claim':
    case 'complete':
    case 'block':
    case 'request_review':
    case 'needs_work':
      return value;
    default:
      throw new Error(`unsupported TaskDirective.action: ${value}`);
  }
}

function parseSignOffStatus(value: string): SignOffStatus {
  switch (value) {
    case 'done':
    case 'blocked':
    case 'pending':
      return value;
    default:
      throw new Error(`unsupported SignOffDirective.status: ${value}`);
  }
}

function renderMessageForPrompt(message: TeamMessage): string {
  const to = message.to ? ` -> ${message.to}` : '';
  return `[${message.createdAt}] ${message.from}/${message.kind}${to}\n${message.body}`;
}

function isTeamMessage(value: unknown): value is TeamMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.seq === 'number' &&
    typeof value.from === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.body === 'string' &&
    typeof value.createdAt === 'string'
  );
}

function stringField(raw: Record<string, unknown>, key: string, fallback = ''): string {
  const value = raw[key];
  return typeof value === 'string' ? value : fallback;
}

function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringArrayField(raw: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const value = raw[key];
  if (!Array.isArray(value)) return fallback;
  const out = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return out.length ? out : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function nextMessageSeq(paths: TigerPaths, runId: string): Promise<number> {
  const messages = await readTranscriptMessages(paths, runId);
  return messages.length ? messages[messages.length - 1]!.seq + 1 : 1;
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '-');
  return safe || 'run';
}
