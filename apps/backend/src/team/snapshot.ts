// ---------------------------------------------------------------------------
// Adapter from the orchestrator's rich, internal run state to the compact
// `team/types.ts` `TeamRunState` the REST/WS layer and the frontend consume.
//
// The engine (`TeamOrchestrator`) keeps a verbose state (turn history, directive
// lifecycle, sign-off staleness, verification records, …) so it can drive the
// run loop. The UI only needs a small, stable snapshot. Keeping this mapping in
// one place means routes and the socket emit byte-identical shapes and the
// frontend never has to know about the engine's internals.
// ---------------------------------------------------------------------------

import {
  TeamOrchestrator,
  computeRunMetrics,
  type TeamRunState as EngineTeamRunState,
  type TeamRoleInstance as EngineRole,
  type TeamRoleStatus as EngineRoleStatus,
} from './TeamOrchestrator.js';
import type {
  DoneGateState,
  HandoffDependencySnapshot,
  RoleSnapshot,
  RoleStatus,
  SteeringDirective,
  TeamAttemptSnapshot,
  TeamMessage,
  TeamRunState,
  TeamSignoffSnapshot,
  TeamTaskWorktreeSnapshot,
  TeamTurnSnapshot,
  TeamVerificationSnapshot,
} from './types.js';

/** Map the engine's coarse role status onto the UI role-status vocabulary. */
function toRoleStatus(status: EngineRoleStatus): RoleStatus {
  switch (status) {
    case 'running':
      return 'working';
    case 'paused':
      return 'waiting';
    case 'interrupted':
      return 'idle';
    case 'idle':
    case 'blocked':
    case 'done':
      return status;
    default:
      return 'idle';
  }
}

/** Derive a short, human display name for a run from its goal. */
function deriveRunName(state: EngineTeamRunState): string {
  const firstLine = state.goal.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  if (!firstLine) return 'Team Run';
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

/** True when a role currently holds a fresh (non-stale) "done" sign-off. */
function isRoleSignedOff(state: EngineTeamRunState, roleId: string): boolean {
  return state.signoffs.some((signoff) => signoff.roleId === roleId && !signoff.stale);
}

export function toRoleSnapshot(state: EngineTeamRunState, role: EngineRole): RoleSnapshot {
  return {
    id: role.id,
    name: role.name,
    tool: role.tool,
    status: toRoleStatus(role.status),
    canWriteCode: role.canWriteCode,
    requiredForSignoff: role.requiredForSignoff,
    signedOff: isRoleSignedOff(state, role.id),
    statusNote: role.statusNote ?? (role.status === 'blocked' ? role.name : undefined),
    terminalId: role.activeTerminalId,
    turnCount: state.turns.filter((turn) => turn.roleId === role.id).length,
    tasks: role.taskCounts,
    inbox: state.inboxes?.[role.id]?.length || undefined,
  };
}

/** Project the engine's handoff dependencies onto the compact UI snapshot shape. */
function toHandoffSnapshots(state: EngineTeamRunState): HandoffDependencySnapshot[] {
  return (state.handoffs ?? []).map((h) => ({
    id: h.id,
    fromRoleId: h.fromRoleId,
    toRoleId: h.toRoleId,
    taskId: h.taskId,
    title: h.title,
    pending: !h.resolvedAt,
    createdAt: h.createdAt,
    resolvedAt: h.resolvedAt,
  }));
}

/** Project the engine's per-task worktrees onto the compact UI snapshot shape. */
function toTaskWorktreeSnapshots(state: EngineTeamRunState): TeamTaskWorktreeSnapshot[] {
  return (state.taskWorktrees ?? []).map((w) => ({
    taskId: w.taskId,
    roleId: w.roleId,
    branch: w.branch,
    status: w.status,
    summary: w.summary ?? null,
    note: w.note,
    createdAt: w.createdAt,
    mergedAt: w.mergedAt,
  }));
}

/**
 * Compute the done-gate snapshot the UI renders. This is the AUTHORITATIVE full completion
 * gate (every required role signed off AND verification passed AND no pending steering AND
 * task/finding queues clear AND the per-role board clear AND no open blockers), with the exact
 * list of open blockers — delegated to {@link TeamOrchestrator.computeDoneGate} so the snapshot
 * and the run loop agree on a single definition of "done".
 */
export function computeDoneGate(state: EngineTeamRunState): DoneGateState {
  return TeamOrchestrator.computeDoneGate(state);
}

function toTurnSnapshot(turn: EngineTeamRunState['turns'][number], role: EngineRole | undefined): TeamTurnSnapshot {
  const start = Date.parse(turn.startedAt);
  const end = turn.endedAt ? Date.parse(turn.endedAt) : NaN;
  const durationMs = Number.isNaN(start) || Number.isNaN(end) ? undefined : Math.max(0, end - start);
  return {
    id: turn.id,
    roleId: turn.roleId,
    roleName: turn.roleName,
    status: turn.status,
    round: turn.round,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    reason: turn.reason,
    terminalId: turn.terminalId,
    provider: role?.tool,
    durationMs,
  };
}

function toVerificationSnapshot(v: EngineTeamRunState['verifications'][number]): TeamVerificationSnapshot {
  return {
    id: v.id,
    roleId: v.roleId,
    status: v.status,
    command: v.command,
    exitCode: v.exitCode,
    summary: v.summary,
    createdAt: v.createdAt,
    completedAt: v.completedAt,
  };
}

function toSignoffSnapshot(s: EngineTeamRunState['signoffs'][number]): TeamSignoffSnapshot {
  return {
    id: s.id,
    roleId: s.roleId,
    roleName: s.roleName,
    createdAt: s.createdAt,
    stale: s.stale,
    staleReason: s.staleReason,
  };
}

/** Project the engine's attempts onto the compact UI snapshot shape. */
function toAttemptSnapshots(state: EngineTeamRunState): TeamAttemptSnapshot[] {
  const attempts = state.attempts ?? [];
  const currentId = state.currentAttemptId ?? null;
  return attempts.map((attempt) => ({
    id: attempt.id,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    branch: attempt.branch,
    baseRef: attempt.baseRef,
    summary: attempt.summary,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    promotedAt: attempt.promotedAt,
    current: attempt.id === currentId,
    promoted: attempt.status === 'promoted',
  }));
}

function toPendingSteering(state: EngineTeamRunState): SteeringDirective[] {
  return state.directives
    .filter((directive) => directive.status === 'pending')
    .map((directive) => ({
      id: directive.id,
      runId: state.runId,
      body: directive.body,
      createdAt: directive.createdAt,
      acknowledged: false,
    }));
}

/**
 * Project the engine's rich run state onto the compact {@link TeamRunState} the
 * UI consumes. `recentMessages` is the conversation tail to seed the chat panel;
 * pass `[]` for live `team.state` pushes (messages ride the `team.message` event).
 */
export function toTeamRunStateDto(
  state: EngineTeamRunState,
  recentMessages: TeamMessage[] = [],
): TeamRunState {
  return {
    id: state.runId,
    name: deriveRunName(state),
    goal: state.goal,
    status: state.status,
    roles: state.roles.map((role) => toRoleSnapshot(state, role)),
    doneGate: computeDoneGate(state),
    messageCount: state.messageCount,
    recentMessages,
    pendingSteering: toPendingSteering(state),
    tasks: state.tasks,
    findings: state.findings,
    turns: state.turns.map((turn) => toTurnSnapshot(turn, state.roles.find((role) => role.id === turn.roleId))),
    verifications: state.verifications.map(toVerificationSnapshot),
    signoffs: state.signoffs.map(toSignoffSnapshot),
    metrics: computeRunMetrics(state),
    attempts: toAttemptSnapshots(state),
    currentAttemptId: state.currentAttemptId ?? null,
    promotedAttemptId: state.promotedAttemptId ?? null,
    handoffs: toHandoffSnapshots(state),
    taskWorktrees: toTaskWorktreeSnapshots(state),
    turnCount: state.turnCount,
    round: state.round,
    message: state.message,
    closed: state.closed,
    updatedAt: state.materialChangeAt,
  };
}
