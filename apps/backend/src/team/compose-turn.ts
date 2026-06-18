import { promises as fs } from 'node:fs';
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

  const sections = [
    automationPreamble(normalized),
    roleSection(normalized, budget),
    `---\n\n# ORIGINAL PROJECT PROMPT\n\nThis is the user's original request. Treat it as the source of truth for the project goal. It may be in any language; your own output must still be in English.\n\n<<<PROJECT_PROMPT\n${budget.take('original project prompt', projectPrompt || '(project prompt not found)')}\n>>>`,
    `---\n\n# TEAM TRANSCRIPT WINDOW\n\n${transcript.trim() ? budget.take('team transcript', transcript) : '(no prior team messages)'}`,
    assignedContextSection(normalized, budget),
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
  return `# AUTOMATION CONTEXT -- READ THIS FIRST

You are an autonomous Tiger AI-team role agent. No human is available for questions or approvals during this turn.

- Do NOT ask any questions or wait for confirmation; make reasonable assumptions and proceed.
- Work only toward the project goal and this role turn's assigned context; avoid unrelated changes.
- Write every document, log, report, and comment in clear, professional English.
- Your team run ID is: ${opts.runId}
- Your turn ID is: ${opts.turnId}
- Your role ID is: ${opts.role.id}
- Your working directory is the .tiger/ root: ${opts.paths.root}
- Save your deliverable to exactly this file (absolute path):
    ${opts.outputPath}
    (relative to the .tiger root: ${outputRel})
- COMPLETION SIGNAL: when you have completely finished AND your deliverable file is written, your
  FINAL action MUST be to create this marker file and write the single word "done" into it:
    ${opts.markerPath}
    (relative to the .tiger root: ${markerRel})
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

Allowed task directive actions are: claim, complete, block, request_review, needs_work.

Optional sign-off directive block:

\`\`\`SignOffDirective
{
  "roleId": "${opts.role.id}",
  "status": "done",
  "summary": "What this role has verified or why it is blocked."
}
\`\`\`

Allowed sign-off statuses are: done, blocked, pending.

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
