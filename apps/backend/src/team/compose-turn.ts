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
  /** Inbox messages (from `sendMessage` coordination verbs) addressed to this role. */
  inbox?: string[];
  /** The exact gates still keeping the run open (so the role knows what "done" needs). */
  completionStatus?: string[];
  transcriptMaxMessages?: number;
  /** True when this role is the resolved Lead for this turn, including fallback Lead roles. */
  isLeadTurn?: boolean;
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
    leadCoordinatorOnlySection(normalized),
    engineeringLawsSection(),
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
- You run as a CLI-first autonomous coding agent (codex / claude / agy). There are NO model API keys in this role context; rely on your CLI tools, the local repo, and the project's own commands.
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

/**
 * The cross-cutting engineering discipline every role inherits ON TOP of its persona.
 * These are the durable, model-agnostic patterns distilled from strong autonomous-agent
 * harnesses (evidence-over-claims, fresh verification, severity/confidence calibration,
 * completeness-by-default, minimal blast radius, anti-noise, autonomy circuit-breakers,
 * completion honesty). Keeping them HERE — once, shared — means a role's persona stays
 * focused on its role-specific opinions instead of repeating the same laws in every template.
 * This block is small and essential, so it is injected verbatim (not budgeted away).
 */
function engineeringLawsSection(): string {
  return `---

# TEAM ENGINEERING LAWS -- NON-NEGOTIABLE

These laws apply to EVERY role on every turn, on top of your persona. They are how this team stays high-signal and trustworthy. Follow them unless explicit user/Lead steering overrides a specific point.

1. EVIDENCE OVER CLAIMS. Never assert anything you have not verified. When you report a bug, a finding, or a result, quote the exact \`path:line\` you read, or paste the command and its real output that proves it. A statement you cannot back with a quoted line or pasted output is not a fact — label it "unverified" or do not say it. "It should work" and "I'm confident" are not evidence: run it and show the result.

2. FRESH VERIFICATION. Never report a build, type-check, lint, or test as passing from memory or assumption. Run it THIS turn and record the outcome with a \`VerificationDirective\`. The code changed since anyone last ran it; a stale pass is not a pass. Report \`passed\` only on a real exit code 0.

3. SEVERITY + CONFIDENCE ON EVERY FINDING. Tag each finding \`[Critical|High|Medium|Low] (confidence N/10)\`. Surface confidence >= 7 as a real finding; 4-6 only with an explicit "verify this" caveat; below 4 stay silent unless it is a release blocker. Be honest about confidence: verified-in-code is 8-9, inference is 4-5.

4. COMPLETENESS BY DEFAULT. The marginal cost of doing the whole thing is low, so do it: handle the happy path AND the null/empty path AND the error path. Prefer the complete, correct solution over a happy-path shortcut unless steering explicitly scopes it down.

5. MINIMAL BLAST RADIUS. Make the smallest change that fully solves your assigned task. Do NOT refactor, reformat, or "improve" unrelated code while you are in there. One logical change per task; if you discover separate work, file it as a task instead of silently bundling it.

6. HIGH SIGNAL, NO NOISE. Post only messages that move the work forward, and raise only real problems. Do not narrate, restate what others already said, flag harmless style nits, or re-report something already handled. One sharp message beats five vague ones.

7. CIRCUIT BREAKERS — STOP INSTEAD OF THRASHING. If you have tried 3 approaches/fixes without success, OR your change would spread beyond ~5 files outside your task scope, OR each fix reveals a new problem (you are at the wrong layer) — STOP. Emit a \`blocker\` message to the Lead stating what you tried and the evidence, and let the team re-plan. Never repeat the same failing action in a loop.

8. COMPLETION HONESTY. Code that *handles* a deliverable is not the deliverable — verify the actual end-to-end outcome. Prefer reporting "partial" or "unverified" over a generous "done". Sign off only when your role's responsibilities are genuinely met, with evidence.

9. ONGOING PROGRAM MODEL. A run is an ongoing program, not a one-shot checklist. Passing gates is necessary but not sufficient: the run ends only after the Lead emits an explicit project-complete decision and every required sign-off/gate has evidence.

10. PARALLEL TEAM MODEL. Do not assume you are the only role working. Do not block peers unless your assigned context requires it; read-only roles may and should progress while the Developer writes, and every role should keep outputs scoped so parallel work can continue.

11. ENGLISH WORKING LANGUAGE. Always reason, plan, write every message, and produce all task output in English, regardless of the language of the user's prompt — English keeps the team and tools reliable. The human may translate the chat to another language in their own UI; that never changes the language you write in. Code identifiers, comments, and commit messages stay in English too.`;
}

function roleSection(opts: NormalizedComposeRoleTurnOptions, budget: ContextBudget): string {
  const responsibilities = opts.role.responsibilities.length
    ? opts.role.responsibilities.map((item) => `- ${item}`).join('\n')
    : '- Contribute from this role to move the project toward completion.';
  return `---\n\n# ROLE PERSONA AND RESPONSIBILITIES\n\nRole name: ${opts.role.name}\nRole id: ${opts.role.id}\nCLI agent type: ${opts.role.agentType}\n\nPersona:\n${budget.take('role persona', opts.role.persona)}\n\nResponsibilities:\n${budget.take('role responsibilities', responsibilities)}`;
}

function leadCoordinatorOnlySection(opts: NormalizedComposeRoleTurnOptions): string {
  if (!isLeadTurn(opts)) return '';
  return `---

# LEAD COORDINATOR-ONLY RULE -- NON-BUDGETED AND NON-OVERRIDABLE

This rule applies even if your persona, template, persisted role text, legacy role text, custom role text, or fallback role text says otherwise.

The Lead's only job is to organize the team. Do NOT perform source inspection; do NOT inspect diffs, logs, artifacts, or external references; do NOT perform documentation or web research; do NOT execute commands; do NOT implement or edit code; do NOT run tests; do NOT run build or verification checks; and do NOT perform review work.

Delegate all source inspection, diff/log/artifact/external-reference inspection, documentation or web research, command execution, implementation, test execution, verification, and review work to non-Lead roles. Collect their answers and cite their reported evidence instead of doing the work yourself.`;
}

function isLeadTurn(opts: NormalizedComposeRoleTurnOptions): boolean {
  if (opts.isLeadTurn === true) return true;
  const text = `${opts.role.id} ${opts.role.name}`.toLowerCase();
  return /\blead\b|tech ?lead|team ?lead/.test(text);
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
    parts.push(
      `## User/Lead Steering\n\n${budget.take('steering context', opts.steering.map((s) => `- ${s}`).join('\n'))}`,
    );
  }

  if (opts.verification?.length) {
    parts.push(
      `## Verification Context\n\n${budget.take('verification context', opts.verification.map((s) => `- ${s}`).join('\n'))}`,
    );
  }

  if (opts.inbox?.length) {
    parts.push(
      `## Your Inbox (messages sent directly to you)\n\nAnother role used \`sendMessage\` to reach you. Read these and act on them this turn:\n\n${budget.take('inbox', opts.inbox.map((s) => `- ${s}`).join('\n'))}`,
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

Optional coordination directive block — explicit, first-class coordination verbs (typically used by the Lead). The system applies these on top of the task board:

\`\`\`CoordinationDirective
{
  "verb": "handoff",
  "to": "tester",
  "title": "Verify the login flow",
  "body": "Run the end-to-end login tests and report pass/fail with the command + output."
}
\`\`\`

Allowed verbs are: handoff, assign, sendMessage.
- \`handoff\` (SYNCHRONOUS): delegate a scoped task to \`to\` and BLOCK on it — the run is not done until \`to\` completes the handed-off task. Use when you cannot finish your own work until they finish theirs.
- \`assign\` (ASYNCHRONOUS): delegate a scoped task to \`to\` fire-and-forget — they report back via a normal message when done; you are NOT blocked. Use to parallelize independent work.
- \`sendMessage\` (INBOX): deliver a message to \`to\`'s inbox; it is surfaced to them at their next turn. Use to inform/ask without assigning a task.
Only the Lead may \`handoff\`/\`assign\` executable work (a non-Lead attempt is flagged for Lead review, not run); any role may \`sendMessage\`. The delegating identity is always recorded as YOU — you cannot send as another role.

Authority and review flow:
- Only the Lead assigns executable work. This is enforced by the orchestrator; non-Lead roles report needs, findings, and recommendations up to the Lead instead of assigning work directly.
- The Business Analyst's acceptance criteria become the Tester's cases. The Developer implements the Lead-assigned task, the Tester verifies behavior against those cases, and the Reviewer reviews the diff against intent and correctness.
- Workers report progress, blockers, verification, and sign-off to the Lead so the Lead can re-plan and decide when a project-complete decision is warranted.

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
