// ---------------------------------------------------------------------------
// Brief composition — the v2 replacement for v1's compose-turn.ts.
//
// v1 rebuilt a ~160k-character prompt EVERY turn (persona + 11 laws + output
// contract + full project prompt + transcript window), even for persistent
// sessions that already held all of it in context. v2 splits the prompt into:
//
//   • a SESSION PREAMBLE — sent once, on the session-opening turn only:
//     who you are, where you work, the goal, the project map, the rules.
//   • a TASK BRIEF — sent every turn: the assignment + ONLY what is new
//     since this session's last turn (the delta), plus failure evidence
//     for fix tasks.
//
// Follow-up prompt size is O(new information), never O(history). The result
// contract is enforced by the CLI itself (--json-schema / --output-schema),
// so the prose only needs to EXPLAIN the fields, not police the format.
// ---------------------------------------------------------------------------

export interface SessionPreambleInput {
  runId: string;
  /** Agent slot name shown in logs/UI (e.g. "builder", "planner", "reviewer"). */
  agentName: string;
  /** The user's goal, verbatim (any language; output language stays English). */
  goal: string;
  /** Absolute working directory the agent runs in (workspace or worktree). */
  workspace: string;
  /** Budgeted project map from buildProjectMap(); empty string to omit. */
  projectMap?: string;
  /** Names of Kaplan MCP tools mounted for this session, when the bus is on. */
  mcpTools?: string[];
}

/** ~2.5k characters — sent once per session, never repeated. */
export function composeSessionPreamble(input: SessionPreambleInput): string {
  const sections = [
    `# KAPLAN SESSION — READ ONCE

You are "${input.agentName}", an autonomous coding agent in a Kaplan run (id ${input.runId}).
No human is available mid-turn: never ask questions or wait for approval — make reasonable
assumptions and proceed. Work in English (code, comments, and reports), regardless of the
goal's language.

Working directory (your boundary): ${input.workspace}
Stay inside it. Make real product changes to the actual source files; run nothing destructive
outside it. Do not invent completion claims: report only what you actually did and observed.
Kaplan runs the project's build/test/lint itself after your turns — you never need to claim a
check passed, and unverified claims are treated as noise.`,
    `## GOAL (source of truth)

<<<GOAL
${input.goal.trim()}
GOAL>>>`,
  ];
  if (input.projectMap?.trim()) {
    sections.push(
      `## PROJECT MAP (orientation — verify with the real tree before relying on it)\n\n${input.projectMap.trim()}`,
    );
  }
  if (input.mcpTools?.length) {
    sections.push(
      `## KAPLAN TOOLS\n\nThe "kaplan" MCP server is mounted with: ${input.mcpTools.join(', ')}. ` +
        `Use it to post progress notes, fetch fresh team messages, or add follow-up tasks mid-turn.`,
    );
  }
  sections.push(
    `## END-OF-TURN CONTRACT

End every turn with a single JSON object (the CLI enforces the schema where supported):
{"status":"done"|"blocked","summary":"what you actually did, with evidence","details":"optional",
"followUpTasks":[{"title":"…","description":"…"}]}
Use "blocked" honestly — a clear blocker beats a fake done.`,
  );
  return sections.join('\n\n') + '\n';
}

export interface TaskBriefInput {
  /** Task headline, e.g. "T3 — Wire the WS fan-out". */
  title: string;
  /** Full task description (self-contained; written by the planner). */
  description: string;
  acceptanceCriteria?: string[];
  /**
   * NEW events since this session last ran (already rendered one-per-line).
   * Empty for the session-opening turn (history is in the preamble's goal) —
   * and for resumed sessions this is the ONLY history ever re-sent.
   */
  deltaLines?: string[];
  /** For fix tasks: the failing check's tail — the exact evidence to act on. */
  verificationFailure?: { command: string; outputTail: string };
  /** User steering to honor this turn, verbatim. */
  steering?: string[];
  /**
   * Recap for providers that cannot resume a session (agy): a compact summary
   * of where the run stands, composed by the engine. Undefined for resumable
   * sessions — they remember.
   */
  recap?: string;
}

export function composeTaskBrief(input: TaskBriefInput): string {
  const parts: string[] = [`# YOUR TASK: ${input.title.trim()}`, input.description.trim()];
  if (input.acceptanceCriteria?.length) {
    parts.push(`## Acceptance criteria\n${input.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`);
  }
  if (input.recap?.trim()) {
    parts.push(`## Where the run stands (recap)\n${input.recap.trim()}`);
  }
  if (input.steering?.length) {
    parts.push(`## User steering (overrides everything else)\n${input.steering.map((s) => `- ${s}`).join('\n')}`);
  }
  if (input.verificationFailure) {
    parts.push(
      `## Failing check (fix exactly this)\n\`${input.verificationFailure.command}\` failed with:\n\n` +
        '```\n' +
        input.verificationFailure.outputTail.trim() +
        '\n```',
    );
  }
  if (input.deltaLines?.length) {
    parts.push(`## New since your last turn\n${input.deltaLines.map((l) => `- ${l}`).join('\n')}`);
  }
  parts.push(`Work the task to completion now, then end with the single JSON result object per your session contract.`);
  return parts.join('\n\n') + '\n';
}
