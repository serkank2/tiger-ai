import { promises as fs } from 'node:fs';
import type { AgentRun, StageId, StageRunConfig, StageStatus } from './types.js';
import { STAGE_META } from './paths.js';

function now(): string {
  return new Date().toISOString();
}

async function append(file: string, text: string): Promise<void> {
  try {
    await fs.appendFile(file, text, 'utf8');
  } catch {
    /* logging must never break the run */
  }
}

/** Record the start of a stage, including the chosen agent configuration. */
export async function logStageStart(file: string, stage: StageId, cfg: StageRunConfig): Promise<void> {
  const title = STAGE_META[stage].title;
  const lines = [`\n## [${now()}] Stage: ${title} — START`];
  if (STAGE_META[stage].singleAgent) {
    const mergeAgent = cfg.mergeAgent ?? 'claude';
    const mergeModel =
      mergeAgent === 'claude' ? cfg.claudeModel : mergeAgent === 'codex' ? cfg.codexModel : cfg.antigravityModel;
    lines.push(`- Single agent: ${mergeAgent} (model: ${mergeModel || 'default'})`);
  } else {
    const counts = [`${cfg.claudeAgents} claude`, `${cfg.codexAgents} codex`];
    if (cfg.antigravityAgents > 0) counts.push(`${cfg.antigravityAgents} antigravity`);
    lines.push(`- Agents: ${counts.join(', ')}`);
    lines.push(`- Parallel: ${cfg.parallel ? 'yes' : 'no'}`);
  }
  await append(file, lines.join('\n') + '\n');
}

/** Record the outcome of a single agent run. */
export async function logAgentResult(file: string, run: AgentRun): Promise<void> {
  const head = `\n### Agent ${run.label} (${run.type})${run.taskId ? ` — task ${run.taskId}` : ''}`;
  const result =
    run.state === 'completed'
      ? 'SUCCESS'
      : run.state === 'stopped'
        ? 'STOPPED'
        : `FAILED — ${run.error ?? 'unknown reason'}`;
  const lines = [
    head,
    `- Command: \`${run.command}\``,
    `- Output: ${run.outputRel}`,
    `- Started: ${run.startedAt ?? '-'} | Ended: ${run.endedAt ?? '-'}`,
    `- Completion: ${run.completion ?? 'n/a'}${run.exitCode != null ? ` | Exit code: ${run.exitCode}` : ''}`,
    `- Attempts: ${run.attempts}`,
    `- Result: ${result}`,
  ];
  await append(file, lines.join('\n') + '\n');
}

/** Record the end of a stage with a success summary. */
export async function logStageEnd(
  file: string,
  stage: StageId,
  status: StageStatus,
  succeeded: number,
  total: number,
): Promise<void> {
  const title = STAGE_META[stage].title;
  await append(file, `\n## [${now()}] Stage: ${title} — END (${status}) — succeeded ${succeeded}/${total}\n`);
}

/** Free-form note (e.g. retry, stop, continue-despite-failures). */
export async function logNote(file: string, message: string): Promise<void> {
  await append(file, `\n> [${now()}] ${message}\n`);
}
