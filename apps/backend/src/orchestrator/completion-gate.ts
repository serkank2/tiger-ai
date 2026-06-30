import { promises as fs } from 'node:fs';
import type { StageId } from './types.js';
import { STAGE_META, type TigerPaths } from './paths.js';
import { STAGE_ORDER } from './types.js';
import { parseExecutionResult } from './tasks.js';
import { parseFixResult, parseReviewResult } from './findings.js';

// ---------------------------------------------------------------------------
// Semantic completion gate.
//
// Some stages require the agent to emit a structured self-report token in its
// output before its work may be accepted. A finished CLI run (marker/idle/exit)
// is necessary but NOT sufficient: an agent that never wrote `EXECUTION_RESULT`
// (execute) or `FIX_RESULT` (fix) has not actually reported its result, so the
// orchestrator must treat the work as `blocked` rather than silently `done`.
// ---------------------------------------------------------------------------

/** The kind of self-report a stage/agent run requires (none = no semantic gate). */
export type SelfReportKind = 'execution' | 'fix' | 'review' | null;

/**
 * Which self-report token each stage's agents must emit. Execution (Stage 5) requires
 * `EXECUTION_RESULT`; the task-review FIX phase requires `FIX_RESULT`; the task-review FIND phase
 * requires `REVIEW_RESULT` (so a crashed/timed-out review that emitted zero findings is treated as
 * needs-attention, not silently `approved`). Every other stage produces a free-form deliverable, so
 * it has no semantic gate.
 *
 * The fix/find phases are not distinct StageIds (they share `task-review`), so callers pass the
 * review phase explicitly via {@link requiredSelfReport}.
 */
const STAGE_SELF_REPORT: Partial<Record<StageId, SelfReportKind>> = {
  'executing-plan': 'execution',
};

/** The self-report kind required for a given stage (and, for task-review, phase). */
export function requiredSelfReport(stage: StageId, reviewPhase?: 'find' | 'fix'): SelfReportKind {
  if (stage === 'task-review') return reviewPhase === 'fix' ? 'fix' : reviewPhase === 'find' ? 'review' : null;
  return STAGE_SELF_REPORT[stage] ?? null;
}

export interface CompletionGateResult {
  /** True when the run may be accepted as truly complete. */
  ok: boolean;
  /** When blocked, a short English reason suitable for a run/task message. */
  reason?: string;
}

/**
 * Decide whether a finished agent run satisfies its stage's semantic completion gate.
 * `runCompleted` is whether the CLI run itself finished cleanly (state === 'completed').
 * `output` is the agent's deliverable/output text. Returns ok=false (blocked) when the
 * run completed but the required self-report token is absent or unparseable.
 */
export function evaluateCompletionGate(
  kind: SelfReportKind,
  runCompleted: boolean,
  output: string,
): CompletionGateResult {
  if (!runCompleted) return { ok: false, reason: 'agent run did not complete' };
  if (kind === null) return { ok: true };
  if (kind === 'execution') {
    const reported = parseExecutionResult(output);
    if (!reported) {
      return { ok: false, reason: 'agent did not emit an EXECUTION_RESULT self-report; treating as blocked' };
    }
    if (reported.status === 'blocked') {
      return {
        ok: false,
        reason: reported.reason ? `agent reported blocked: ${reported.reason}` : 'agent reported blocked',
      };
    }
    return { ok: true };
  }
  if (kind === 'review') {
    // FIND phase: the review must explicitly declare its outcome. An absent REVIEW_RESULT means the
    // agent crashed/timed-out or produced malformed output — its partition cannot be trusted as clean.
    const reported = parseReviewResult(output);
    if (!reported) {
      return {
        ok: false,
        reason: 'review agent did not emit a REVIEW_RESULT self-report; treating its partition as needs-attention',
      };
    }
    return { ok: true };
  }
  // kind === 'fix'
  const reported = parseFixResult(output);
  if (!reported) {
    return { ok: false, reason: 'agent did not emit a FIX_RESULT self-report; treating as unresolved' };
  }
  if (reported.status === 'wontfix') {
    return {
      ok: false,
      reason: reported.reason ? `agent reported wontfix: ${reported.reason}` : 'agent reported wontfix',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Upstream-artifact validation (gate auto-advance / Run-All from a mid stage).
//
// Before auto-advancing into a stage — or starting an auto-run from a stage that
// is not the first — verify the artifacts that stage consumes actually exist and
// are non-empty. Otherwise an empty/missing upstream output silently produces a
// degenerate run.
// ---------------------------------------------------------------------------

async function fileHasContent(file: string): Promise<boolean> {
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile() || st.size === 0) return false;
  const content = await fs.readFile(file, 'utf8').catch(() => '');
  return content.trim().length > 0;
}

/** True when a context directory holds at least one non-empty top-level *.md output. */
async function dirHasOutput(dir: string): Promise<boolean> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (name.startsWith('.') || !name.toLowerCase().endsWith('.md')) continue;
    if (await fileHasContent(`${dir}/${name}`)) return true;
  }
  return false;
}

export interface UpstreamCheck {
  ok: boolean;
  /** When not ok, a clear English reason naming the missing artifact. */
  reason?: string;
}

/**
 * Verify the upstream artifacts a stage needs are present and non-empty before it runs without
 * a human in the loop (auto-advance or Run-All from a mid stage). The first stage has no upstream
 * dependency. Execution and task-review consume the merged task list; the standard fan-out stages
 * consume their declared context directories.
 */
export async function checkUpstreamArtifacts(paths: TigerPaths, stage: StageId): Promise<UpstreamCheck> {
  if (STAGE_ORDER.indexOf(stage) <= 0) return { ok: true };

  if (stage === 'executing-plan' || stage === 'task-review') {
    if (await fileHasContent(paths.mergedTasksFile)) return { ok: true };
    // The merged file may already be split into per-task files.
    if (await dirHasOutput(paths.tasksDir)) return { ok: true };
    return {
      ok: false,
      reason: `cannot start ${STAGE_META[stage].title}: the merged task list (${paths.rel(paths.mergedTasksFile)}) is missing or empty — run the Merge Tasks stage first`,
    };
  }

  const meta = STAGE_META[stage];
  for (const dir of meta.contextDirs) {
    if (!(await dirHasOutput(paths.dirByName(dir)))) {
      return {
        ok: false,
        reason: `cannot start ${meta.title}: required upstream output in ${dir}/ is missing or empty`,
      };
    }
  }
  return { ok: true };
}
