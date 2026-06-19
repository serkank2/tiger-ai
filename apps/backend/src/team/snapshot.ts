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

import type {
  TeamRunState as EngineTeamRunState,
  TeamRoleInstance as EngineRole,
  TeamRoleStatus as EngineRoleStatus,
} from './TeamOrchestrator.js';
import type {
  DoneGateState,
  RoleSnapshot,
  RoleStatus,
  SteeringDirective,
  TeamMessage,
  TeamRunState,
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

function toRoleSnapshot(state: EngineTeamRunState, role: EngineRole): RoleSnapshot {
  return {
    id: role.id,
    name: role.name,
    tool: role.tool,
    status: toRoleStatus(role.status),
    canWriteCode: role.canWriteCode,
    requiredForSignoff: role.requiredForSignoff,
    signedOff: isRoleSignedOff(state, role.id),
    statusNote: role.status === 'blocked' ? role.name : undefined,
    terminalId: role.activeTerminalId,
    turnCount: state.turns.filter((turn) => turn.roleId === role.id).length,
    tasks: role.taskCounts,
  };
}

/** Compute the done-gate snapshot the UI renders as the completion progress bar. */
export function computeDoneGate(state: EngineTeamRunState): DoneGateState {
  const requiredRoleIds = state.roles.filter((role) => role.requiredForSignoff).map((role) => role.id);
  const signedOffRoleIds = requiredRoleIds.filter((id) => isRoleSignedOff(state, id));
  const pendingRoleIds = requiredRoleIds.filter((id) => !signedOffRoleIds.includes(id));
  return {
    satisfied: requiredRoleIds.length > 0 && pendingRoleIds.length === 0,
    requiredRoleIds,
    signedOffRoleIds,
    pendingRoleIds,
    evaluatedAt: state.materialChangeAt,
  };
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
    turnCount: state.turnCount,
    round: state.round,
    message: state.message,
    updatedAt: state.materialChangeAt,
  };
}
