// ---------------------------------------------------------------------------
// Pure completion / done-gate evaluator and runaway guards for AI Team runs.
//
// The user's requirement — the system stops only when it is "100% sure" every
// agent agrees all the work is truly done — must be objective and code-enforced,
// never a free-form agent claim. This module is a PURE function over a supplied
// snapshot of team state: it performs no I/O and reads no clock, so the gate is
// unit-testable before any agent ever runs and cannot drift with side effects.
// It returns the EXACT blocking reason(s) rather than a bare boolean.
//
// A companion pure guard evaluator bounds runaway loops and cost, mapping each
// tripped ceiling to an explicit terminal outcome (blocked/failed/limit_blocked).
//
// Scope boundary (TASK-005): this module only EVALUATES supplied state. Producing
// that state — running verification, scheduling turns, persistence — belongs to
// other modules (TASK-002 / TASK-007 / TASK-008 / TASK-009).
// ---------------------------------------------------------------------------

import type { FindingsSummary, TaskSummary } from '../orchestrator/types.js';
import type {
  DoneGateState,
  RoleInstance,
  SignOff,
  SteeringDirective,
  VerificationRecord,
} from './types.js';

// ---------------------------------------------------------------------------
// Done-gate input contract.
//
// The orchestrator (TASK-008) assembles this focused snapshot from its richer
// run state. It reuses the authoritative domain types so the gate stays in step
// with how roles, sign-offs, verification, and steering are actually modeled,
// while task/finding progress reuses the orchestrator's existing summaries.
// ---------------------------------------------------------------------------

export interface CompletionInput {
  /** Reused orchestrator task board summary (null = no task board yet). */
  tasks: TaskSummary | null;
  /** Reused orchestrator review-findings summary (null = no findings yet). */
  findings: FindingsSummary | null;
  /** All verification records for the run; the latest by `createdAt` is authoritative. */
  verifications: VerificationRecord[];
  /** All steering directives for the run; any unacknowledged one blocks completion. */
  steering: SteeringDirective[];
  /** The live role instances in the run. */
  roles: RoleInstance[];
  /** All sign-off records for the run; the latest per role determines its stance. */
  signoffs: SignOff[];
  /**
   * ISO-8601 timestamp of the last material change to the task board, if known.
   * Supplied whenever the orchestrator mutates task state so that a task change
   * after a sign-off correctly stales that sign-off.
   */
  tasksUpdatedAt?: string;
  /** ISO-8601 timestamp of the last material change to the findings queue, if known. */
  findingsUpdatedAt?: string;
}

/** Machine-readable identifier for each gate that can hold a run open. */
export type CompletionBlockerCode =
  | 'tasks_blocked'
  | 'tasks_incomplete'
  | 'findings_open'
  | 'verification_missing'
  | 'verification_failed'
  | 'steering_pending'
  | 'no_signoff_roles'
  | 'signoff_missing'
  | 'signoff_stale';

/** A single open gate, with a clear English explanation. */
export interface CompletionBlocker {
  code: CompletionBlockerCode;
  message: string;
}

/** The result of evaluating the done-gate. `complete` is true iff `blockers` is empty. */
export interface CompletionResult {
  complete: boolean;
  /** Every open gate, in a stable evaluation order. Empty iff `complete`. */
  blockers: CompletionBlocker[];
  /**
   * The latest material-change instant (max over task/finding/verification/
   * steering timestamps) as ISO-8601, or null when no timestamps were supplied.
   * A required role's sign-off must be dated strictly after this instant.
   */
  latestMaterialChangeAt: string | null;
  /** Role ids whose fresh sign-off is required for completion. */
  requiredRoleIds: string[];
  /** Required role ids that currently hold a fresh ("done") sign-off. */
  freshSignoffRoleIds: string[];
  /** Required role ids still missing a fresh sign-off (missing or stale). */
  pendingRoleIds: string[];
}

/**
 * Evaluate the completion / done-gate over a snapshot of team state.
 *
 * The gate is satisfied (and only then is the run "done") when ALL of the
 * following hold:
 *  - no actionable task is blocked, not-started, or in-progress;
 *  - no review finding is open or being fixed;
 *  - the latest recorded verification passed;
 *  - no steering directive is pending/unacknowledged;
 *  - at least one role is required for sign-off, and every such role holds a
 *    "done" sign-off dated strictly after the latest material change.
 *
 * Any failing condition is reported as a specific blocker; a lone role declaring
 * itself done can never satisfy the gate while another condition fails.
 */
export function evaluateCompletion(input: CompletionInput): CompletionResult {
  const blockers: CompletionBlocker[] = [];

  // --- Gate 1: actionable tasks must all be done ------------------------------
  if (input.tasks) {
    const { blocked, not_started: notStarted, in_progress: inProgress } = input.tasks.byExecution;
    if (blocked > 0) {
      const ids = input.tasks.items.filter((t) => t.executionStatus === 'blocked').map((t) => t.id);
      blockers.push({
        code: 'tasks_blocked',
        message: `${blocked} task(s) are blocked and must be resolved: ${idList(ids)}.`,
      });
    }
    if (notStarted + inProgress > 0) {
      const ids = input.tasks.items
        .filter((t) => t.executionStatus === 'not_started' || t.executionStatus === 'in_progress')
        .map((t) => t.id);
      blockers.push({
        code: 'tasks_incomplete',
        message: `${notStarted + inProgress} task(s) are not yet done: ${idList(ids)}.`,
      });
    }
  }

  // --- Gate 2: no open or in-flight review findings ---------------------------
  if (input.findings && (input.findings.open > 0 || input.findings.fixing > 0)) {
    blockers.push({
      code: 'findings_open',
      message: `${input.findings.open} open and ${input.findings.fixing} in-progress review finding(s) must be resolved before completion.`,
    });
  }

  // --- Gate 3: the latest verification must have passed ------------------------
  const latestVerification = latestByTime(input.verifications, (v) => v.createdAt);
  if (!latestVerification) {
    blockers.push({
      code: 'verification_missing',
      message:
        'No verification has been recorded; the team cannot confirm the work actually builds and passes its checks.',
    });
  } else if (latestVerification.outcome !== 'passed') {
    const phrase = latestVerification.outcome === 'failed' ? 'failed' : 'was inconclusive';
    blockers.push({
      code: 'verification_failed',
      message: `The latest verification ("${latestVerification.subject}") ${phrase}; objective checks must pass before completion.`,
    });
  }

  // --- Gate 4: no pending / unacknowledged steering ---------------------------
  const pendingSteering = input.steering.filter((s) => !s.acknowledged);
  if (pendingSteering.length > 0) {
    blockers.push({
      code: 'steering_pending',
      message: `${pendingSteering.length} steering directive(s) are pending acknowledgement: ${idList(
        pendingSteering.map((s) => s.id),
      )}.`,
    });
  }

  // --- Gate 5: every required role holds a fresh sign-off ----------------------
  const latestMaterialChange = computeLatestMaterialChange(input);
  const requiredRoles = input.roles.filter((r) => r.requiredForSignoff);
  const requiredRoleIds = requiredRoles.map((r) => r.id);
  const freshSignoffRoleIds: string[] = [];
  const pendingRoleIds: string[] = [];

  if (requiredRoles.length === 0) {
    blockers.push({
      code: 'no_signoff_roles',
      message:
        'No role is marked required-for-sign-off; completion requires at least one accountable role to sign off.',
    });
  } else {
    for (const role of requiredRoles) {
      const label = role.name || role.id;
      const signoff = latestDoneSignoff(input.signoffs, role.id);
      if (!signoff) {
        pendingRoleIds.push(role.id);
        blockers.push({
          code: 'signoff_missing',
          message: `Required role "${label}" has not signed off that its work is done.`,
        });
        continue;
      }
      if (!isAfter(signoff.createdAt, latestMaterialChange)) {
        pendingRoleIds.push(role.id);
        blockers.push({
          code: 'signoff_stale',
          message: `Required role "${label}" signed off before the latest material change; the sign-off is stale and must be renewed.`,
        });
        continue;
      }
      freshSignoffRoleIds.push(role.id);
    }
  }

  return {
    complete: blockers.length === 0,
    blockers,
    latestMaterialChangeAt: latestMaterialChange === null ? null : new Date(latestMaterialChange).toISOString(),
    requiredRoleIds,
    freshSignoffRoleIds,
    pendingRoleIds,
  };
}

/**
 * Build the authoritative `DoneGateState` snapshot from a completion result.
 * `satisfied` reflects the sign-off gate specifically (every required role has a
 * fresh sign-off), matching the `DoneGateState` contract. The caller supplies
 * `evaluatedAt` so this helper stays pure.
 */
export function toDoneGateState(result: CompletionResult, evaluatedAt?: string): DoneGateState {
  return {
    satisfied: result.requiredRoleIds.length > 0 && result.pendingRoleIds.length === 0,
    requiredRoleIds: result.requiredRoleIds,
    signedOffRoleIds: result.freshSignoffRoleIds,
    pendingRoleIds: result.pendingRoleIds,
    evaluatedAt,
  };
}

// ---------------------------------------------------------------------------
// Runaway guards: bound turns, rounds, stalls, corrections, time, and budget.
// ---------------------------------------------------------------------------

/** Terminal classification produced by a tripped guard (`ok` = nothing tripped). */
export type GuardOutcome = 'ok' | 'blocked' | 'failed' | 'limit_blocked';

/** Machine-readable identifier for each runaway guard. */
export type GuardBreachCode =
  | 'max_turns'
  | 'max_rounds'
  | 'max_no_progress_rounds'
  | 'max_correction_cycles'
  | 'time_budget'
  | 'token_budget'
  | 'provider_limit';

/** One tripped ceiling, with its terminal outcome and a clear English reason. */
export interface GuardBreach {
  code: GuardBreachCode;
  outcome: Exclude<GuardOutcome, 'ok'>;
  message: string;
}

/**
 * Run ceilings. Count ceilings (turns/rounds/no-progress) and the time/budget
 * ceilings are DISABLED when omitted or <= 0. The correction-cycle ceiling
 * mirrors `execution.maxCorrectionCycles`: it is enforced whenever >= 0 (0 means
 * "no correction cycles permitted"), matching the existing orchestrator, and is
 * disabled only when set to a negative number.
 */
export interface GuardLimits {
  maxTurns?: number;
  maxRounds?: number;
  maxNoProgressRounds?: number;
  maxCorrectionCycles: number;
  /** Wall-clock ceiling in milliseconds. */
  maxDurationMs?: number;
  /** Token/cost budget ceiling (same unit as `GuardCounters.budgetSpent`). */
  maxBudget?: number;
}

/** Caller-maintained accounting for the active run. */
export interface GuardCounters {
  /** Total role turns executed so far. */
  turns: number;
  /** Coordination rounds executed so far. */
  rounds: number;
  /** Consecutive rounds with no forward progress (stall / oscillation detector). */
  noProgressRounds: number;
  /** Correction cycles consumed so far. */
  correctionCycles: number;
  /** Wall-clock elapsed since the run started, in milliseconds (caller computes `now - startedAt`). */
  elapsedMs?: number;
  /** Budget consumed so far (same unit as `GuardLimits.maxBudget`). */
  budgetSpent?: number;
  /** True when the provider/CLI reported a hard usage / rate limit. */
  providerLimitHit?: boolean;
}

/** The outcome of evaluating the runaway guards. */
export interface GuardResult {
  /** The decisive outcome — the most severe tripped ceiling, or `ok`. */
  outcome: GuardOutcome;
  /** The decisive breach's reason, or null when nothing tripped. */
  reason: string | null;
  /** The decisive breach's code, or null when nothing tripped. */
  code: GuardBreachCode | null;
  /** Every tripped ceiling, in priority (evaluation) order. */
  breaches: GuardBreach[];
}

/**
 * Evaluate the runaway guards. External limits (provider/budget) are considered
 * first, then time, then turn/round ceilings (a `failed` run that never finished),
 * then exhausted correction cycles and stalls (a `blocked` run needing human help).
 * The first tripped ceiling in that order is the decisive outcome.
 */
export function evaluateGuards(counters: GuardCounters, limits: GuardLimits): GuardResult {
  const breaches: GuardBreach[] = [];

  if (counters.providerLimitHit === true) {
    breaches.push({
      code: 'provider_limit',
      outcome: 'limit_blocked',
      message: 'A provider usage / rate limit was hit; the run cannot continue until the limit resets.',
    });
  }

  if (isCeiling(limits.maxBudget) && (counters.budgetSpent ?? 0) >= limits.maxBudget) {
    breaches.push({
      code: 'token_budget',
      outcome: 'limit_blocked',
      message: `The token/cost budget of ${limits.maxBudget} was reached (spent ${counters.budgetSpent ?? 0}).`,
    });
  }

  if (isCeiling(limits.maxDurationMs) && (counters.elapsedMs ?? 0) >= limits.maxDurationMs) {
    breaches.push({
      code: 'time_budget',
      outcome: 'failed',
      message: `The time ceiling of ${limits.maxDurationMs} ms was reached (elapsed ${counters.elapsedMs ?? 0} ms).`,
    });
  }

  if (isCeiling(limits.maxTurns) && counters.turns >= limits.maxTurns) {
    breaches.push({
      code: 'max_turns',
      outcome: 'failed',
      message: `The maximum of ${limits.maxTurns} turns was reached without completion.`,
    });
  }

  if (isCeiling(limits.maxRounds) && counters.rounds >= limits.maxRounds) {
    breaches.push({
      code: 'max_rounds',
      outcome: 'failed',
      message: `The maximum of ${limits.maxRounds} coordination rounds was reached without completion.`,
    });
  }

  // Correction cycles mirror the orchestrator: blocked once the allotment is used.
  if (limits.maxCorrectionCycles >= 0 && counters.correctionCycles >= limits.maxCorrectionCycles) {
    breaches.push({
      code: 'max_correction_cycles',
      outcome: 'blocked',
      message: `The correction-cycle limit (${limits.maxCorrectionCycles}) is exhausted; the remaining issues must be resolved manually.`,
    });
  }

  if (isCeiling(limits.maxNoProgressRounds) && counters.noProgressRounds >= limits.maxNoProgressRounds) {
    breaches.push({
      code: 'max_no_progress_rounds',
      outcome: 'blocked',
      message: `The team made no forward progress for ${counters.noProgressRounds} round(s) (limit ${limits.maxNoProgressRounds}); it appears stalled or oscillating.`,
    });
  }

  const decisive = breaches[0];
  return {
    outcome: decisive ? decisive.outcome : 'ok',
    reason: decisive ? decisive.message : null,
    code: decisive ? decisive.code : null,
    breaches,
  };
}

// ---------------------------------------------------------------------------
// Combined run-gate: done-gate wins when green; otherwise a tripped guard yields
// a terminal outcome; otherwise the run keeps going with the open gates as reason.
// ---------------------------------------------------------------------------

/** Fine-grained gate status (keeps `limit_blocked` distinct from `blocked`). */
export type RunGateStatus = 'completed' | 'running' | 'blocked' | 'failed' | 'limit_blocked';

export interface RunGateEvaluation {
  /** Fine-grained status, including a distinct `limit_blocked`. */
  status: RunGateStatus;
  /** True only when the done-gate is satisfied. */
  complete: boolean;
  /** Human-readable English reason lines explaining the status. */
  reasons: string[];
  completion: CompletionResult;
  guards: GuardResult;
}

/**
 * Decide a run's gate outcome. The done-gate takes precedence: if it is green the
 * run is `completed` even if a guard would otherwise have tripped. Otherwise a
 * tripped guard yields its terminal outcome; otherwise the run is still `running`
 * and the open gates are reported as the reason.
 */
export function evaluateRunGate(
  input: CompletionInput,
  counters: GuardCounters,
  limits: GuardLimits,
): RunGateEvaluation {
  const completion = evaluateCompletion(input);
  const guards = evaluateGuards(counters, limits);

  if (completion.complete) {
    return { status: 'completed', complete: true, reasons: [], completion, guards };
  }
  if (guards.outcome !== 'ok') {
    return {
      status: guards.outcome,
      complete: false,
      reasons: guards.breaches.map((b) => b.message),
      completion,
      guards,
    };
  }
  return {
    status: 'running',
    complete: false,
    reasons: completion.blockers.map((b) => b.message),
    completion,
    guards,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers (pure).
// ---------------------------------------------------------------------------

const MAX_IDS_IN_MESSAGE = 10;

/** Render a bounded, comma-separated id list, summarizing any overflow. */
function idList(ids: string[]): string {
  if (ids.length === 0) return '(none)';
  if (ids.length <= MAX_IDS_IN_MESSAGE) return ids.join(', ');
  const shown = ids.slice(0, MAX_IDS_IN_MESSAGE).join(', ');
  return `${shown}, … (+${ids.length - MAX_IDS_IN_MESSAGE} more)`;
}

/** Parse an ISO-8601 timestamp to epoch ms, or null when missing/unparseable. */
function parseTime(iso: string | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Return the item with the latest `getTime()` timestamp. When no item has a
 * parseable timestamp, fall back to the last item (records are appended in
 * chronological order), or null for an empty list.
 */
function latestByTime<T>(items: T[], getTime: (item: T) => string): T | null {
  let best: T | null = null;
  let bestMs = -Infinity;
  for (const item of items) {
    const ms = parseTime(getTime(item));
    if (ms !== null && ms >= bestMs) {
      best = item;
      bestMs = ms;
    }
  }
  if (best === null && items.length > 0) {
    return items[items.length - 1] ?? null;
  }
  return best;
}

/** The latest "done" sign-off for a role, or null if its current stance is not done. */
function latestDoneSignoff(signoffs: SignOff[], roleId: string): SignOff | null {
  const latest = latestByTime(
    signoffs.filter((s) => s.roleId === roleId),
    (s) => s.createdAt,
  );
  return latest && latest.done ? latest : null;
}

/** The latest material change across tasks, findings, verifications, and steering. */
function computeLatestMaterialChange(input: CompletionInput): number | null {
  let max: number | null = null;
  const consider = (iso: string | undefined): void => {
    const ms = parseTime(iso);
    if (ms !== null && (max === null || ms > max)) max = ms;
  };
  consider(input.tasksUpdatedAt);
  consider(input.findingsUpdatedAt);
  for (const v of input.verifications) consider(v.createdAt);
  for (const s of input.steering) consider(s.createdAt);
  return max;
}

/** True iff the sign-off instant is strictly after the latest material change. */
function isAfter(signoffIso: string, latestMaterialChange: number | null): boolean {
  const signoffMs = parseTime(signoffIso);
  if (signoffMs === null) return false; // an undateable sign-off cannot be proven fresh
  if (latestMaterialChange === null) return true; // nothing changed → any dated sign-off is fresh
  return signoffMs > latestMaterialChange;
}

/** True when a numeric ceiling is set and active (a finite value > 0). */
function isCeiling(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
