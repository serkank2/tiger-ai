import { promises as fs } from 'node:fs';
import path from 'node:path';
import { measurePromptSize, PER_FILE_CAP, TOTAL_CONTEXT_CAP, type PromptSize } from '../orchestrator/compose.js';
import type { AgentType } from '../orchestrator/types.js';
import type { TigerPaths } from '../orchestrator/paths.js';
import { renderTranscriptWindow } from './message-bus.js';

export interface TeamRole {
  id: string;
  name: string;
  agentType: AgentType;
  persona: string;
  responsibilities: string[];
}

export type RoleTurnRole =
  | TeamRole
  | {
      id: string;
      name: string;
      description?: string;
      persona?: string;
      responsibilities?: string[];
      agentType?: AgentType;
      tool?: AgentType;
      agent?: { tool: AgentType };
    };

export interface TeamContextBlock {
  id?: string;
  title?: string;
  content: string;
}

export interface ComposeRoleTurnOptions {
  paths: TigerPaths;
  runId: string;
  turnId: string;
  role: RoleTurnRole;
  outputPath: string;
  markerPath: string;
  assignedTask?: TeamContextBlock;
  finding?: TeamContextBlock;
  steering?: string[];
  verification?: string[];
  /** The exact gates still keeping the run open (so the role knows what "done" needs). */
  completionStatus?: string[];
  transcriptMaxMessages?: number;
}

export interface ComposedRoleTurnPrompt {
  prompt: string;
  size: PromptSize;
}

type NormalizedComposeRoleTurnOptions = Omit<ComposeRoleTurnOptions, 'role'> & { role: TeamRole };

export async function composeRoleTurnPrompt(opts: ComposeRoleTurnOptions): Promise<ComposedRoleTurnPrompt> {
  const role = normalizeTeamRole(opts.role);
  const normalized: NormalizedComposeRoleTurnOptions = { ...opts, role };
  const projectPrompt = await fs.readFile(opts.paths.projectPromptFile, 'utf8').catch(() => '');
  const transcript = await renderTranscriptWindow(opts.paths, opts.runId, {
    maxCharacters: TOTAL_CONTEXT_CAP,
    maxMessages: opts.transcriptMaxMessages,
  });
  const budget = new ContextBudget();

  // Spend the shared context budget in PRIORITY order, independent of display order: the
  // role's own persona first, then THIS turn's assignment and the open completion gates
  // (the agent must always see what it was scheduled to do and what still blocks the run),
  // and only THEN the bulky project prompt and transcript history with whatever remains.
  // Computing the budgeted strings here — before the transcript — guarantees a large
  // transcript can never starve the per-turn assignment down to nothing.
  const personaBlock = roleSection(normalized, budget);
  const assignedBlock = assignedContextSection(normalized, budget);
  const projectPromptText = budget.take('original project prompt', projectPrompt || '(project prompt not found)');
  const transcriptText = transcript.trim() ? budget.take('team transcript', transcript) : '(no prior team messages)';

  const sections = [
    automationPreamble(normalized),
    personaBlock,
    `---\n\n# ORIGINAL PROJECT PROMPT\n\nThis is the user's original request. Treat it as the source of truth for the project goal. It may be in any language; your own output must still be in English.\n\n<<<PROJECT_PROMPT\n${projectPromptText}\n>>>`,
    `---\n\n# TEAM TRANSCRIPT WINDOW\n\n${transcriptText}`,
    assignedBlock,
    outputContractSection(normalized),
  ];

  const prompt = sections.filter(Boolean).join('\n\n') + '\n';
  return { prompt, size: measurePromptSize(prompt) };
}

export function normalizeTeamRole(role: RoleTurnRole): TeamRole {
  const config = role as {
    agentType?: AgentType;
    tool?: AgentType;
    agent?: { tool: AgentType };
    description?: string;
    persona?: string;
    responsibilities?: string[];
  };
  return {
    id: role.id,
    name: role.name,
    agentType: config.agentType ?? config.agent?.tool ?? config.tool ?? 'codex',
    persona: config.persona?.trim() || config.description?.trim() || `Act as ${role.name} for this team turn.`,
    responsibilities:
      Array.isArray(config.responsibilities) && config.responsibilities.length
        ? config.responsibilities
        : ['Contribute from this role to move the project toward completion.'],
  };
}

function automationPreamble(opts: NormalizedComposeRoleTurnOptions): string {
  const outputRel = opts.paths.rel(opts.outputPath);
  const markerRel = opts.paths.rel(opts.markerPath);
  // The team improves the REAL project, so the working root is the workspace (the
  // directory that CONTAINS .tiger), not the .tiger metadata root.
  const workspace = path.dirname(opts.paths.root);
  return `# AUTOMATION CONTEXT -- READ THIS FIRST

You are an autonomous Tiger AI-team role agent. No human is available for questions or approvals during this turn.

- Do NOT ask any questions or wait for confirmation; make reasonable assumptions and proceed.
- Work only toward the project goal and this role turn's assigned context; avoid unrelated changes.
- Write every document, log, report, and comment in clear, professional English.
- Be decisive and concrete: take a clear position, make the smallest correct change for your role,
  and base every claim on what you actually read or ran — never on assumption.
- Be honest about state: do NOT report success, sign off, or pass a verification unless you are
  certain. If you are blocked or uncertain, say so plainly with a \`kind: "blocker"\` message.
- Your team run ID is: ${opts.runId}
- Your turn ID is: ${opts.turnId}
- Your role ID is: ${opts.role.id}
- Your working directory is the PROJECT ROOT: ${workspace}
- This is the REAL project you are improving. Read and modify its actual source files (apps/, src/,
  config, tests, etc.) to achieve the goal — this is where your product changes must land. Run the
  project's own build/test/checks from here.
- Your team's private bookkeeping lives under \`${workspace}/.tiger/team/\`. Write your turn
  deliverable and your completion marker to the EXACT absolute paths given below (they are inside
  .tiger), but make your real product changes in the project itself, NOT in .tiger.
- WORKSPACE BOUNDARY — STRICT: stay within this project root (${workspace}). You may read and edit
  anything under it. NEVER write, move, or delete anything OUTSIDE it (no absolute paths elsewhere,
  no ".." climbing above it, no home, temp, or system locations).
- Save your deliverable to exactly this file (absolute path):
    ${opts.outputPath}
    (relative to the project root: ${outputRel})
- COMPLETION SIGNAL: when you have completely finished AND your deliverable file is written, your
  FINAL action MUST be to create this marker file and write the single word "done" into it:
    ${opts.markerPath}
    (relative to the project root: ${markerRel})
  The orchestrator watches for this marker to know you are done. Do not create it early.`;
}

function roleSection(opts: NormalizedComposeRoleTurnOptions, budget: ContextBudget): string {
  const responsibilities = opts.role.responsibilities.length
    ? opts.role.responsibilities.map((item) => `- ${item}`).join('\n')
    : '- Contribute from this role to move the project toward completion.';
  return `---\n\n# ROLE PERSONA AND RESPONSIBILITIES\n\nRole name: ${opts.role.name}\nRole id: ${opts.role.id}\nCLI agent type: ${opts.role.agentType}\n\nPersona:\n${budget.take('role persona', opts.role.persona)}\n\nResponsibilities:\n${budget.take('role responsibilities', responsibilities)}`;
}

function assignedContextSection(opts: NormalizedComposeRoleTurnOptions, budget: ContextBudget): string {
  const parts: string[] = ['---\n\n# ASSIGNED TURN CONTEXT'];
  if (opts.assignedTask) {
    parts.push(
      `## Assigned Task${opts.assignedTask.id ? `: ${opts.assignedTask.id}` : ''}${opts.assignedTask.title ? ` -- ${opts.assignedTask.title}` : ''}\n\n${budget.take('assigned task', opts.assignedTask.content)}`,
    );
  } else {
    parts.push('## Assigned Task\n\n(no specific task assigned for this turn)');
  }

  if (opts.finding) {
    parts.push(
      `## Finding${opts.finding.id ? `: ${opts.finding.id}` : ''}${opts.finding.title ? ` -- ${opts.finding.title}` : ''}\n\n${budget.take('finding context', opts.finding.content)}`,
    );
  }

  if (opts.steering?.length) {
    parts.push(`## User/Lead Steering\n\n${budget.take('steering context', opts.steering.map((s) => `- ${s}`).join('\n'))}`);
  }

  if (opts.verification?.length) {
    parts.push(
      `## Verification Context\n\n${budget.take('verification context', opts.verification.map((s) => `- ${s}`).join('\n'))}`,
    );
  }

  if (opts.completionStatus?.length) {
    parts.push(
      `## What The Run Still Needs To Complete\n\nThe run will not finish until every item below is resolved. ` +
        `Act to close whichever of these your role is responsible for; do not sign off until your part is genuinely ` +
        `done with evidence:\n\n${budget.take('completion status', opts.completionStatus.map((s) => `- ${s}`).join('\n'))}`,
    );
  }

  return parts.join('\n\n');
}

function outputContractSection(opts: NormalizedComposeRoleTurnOptions): string {
  return `---\n\n# STRICT STRUCTURED OUTPUT CONTRACT

Write the deliverable file at the exact output path above. The file MUST contain one or more fenced \`TeamMessage\` block(s). Each block body must be valid JSON and must follow this shape:

\`\`\`TeamMessage
{
  "kind": "chat",
  "to": "all",
  "body": "Concise message for the internal team transcript.",
  "taskId": "OPTIONAL-TASK-ID"
}
\`\`\`

Allowed \`kind\` values are: chat, decision, task, handoff, tool, verification, finding, steering, signoff, system, blocker.

Optional task directive block:

\`\`\`TaskDirective
{
  "taskId": "TASK-000",
  "action": "complete",
  "summary": "Short reason."
}
\`\`\`

Allowed task directive actions are: claim, complete, block, request_review, needs_work. These actually drive the task board: \`complete\` files the task done, \`block\`/\`needs_work\` return it to the queue for rework, \`request_review\` routes it to the Lead, and \`claim\` takes a queued task.

Optional verification directive block — emit this when you actually ran a build/test/check, so the result is recorded as objective evidence (preferred over describing it in prose):

\`\`\`VerificationDirective
{
  "command": "npm test",
  "exitCode": 0,
  "outcome": "passed",
  "summary": "Unit suite: 312 passed, 0 failed."
}
\`\`\`

Allowed verification outcomes are: passed, failed, inconclusive. Report \`passed\` ONLY when the command actually succeeded (e.g. exit code 0) — this is what lets the run satisfy its "objective checks passed" gate.

Optional sign-off directive block:

\`\`\`SignOffDirective
{
  "roleId": "${opts.role.id}",
  "status": "done",
  "summary": "What this role has verified or why it is blocked."
}
\`\`\`

Allowed sign-off statuses are: done, blocked, pending. You are recorded as signed off ONLY when you emit a \`SignOffDirective\` with \`"status": "done"\` — a \`signoff\` chat message, or status \`pending\`/\`blocked\`, does NOT mark you done. Emit \`done\` only when your role's responsibilities are genuinely met with evidence.

Communication discipline (this is a real team — make every message earn its place):
- Post only substantive messages that move the work forward. Do NOT narrate, restate what others already said, or pad. One sharp message beats five vague ones.
- When you decide something, use \`"kind": "decision"\` and state the choice AND the one-line reason.
- To ASSIGN concrete work to another role, post a \`"kind": "task"\` message with \`"to"\` set to that role's id and the body as a clear, self-contained task: a short title line, what to do, and acceptance criteria. The system queues it on that role's task board (todo → in-progress → done) and they will work it next. Assign ONE task per message; do not re-send a task already assigned.
- When you simply hand off or notify (no new task), use \`"kind": "handoff"\`, set \`"to"\` to that role id, and name the exact next action.
- When you report a result of checking/building/testing, use \`"kind": "verification"\` and include what you ran and the outcome.
- Sign off (\`"kind": "signoff"\` + a \`SignOffDirective\` with \`"status": "done"\`) ONLY when your role's responsibilities are genuinely met and you have concrete evidence — never as a courtesy.

Do not report success if you are uncertain. Use a \`TeamMessage\` with \`"kind": "blocker"\` when the turn cannot complete safely. After the output file is fully written, create the marker file as your final action.`;
}

class ContextBudget {
  private left = TOTAL_CONTEXT_CAP;

  take(label: string, content: string): string {
    if (this.left <= 0) return `_(omitted: ${label} exceeded the total context budget)_`;
    let text = content.trim() || '(empty)';
    let truncated = false;
    if (text.length > PER_FILE_CAP) {
      text = text.slice(0, PER_FILE_CAP);
      truncated = true;
    }
    if (text.length > this.left) {
      text = text.slice(0, this.left);
      truncated = true;
    }
    this.left -= text.length;
    return truncated ? `${text}\n\n_(truncated to respect Tiger context caps)_` : text;
  }
}
