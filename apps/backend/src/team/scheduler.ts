export type TeamRoleKind = 'lead' | 'coordinator' | 'analyst' | 'developer' | 'tester' | 'reviewer' | 'signoff';

export type TeamPhase = 'manager' | 'analysis' | 'implementation' | 'testing' | 'review' | 'signoff';

export type TeamRunStatus = 'running' | 'done' | 'blocked';

export interface TeamRole {
  id: string;
  kind: TeamRoleKind;
  label?: string;
  /**
   * Defaults to true for developers and false for all other built-in roles.
   * A write-capable turn is always serialized.
   */
  writeCapable?: boolean;
  order?: number;
}

export interface ActiveTeamTurn {
  id: string;
  roleId: string;
  phase: TeamPhase;
}

export interface SteeringDirective {
  id: string;
  status?: 'pending' | 'drained' | 'dismissed';
}

export interface TeamTaskState {
  needsAnalysis?: number;
  needsImplementation?: number;
  needsTesting?: number;
  needsReview?: number;
  readyForSignoff?: number;
}

export interface TeamFindingState {
  open?: number;
  needsFix?: number;
  needsVerification?: number;
}

export interface CoordinatorPolicyDecision {
  roleIds?: string[];
  phase?: TeamPhase;
  reason?: string;
}

export interface DoneGateState {
  ready?: boolean;
  terminal?: boolean;
  blocked?: boolean;
  reason?: string;
}

export interface TeamSchedulerState {
  roles: TeamRole[];
  status?: TeamRunStatus;
  phase?: TeamPhase;
  activeTurns?: ActiveTeamTurn[];
  pendingDirectives?: SteeringDirective[];
  coordinatorDecision?: CoordinatorPolicyDecision | null;
  tasks?: TeamTaskState;
  findings?: TeamFindingState;
  doneGate?: DoneGateState;
  currentRound: number;
  maxRounds: number;
  maxConcurrentReadOnly?: number;
}

export interface SelectedTeamTurn {
  roleId: string;
  role: TeamRole;
  phase: TeamPhase;
  writeCapable: boolean;
  reason: string;
}

export interface TeamSchedulerBoundary {
  atBoundary: boolean;
  drainSteeringBeforeNextTurn: boolean;
  checkDoneGate: boolean;
}

export interface TeamSchedulerTerminal {
  status: Exclude<TeamRunStatus, 'running'>;
  reason: string;
}

export interface TeamSchedulerDecision {
  turns: SelectedTeamTurn[];
  phase: TeamPhase | null;
  boundary: TeamSchedulerBoundary;
  terminal?: TeamSchedulerTerminal;
  reason: string;
}

const PHASE_ROLE_KINDS: Record<TeamPhase, TeamRoleKind[]> = {
  manager: ['lead', 'coordinator'],
  analysis: ['analyst'],
  implementation: ['developer'],
  testing: ['tester'],
  review: ['reviewer'],
  signoff: ['signoff', 'lead', 'coordinator'],
};

const DEFAULT_READ_ONLY_CONCURRENCY = 2;

export function selectNextTurns(state: TeamSchedulerState): TeamSchedulerDecision {
  const status = state.status ?? 'running';
  const baseBoundary = boundary(false, false, false);

  if (status === 'done' || status === 'blocked') {
    return {
      turns: [],
      phase: null,
      boundary: baseBoundary,
      terminal: { status, reason: `team run is ${status}` },
      reason: 'terminal state',
    };
  }

  const activeTurns = state.activeTurns ?? [];
  if (activeTurns.length > 0) {
    return {
      turns: [],
      phase: state.phase ?? null,
      boundary: baseBoundary,
      reason: 'waiting for active turn boundary',
    };
  }

  const chosenPhase = choosePhase(state);
  const shouldCheckDoneGate = isDoneGateBoundary(state, chosenPhase);
  const pendingDirectives = pendingSteering(state.pendingDirectives);
  if (pendingDirectives.length > 0) {
    return {
      turns: [],
      phase: chosenPhase,
      boundary: boundary(true, true, false),
      reason: 'pending steering must drain before the next turn',
    };
  }

  if (state.doneGate?.terminal || state.doneGate?.blocked) {
    const terminalStatus = state.doneGate.blocked ? 'blocked' : 'done';
    return {
      turns: [],
      phase: chosenPhase,
      boundary: boundary(true, false, shouldCheckDoneGate),
      terminal: { status: terminalStatus, reason: state.doneGate.reason ?? `done gate is ${terminalStatus}` },
      reason: 'done gate reached terminal state',
    };
  }

  if (state.currentRound >= state.maxRounds) {
    return {
      turns: [],
      phase: chosenPhase,
      boundary: boundary(true, false, shouldCheckDoneGate),
      terminal: { status: 'blocked', reason: `round cap reached (${state.currentRound}/${state.maxRounds})` },
      reason: 'round cap reached',
    };
  }

  const candidates = chooseCandidates(state, chosenPhase);
  const turns = serializeCandidates(state, chosenPhase, candidates);

  return {
    turns,
    phase: chosenPhase,
    boundary: boundary(true, false, shouldCheckDoneGate),
    reason: turns.length > 0 ? selectionReason(state) : `no available role for ${chosenPhase}`,
  };
}

function choosePhase(state: TeamSchedulerState): TeamPhase {
  if (state.coordinatorDecision?.phase) return state.coordinatorDecision.phase;
  if (state.phase) return state.phase;
  return fallbackPhase(state.tasks, state.findings, state.doneGate);
}

function fallbackPhase(tasks: TeamTaskState | undefined, findings: TeamFindingState | undefined, doneGate: DoneGateState | undefined): TeamPhase {
  if ((findings?.needsFix ?? 0) > 0 || (findings?.open ?? 0) > 0) return 'implementation';
  if ((findings?.needsVerification ?? 0) > 0) return 'testing';
  if ((tasks?.needsAnalysis ?? 0) > 0) return 'analysis';
  if ((tasks?.needsImplementation ?? 0) > 0) return 'implementation';
  if ((tasks?.needsTesting ?? 0) > 0) return 'testing';
  if ((tasks?.needsReview ?? 0) > 0) return 'review';
  if ((tasks?.readyForSignoff ?? 0) > 0 || doneGate?.ready) return 'signoff';
  return 'manager';
}

function chooseCandidates(state: TeamSchedulerState, phase: TeamPhase): TeamRole[] {
  const roles = sortedRoles(state.roles);
  const decisionIds = state.coordinatorDecision?.roleIds?.filter((id) => id.trim().length > 0) ?? [];
  if (decisionIds.length > 0) {
    const wanted = new Set(decisionIds);
    return roles.filter((role) => wanted.has(role.id));
  }

  return PHASE_ROLE_KINDS[phase].flatMap((kind) => roles.filter((role) => role.kind === kind));
}

function serializeCandidates(state: TeamSchedulerState, phase: TeamPhase, candidates: TeamRole[]): SelectedTeamTurn[] {
  const writeRole = candidates.find(isWriteCapable);
  if (writeRole) return [toTurn(writeRole, phase, state, true)];

  const limit = readOnlyLimit(state, phase);
  return candidates.slice(0, limit).map((role) => toTurn(role, phase, state, false));
}

function toTurn(role: TeamRole, phase: TeamPhase, state: TeamSchedulerState, writeCapable: boolean): SelectedTeamTurn {
  return {
    roleId: role.id,
    role,
    phase,
    writeCapable,
    reason: selectionReason(state),
  };
}

function selectionReason(state: TeamSchedulerState): string {
  return state.coordinatorDecision?.roleIds?.length || state.coordinatorDecision?.phase
    ? state.coordinatorDecision.reason ?? 'coordinator policy decision'
    : 'deterministic phase fallback';
}

function readOnlyLimit(state: TeamSchedulerState, phase: TeamPhase): number {
  if (phase === 'manager' || phase === 'signoff') return 1;
  return Math.max(1, state.maxConcurrentReadOnly ?? DEFAULT_READ_ONLY_CONCURRENCY);
}

function pendingSteering(directives: SteeringDirective[] | undefined): SteeringDirective[] {
  return (directives ?? []).filter((directive) => (directive.status ?? 'pending') === 'pending');
}

function isDoneGateBoundary(state: TeamSchedulerState, phase: TeamPhase): boolean {
  return Boolean(state.doneGate?.ready || phase === 'signoff');
}

function isWriteCapable(role: TeamRole): boolean {
  return role.writeCapable ?? role.kind === 'developer';
}

function sortedRoles(roles: TeamRole[]): TeamRole[] {
  return roles
    .map((role, index) => ({ role, index }))
    .sort((a, b) => {
      const order = (a.role.order ?? a.index) - (b.role.order ?? b.index);
      if (order !== 0) return order;
      return a.role.id.localeCompare(b.role.id);
    })
    .map((entry) => entry.role);
}

function boundary(atBoundary: boolean, drainSteeringBeforeNextTurn: boolean, checkDoneGate: boolean): TeamSchedulerBoundary {
  return { atBoundary, drainSteeringBeforeNextTurn, checkDoneGate };
}
