import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StageId } from './types.js';
import { STAGE_META, TigerPaths } from './paths.js';
import { SYSTEM_PROMPT_BY_STAGE } from './prompt-files.js';

const PER_FILE_CAP = 24_000;
const TOTAL_CONTEXT_CAP = 160_000;

export interface ComposeOptions {
  paths: TigerPaths;
  stage: StageId;
  label: string;
  outputPath: string;
  markerPath: string;
  /** executing-plan only. */
  taskId?: string;
  taskBlock?: string;
  /** task-review only: absolute path of this agent's per-agent review-results file. */
  resultsPath?: string;
  /** task-review only: the task ids assigned to this review agent. */
  reviewTaskIds?: string[];
  /** Optional warning injected when an upstream stage was continued despite failures. */
  warning?: string;
}

/** Background-agent preamble prepended to every composed prompt. */
function preamble(opts: ComposeOptions): string {
  const outputRel = opts.paths.rel(opts.outputPath);
  const markerRel = opts.paths.rel(opts.markerPath);
  return `# AUTOMATION CONTEXT — READ THIS FIRST

You are running as an autonomous background agent inside the **Tiger** multi-agent software-team
pipeline. There is NO human available to answer questions or approve actions during your run.

Rules:
- Do NOT ask any questions and do NOT wait for confirmation. Make reasonable, well-justified
  assumptions and proceed on your own.
- Complete the assigned task to the highest possible quality.
- Work only toward the project goal described below; avoid unrelated changes.
- Every document, log, report, and comment you produce MUST be written in clear, professional English.
- Your agent ID is: ${opts.label}
- Your working directory is the tiger/ root: ${opts.paths.root}
- Save your deliverable to exactly this file (absolute path):
    ${opts.outputPath}
    (relative to the tiger root: ${outputRel})
- COMPLETION SIGNAL: when you have completely finished AND your deliverable file is written, your
  FINAL action MUST be to create this marker file and write the single word "done" into it:
    ${opts.markerPath}
    (relative to the tiger root: ${markerRel})
  The orchestrator watches for this marker to know you are done. Do not create it early.
`;
}

/** Read top-level *.md files in a context directory, with per-file and total size caps. */
async function readContextDir(absDir: string, rootForRel: string, budget: { left: number }): Promise<string> {
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ent.isFile()) continue;
    if (ent.name.startsWith('.')) continue;
    if (!ent.name.toLowerCase().endsWith('.md')) continue;
    if (budget.left <= 0) {
      parts.push(`\n_(Additional context files omitted to respect the size budget.)_`);
      break;
    }
    const abs = path.join(absDir, ent.name);
    let content = await fs.readFile(abs, 'utf8').catch(() => '');
    if (!content.trim()) continue;
    let truncated = false;
    if (content.length > PER_FILE_CAP) {
      content = content.slice(0, PER_FILE_CAP);
      truncated = true;
    }
    if (content.length > budget.left) {
      content = content.slice(0, budget.left);
      truncated = true;
    }
    budget.left -= content.length;
    const rel = path.relative(rootForRel, abs).replace(/\\/g, '/');
    parts.push(`\n#### File: ${rel}\n\n${content}${truncated ? '\n\n_(truncated)_' : ''}`);
  }
  return parts.join('\n');
}

/** Build the full composed prompt written to the agent's prompt file. */
export async function composePrompt(opts: ComposeOptions): Promise<string> {
  const { paths, stage } = opts;
  const meta = STAGE_META[stage];
  const projectPrompt = await fs.readFile(paths.projectPromptFile, 'utf8').catch(() => '');
  const systemPrompt = SYSTEM_PROMPT_BY_STAGE[stage];

  const sections: string[] = [preamble(opts)];

  if (opts.warning) {
    sections.push(`> ⚠ ${opts.warning}`);
  }

  sections.push(`---\n\n# STAGE INSTRUCTIONS\n\n${systemPrompt}`);

  sections.push(
    `---\n\n# ORIGINAL PROJECT PROMPT\n\nThis is the user's original request. Treat it as the ` +
      `source of truth for the project goal. It is preserved verbatim and may be in any language; ` +
      `your own output must still be in English.\n\n<<<PROJECT_PROMPT\n${projectPrompt}\n>>>`,
  );

  if (meta.contextDirs.length) {
    const budget = { left: TOTAL_CONTEXT_CAP };
    const blocks: string[] = [];
    for (const dir of meta.contextDirs) {
      const block = await readContextDir(paths.dirByName(dir), paths.root, budget);
      if (block.trim()) blocks.push(`### Context from: ${dir}/\n${block}`);
    }
    if (blocks.length) {
      sections.push(`---\n\n# CONTEXT FROM PREVIOUS STAGES\n\n${blocks.join('\n\n')}`);
    }
  }

  if (stage === 'task-review' || stage === 'requesting-code-review') {
    sections.push(
      `---\n\n# PROJECT FILES\n\nThe implemented project lives under the tiger/ root ` +
        `(${paths.root}). Inspect the actual project files there directly as needed for your review.`,
    );
  }

  if (stage === 'executing-plan' && opts.taskId) {
    sections.push(
      `---\n\n# YOUR ASSIGNED TASK\n\nYou are assigned EXACTLY ONE task: **${opts.taskId}**. ` +
        `Implement only this task — do not start any other task.\n\n` +
        `The orchestrator owns task status and locking in tiger/merged-tasks/tasks.md and the lock ` +
        `files, so you do NOT need to edit tasks.md yourself. Implement the task inside the tiger/ ` +
        `directory, record what you did in your execution log (your output file), and as the final ` +
        `line of your execution log write one of:\n` +
        `    EXECUTION_RESULT: done\n` +
        `    EXECUTION_RESULT: blocked: <short reason>\n\n` +
        `Task definition:\n\n${opts.taskBlock ?? '(see tiger/merged-tasks/tasks.md)'}`,
    );
  }

  if (stage === 'task-review') {
    const assigned = opts.reviewTaskIds && opts.reviewTaskIds.length
      ? `You are assigned these completed tasks to review: ${opts.reviewTaskIds.join(', ')}. ` +
        `Review only these tasks.\n\n`
      : '';
    const resultsPath = opts.resultsPath ?? path.join(paths.runtimeDir(stage), `${opts.label}.results`);
    sections.push(
      `---\n\n# REVIEW RESULT REPORTING\n\n${assigned}In addition to your review log, write a plain-text ` +
        `results file at this absolute path:\n    ${resultsPath}\n` +
        `For each task you reviewed, add exactly one line in the form:\n` +
        `    <TASK-ID> <approved|needs_fix|fixed>\n` +
        `Example:\n    TASK-003 approved\n    TASK-007 fixed\n` +
        `The orchestrator reads this file to update each task's Review Status in tiger/merged-tasks/tasks.md, ` +
        `so you do not need to edit tasks.md yourself.`,
    );
  }

  return sections.join('\n\n') + '\n';
}
