// Frontend mirror of the backend DTOs + WS protocol (the parts the client uses).

export type TerminalRunState = 'starting' | 'running' | 'exited' | 'failed' | 'stopped';

export interface TerminalStatus {
  id: string;
  state: TerminalRunState;
  pid?: number;
  cols: number;
  rows: number;
  exitCode: number | null;
  signal?: number | null;
  error?: { message: string; code?: string };
  startedAt?: string;
  endedAt?: string;
}

export type ShellKind = 'system-default' | 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'zsh' | 'fish' | 'custom';

export interface ShellSpec {
  kind: ShellKind;
  path?: string;
  args?: string[];
}

export interface TerminalDef {
  id: string;
  name: string;
  groupId: string | null;
  cwd: string;
  initialCommand?: string;
  shell: ShellSpec;
  env?: Record<string, string>;
  autostart?: boolean;
  protected?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What the REST API returns for a terminal: definition + live status + preview. */
export interface TerminalDto extends TerminalDef {
  status: TerminalStatus;
  lastOutput: string;
}

/** Payload for create/update (no server-managed fields). */
export interface TerminalInput {
  name: string;
  groupId: string | null;
  cwd: string;
  initialCommand?: string;
  shell: ShellSpec;
  env?: Record<string, string>;
  autostart?: boolean;
  protected?: boolean;
}

export interface Group {
  id: string;
  name: string;
  color?: string;
}

export interface CommandRoutingSettings {
  appendNewlineByDefault: boolean;
  startTerminalOnSend: boolean;
}

export interface AppSettings {
  theme: string;
  defaultCwd: string;
  defaultShell: ShellSpec;
  commandRouting: CommandRoutingSettings;
}

export type CommandTargetMode = 'selected' | 'group' | 'all';

export type CommandTarget =
  | { mode: 'selected'; termIds: string[] }
  | { mode: 'group'; groupId: string }
  | { mode: 'all' };

// --- Prompt library (mirror of backend apps/backend/src/prompts/types.ts) ---

export interface PromptMeta {
  title?: string;
  description?: string;
  tags?: string[];
  target?: string; // 'all' | 'selected' | `group:<name>`
  run?: boolean;
}
export interface PromptSummary extends PromptMeta {
  path: string;
  size: number;
  mtimeMs: number;
  version: string;
}
export interface PromptFile extends PromptSummary {
  content: string;
  body: string;
}

// --- Tiger orchestrator (mirror of apps/backend/src/orchestrator/types.ts) ---

export type TigerStageId =
  | 'brainstorming'
  | 'writing-plan'
  | 'writing-tasks'
  | 'merge-tasks'
  | 'executing-plan'
  | 'task-review'
  | 'requesting-code-review';

export type TigerAgentType = 'claude' | 'codex' | 'antigravity';
export type AgentRunState =
  | 'pending'
  | 'starting'
  | 'waiting_ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted';
export type TigerStageStatus = 'not_started' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export type TigerExecutionStatus = 'not_started' | 'in_progress' | 'done' | 'blocked';
export type TigerReviewStatus = 'pending' | 'reviewing' | 'approved' | 'needs_fix' | 'fixed';

export interface TigerAgentRun {
  id: string;
  terminalId: string;
  stage: TigerStageId;
  type: TigerAgentType;
  index: number;
  label: string;
  outputPath: string;
  outputRel: string;
  markerPath: string;
  promptPath: string;
  command: string;
  state: AgentRunState;
  completion?: 'marker' | 'idle' | 'exit';
  exitCode?: number | null;
  error?: string;
  taskId?: string;
  startedAt?: string;
  endedAt?: string;
  attempts: number;
}

export interface TigerStageState {
  id: TigerStageId;
  status: TigerStageStatus;
  runs: TigerAgentRun[];
  startedAt?: string;
  endedAt?: string;
  message?: string;
  continued?: boolean;
  config?: TigerStageRunConfig;
}

export interface TigerTaskItem {
  id: string;
  title: string;
  executionStatus: TigerExecutionStatus;
  reviewStatus: TigerReviewStatus;
  assignedAgent: string;
}

export interface TigerTaskSummary {
  total: number;
  byExecution: Record<TigerExecutionStatus, number>;
  byReview: Record<TigerReviewStatus, number>;
  items: TigerTaskItem[];
}

export interface TigerFindingsSummary {
  total: number;
  open: number;
  fixing: number;
  fixed: number;
  wontfix: number;
}

export interface TigerRunTemplate {
  id?: string;
  name: string;
  description?: string;
  fromStage?: TigerStageId;
  builtin?: boolean;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  configs: Partial<Record<TigerStageId, TigerStageRunConfig>>;
}

export type TigerRunTemplatePayload = Pick<TigerRunTemplate, 'name' | 'description' | 'fromStage' | 'configs'>;

export interface TigerProjectInfo {
  path: string;
  tigerRoot: string;
  name: string;
  promptPreview: string;
  initialized: boolean;
  exists: boolean;
  completedStages: number;
  totalStages: number;
  active: boolean;
  updatedAt?: string;
}

export interface TigerState {
  workspace: string | null;
  tigerRoot: string | null;
  initialized: boolean;
  projectPromptPreview: string;
  currentStage: TigerStageId | null;
  busy: boolean;
  stages: Record<TigerStageId, TigerStageState>;
  tasks: TigerTaskSummary | null;
  findings: TigerFindingsSummary | null;
  correctionCycles: number;
  maxCorrectionCycles: number;
  autoAdvance: boolean;
}

export interface TigerCliToolConfig {
  executable: string;
  models?: string[];
  modelFlag: string;
  effortFlag?: string;
  effortConfigKey?: string;
  extraArgs?: string[];
  permissionModes: Record<string, string[]>;
}

export interface TigerStageDefaults {
  claudeAgents: number;
  codexAgents: number;
  antigravityAgents: number;
  claudeModel: string;
  codexModel: string;
  antigravityModel: string;
  claudeEffort: string;
  codexEffort: string;
  antigravityEffort: string;
  claudePermission: string;
  codexPermission: string;
  antigravityPermission: string;
  parallel: boolean;
}

export interface TigerExecutionConfig {
  parallel: boolean;
  locking: boolean;
  maxConcurrent: number;
  lockTtlMs: number;
  maxCorrectionCycles: number;
  deleteTigerOnComplete: boolean;
}

export interface TigerConfig {
  version: number;
  cli: { claude: TigerCliToolConfig; codex: TigerCliToolConfig; antigravity: TigerCliToolConfig };
  defaults: TigerStageDefaults;
  timing: Record<string, number>;
  execution: TigerExecutionConfig;
}

export interface TigerUsageEntry {
  label: string;
  percent: number;
  metric: 'used' | 'left';
  reset: string | null;
  percentUsed: number;
  windowKey: string;
  resetAt: string | null;
  parseConfidence: 'trusted' | 'unknown';
}

export interface TigerUsageProbe {
  type: TigerAgentType;
  ok: boolean;
  entries: TigerUsageEntry[];
  raw: string;
  highlights: string[];
  error?: string;
  checkedAt: string;
}

export interface TigerUsage {
  claude: TigerUsageProbe;
  codex: TigerUsageProbe;
  antigravity: TigerUsageProbe;
}

export interface LimitSnapshot {
  id: string;
  provider: TigerAgentType;
  windowKey: string;
  label: string;
  percentUsed: number | null;
  metricRaw: { percent: number; metric: 'used' | 'left' } | null;
  resetText: string | null;
  resetAt: string | null;
  ok: boolean;
  error?: string;
  rawPanel: string;
  parseConfidence: 'trusted' | 'unknown';
  checkedAt: string;
}

export interface LimitRule {
  id: string;
  provider: TigerAgentType;
  windowKey: string | 'any';
  thresholdPercent: number;
  comparison: 'gte';
  action: 'block';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LimitRuleInput {
  id?: string;
  provider: TigerAgentType;
  windowKey: string;
  thresholdPercent: number;
  enabled: boolean;
}

export interface LimitSelectedWindow {
  provider: TigerAgentType;
  windowKey: string;
  label: string;
  percentUsed: number | null;
  resetAt: string | null;
  parseConfidence: 'trusted' | 'unknown';
  checkedAt: string;
  stale: boolean;
  ok: boolean;
  error?: string;
}

export interface LimitDecision {
  allowed: boolean;
  action: 'allow' | 'block';
  reason: string;
  ruleId?: string;
  selectedWindow?: LimitSelectedWindow;
  resumeAfter: string | null;
  conservative: boolean;
  checkedAt: string;
}

export interface LimitStatus {
  snapshots: LimitSnapshot[];
  latest: LimitSnapshot[];
  providers: Record<
    TigerAgentType,
    { provider: TigerAgentType; latest: LimitSnapshot[]; latestCheckedAt: string | null; ok: boolean; error?: string }
  >;
  rules: LimitRule[];
  decision: LimitDecision;
  staleAfterMs: number;
  updatedAt?: string;
}

export interface TigerStageRunConfig {
  claudeAgents: number;
  codexAgents: number;
  antigravityAgents: number;
  claudeModel: string;
  codexModel: string;
  antigravityModel: string;
  claudeEffort: string;
  codexEffort: string;
  antigravityEffort: string;
  claudePermission: string;
  codexPermission: string;
  antigravityPermission: string;
  parallel: boolean;
  mergeAgent?: TigerAgentType;
}

// --- Team orchestrator (mirror of apps/backend/src/team/types.ts) ---

export type TeamAgentType = TigerAgentType;

export interface RoleAgentConfig {
  tool: TeamAgentType;
  model: string;
  effort: string;
  permission: string;
}

export interface RoleTemplate {
  id: string;
  name: string;
  description: string;
  persona: string;
  responsibilities: string[];
  agent: RoleAgentConfig;
  canWriteCode: boolean;
  requiredForSignoff: boolean;
}

export type RoleStatus = 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done' | 'failed';

export interface RoleInstance {
  id: string;
  templateId?: string;
  name: string;
  description: string;
  persona: string;
  agent: RoleAgentConfig;
  canWriteCode: boolean;
  requiredForSignoff: boolean;
  status: RoleStatus;
  signedOff: boolean;
  statusNote?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface TeamTemplate {
  id: string;
  name: string;
  description: string;
  roles: RoleTemplate[];
  builtin?: boolean;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
}

export type TeamMessageKind =
  | 'chat'
  | 'decision'
  | 'task'
  | 'handoff'
  | 'tool'
  | 'verification'
  | 'finding'
  | 'steering'
  | 'signoff'
  | 'system'
  | 'blocker';

export type MessageSender = string;

export interface MessageRef {
  kind: 'message' | 'file' | 'task' | 'finding' | 'url';
  value: string;
  label?: string;
}

export interface TeamMessage {
  id: string;
  runId: string;
  turnId: string;
  seq: number;
  from: MessageSender;
  to?: string;
  channel?: string;
  kind: TeamMessageKind;
  body: string;
  refs?: MessageRef[];
  createdAt: string;
}

export interface SteeringDirective {
  id: string;
  runId: string;
  body: string;
  target?: string;
  createdAt: string;
  acknowledged: boolean;
}

export interface SignOff {
  runId: string;
  roleId: string;
  done: boolean;
  rationale: string;
  createdAt: string;
}

export type VerificationOutcome = 'passed' | 'failed' | 'inconclusive';

export interface VerificationRecord {
  id: string;
  runId: string;
  roleId: string;
  subject: string;
  outcome: VerificationOutcome;
  details: string;
  refs?: MessageRef[];
  createdAt: string;
}

/** A single open completion gate, with a stable machine code and a human reason. */
export interface DoneGateBlocker {
  /**
   * Machine-readable gate identifier. Known codes: tasks_blocked, tasks_incomplete,
   * findings_open, verification_missing, verification_failed, steering_pending,
   * no_signoff_roles, signoff_missing, signoff_stale, board_pending.
   */
  code: string;
  message: string;
}

export interface DoneGateState {
  /** True iff the FULL completion gate is satisfied — i.e. `openBlockers` is empty. */
  satisfied: boolean;
  requiredRoleIds: string[];
  signedOffRoleIds: string[];
  pendingRoleIds: string[];
  /** Every gate still holding the run open (empty iff `satisfied`). */
  openBlockers?: DoneGateBlocker[];
  evaluatedAt?: string;
}

export type TeamTurnStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface TeamTurn {
  id: string;
  runId: string;
  seq: number;
  roleId: string;
  status: TeamTurnStatus;
  startedAt?: string;
  endedAt?: string;
}

export type TeamRunStatus = 'running' | 'paused' | 'blocked' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export type TeamOrchestrationMode = 'legacy' | 'company';

export interface TeamRun {
  id: string;
  name: string;
  goal: string;
  status: TeamRunStatus;
  roles: RoleInstance[];
  templateId?: string;
  turnSeq: number;
  messageSeq: number;
  doneGate: DoneGateState;
  createdAt: string;
  updatedAt?: string;
  startedAt?: string;
  endedAt?: string;
  message?: string;
}

export interface RoleSnapshot {
  id: string;
  name: string;
  tool: TeamAgentType;
  model: string;
  effort: string;
  permission: string;
  status: RoleStatus;
  canWriteCode: boolean;
  requiredForSignoff: boolean;
  signedOff: boolean;
  statusNote?: string;
  /** Terminal id of this role's most recent turn — open it to watch the live CLI. */
  terminalId?: string;
  /** How many turns this role has taken so far. */
  turnCount?: number;
  /** This role's task-board counts (todo/in-progress/done). */
  tasks?: { todo: number; inProgress: number; done: number };
  /** Messages waiting in this role's inbox (delivered via a `sendMessage` coordination verb). */
  inbox?: number;
}

/** A handoff dependency (CAO `handoff` verb): a blocking sync delegation between two roles. */
export interface HandoffDependencySnapshot {
  id: string;
  fromRoleId: string;
  toRoleId: string;
  taskId: string;
  title: string;
  /** True while still blocking (the target's task is not yet completed). */
  pending: boolean;
  createdAt: string;
  resolvedAt?: string;
}

/** Lifecycle of a per-task git worktree (Part B). */
export type TeamTaskWorktreeStatus = 'active' | 'merged' | 'conflict' | 'failed';

/** A per-task git worktree the team created (or kept un-merged on a conflict). */
export interface TeamTaskWorktreeSnapshot {
  taskId: string;
  roleId: string;
  branch: string;
  status: TeamTaskWorktreeStatus;
  summary?: TeamAttemptSummary | null;
  note?: string;
  createdAt: string;
  mergedAt?: string;
}

export type TeamTurnSnapshotStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'stopped'
  | 'interrupted';

/** A compact per-turn record for the UI snapshot (the run's turn history). */
export interface TeamTurnSnapshot {
  id: string;
  roleId: string;
  roleName: string;
  status: TeamTurnSnapshotStatus;
  round: number;
  startedAt: string;
  endedAt?: string;
  reason?: string;
  terminalId?: string;
  provider?: TeamAgentType;
  durationMs?: number;
}

/** A compact verification record for the UI snapshot. */
export interface TeamVerificationSnapshot {
  id: string;
  roleId?: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  command?: string;
  exitCode?: number;
  summary?: string;
  createdAt: string;
  completedAt?: string;
}

/** A compact sign-off record for the UI snapshot. */
export interface TeamSignoffSnapshot {
  id: string;
  roleId: string;
  roleName: string;
  createdAt: string;
  stale: boolean;
  staleReason?: string;
}

/** Per-role rollup for {@link TeamMetrics}. */
export interface TeamRoleMetrics {
  roleId: string;
  roleName: string;
  provider?: TeamAgentType;
  turnCount: number;
  durationMs: number;
}

/** Per-role and per-run cost/duration metrics for the UI snapshot. */
export interface TeamMetrics {
  durationMs: number;
  turnCount: number;
  perRole: TeamRoleMetrics[];
  /** null today — the CLIs run as interactive PTYs and do not self-report usage. */
  tokens?: number | null;
  cost?: number | null;
}

/** A compact summary of a past run, for the run-history list (newest first). */
export interface TeamRunSummary {
  runId: string;
  name: string;
  goal: string;
  status: TeamRunStatus;
  roleCount: number;
  turnCount: number;
  messageCount: number;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  closed: boolean;
}

export interface TeamRunsResponse {
  runs: TeamRunSummary[];
}

/** Fields a mid-run role reconfigure may change. */
export interface RoleReconfigureInput {
  name?: string;
  persona?: string;
  tool?: TeamAgentType;
  model?: string;
  effort?: string;
  permission?: string;
  responsibilities?: string[];
  canWriteCode?: boolean;
  requiredForSignoff?: boolean;
}

/** Lifecycle of a single attempt (mirrors the backend TeamAttemptStatus). */
export type TeamAttemptStatus = 'running' | 'completed' | 'failed' | 'promoted' | 'superseded';

/** Captured diff summary for an attempt. */
export interface TeamAttemptSummary {
  files: number;
  insertions: number;
  deletions: number;
}

/** A compact per-attempt record for the UI (vibe-kanban Attempt model). */
export interface TeamAttemptSnapshot {
  id: string;
  attemptNumber: number;
  status: TeamAttemptStatus;
  branch: string | null;
  baseRef: string | null;
  summary: TeamAttemptSummary | null;
  startedAt: string;
  completedAt?: string;
  promotedAt?: string;
  current: boolean;
  promoted: boolean;
}

/** GET /api/team/runs/:id/attempts response. */
export interface TeamAttemptsResponse {
  attempts: TeamAttemptSnapshot[];
  currentAttemptId: string | null;
  promotedAttemptId: string | null;
}

export interface TeamRunState {
  id: string;
  name: string;
  goal: string;
  status: TeamRunStatus;
  orchestrationMode?: TeamOrchestrationMode;
  roles: RoleSnapshot[];
  doneGate: DoneGateState;
  messageCount: number;
  recentMessages: TeamMessage[];
  pendingSteering: SteeringDirective[];
  tasks?: TigerTaskSummary | null;
  findings?: TigerFindingsSummary | null;
  /** The run's turn history (compact). */
  turns?: TeamTurnSnapshot[];
  /** The run's verification records (compact). */
  verifications?: TeamVerificationSnapshot[];
  /** The run's sign-off records (compact). */
  signoffs?: TeamSignoffSnapshot[];
  /** Per-role and per-run duration/provider (and token/cost when available) metrics. */
  metrics?: TeamMetrics;
  /** The run's recorded attempts (vibe-kanban Attempt model), oldest first. */
  attempts?: TeamAttemptSnapshot[];
  /** The currently-active attempt id, if any. */
  currentAttemptId?: string | null;
  /** The promoted attempt id, if one has been promoted into the base branch. */
  promotedAttemptId?: string | null;
  /** Open + resolved handoff dependencies (CAO `handoff` verb). */
  handoffs?: HandoffDependencySnapshot[];
  /** Per-task git worktree branches (Part B); un-merged ones can be merged/cleaned from the UI. */
  taskWorktrees?: TeamTaskWorktreeSnapshot[];
  turnCount?: number;
  round?: number;
  /** Human-readable status/intent line (e.g. a waiting reason when the Lead has idled). */
  message?: string;
  /**
   * True once the run was Closed: its persistent CLI sessions were killed, so it cannot
   * resume (Stop is the resumable halt). The UI hides Resume/Close once this is set.
   */
  closed?: boolean;
  updatedAt?: string;
}

export type TeamState = TeamRunState;

export type TeamChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'unknown';

export interface TeamChangeFile {
  path: string;
  status: TeamChangeStatus;
  oldPath?: string;
}

/** The real product changes a team run made in its workspace (git working-tree diff vs HEAD). */
export interface TeamChanges {
  isGitRepo: boolean;
  head: string | null;
  branch: string | null;
  files: TeamChangeFile[];
  diff: string;
  diffTruncated: boolean;
  summary: { files: number; insertions: number; deletions: number };
  generatedAt: string;
  note?: string;
}

/** Result of POST /api/team/runs/:id/git/commit. `committed:false` ⇒ nothing to commit. */
export interface TeamCommitResult {
  committed: boolean;
  /** Full sha of the new commit (only when `committed`). */
  sha: string | null;
  /** One-line commit summary, or a human note when nothing changed. */
  summary: string;
  /** The refreshed changeset after the commit. */
  changes: TeamChanges;
}

/** Body for POST /api/team/runs/:id/git/pr. */
export interface TeamPrInput {
  title: string;
  body?: string;
  base?: string;
}

/** Result of POST /api/team/runs/:id/git/pr. */
export interface TeamPrResult {
  url: string;
}

export interface RoleConfigInput {
  templateId?: string;
  name: string;
  description?: string;
  persona?: string;
  tool: TeamAgentType;
  model: string;
  effort: string;
  permission: string;
  canWriteCode: boolean;
  requiredForSignoff: boolean;
}

export interface CreateTeamRunRequest {
  name?: string;
  goal: string;
  templateId?: string;
  roles?: RoleConfigInput[];
  orchestrationMode?: TeamOrchestrationMode;
  /** Project folder the team works on (the .tiger root is created inside it). */
  path?: string;
}

/** Create/update payload for a custom team template. */
export interface TeamTemplatePayload {
  name: string;
  description?: string;
  roles: RoleTemplate[];
}

export interface CreateTeamRunResponse {
  run: TeamRun;
}

export interface SteerRequest {
  body: string;
  target?: string;
}

export interface SteerResponse {
  directive: SteeringDirective;
}

export interface TeamRunStateResponse {
  state: TeamRunState;
}

export interface TeamTemplatesResponse {
  teams: TeamTemplate[];
  roles: RoleTemplate[];
}

export interface TeamMessagePage {
  items: TeamMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface TeamMessageHistoryParams {
  cursor?: string | null;
  afterSeq?: number;
  limit?: number;
}

export interface TeamArtifact {
  id: string;
  runId: string;
  path: string;
  name: string;
  kind?: string;
  mimeType?: string | null;
  size?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export type TeamRunStartInput = CreateTeamRunRequest;
export type TeamSteeringInput = SteerRequest;
export type TeamDirective = SteeringDirective;
export type TeamVerification = VerificationRecord;
export type TeamSignOff = SignOff;

export interface TeamStateEvent {
  type: 'team.state';
  runId?: string;
  state: TeamRunState;
}

export interface TeamMessageEvent {
  type: 'team.message';
  runId?: string;
  message: TeamMessage;
}

/** `team.role` frame — a single role's live snapshot changed. */
export interface TeamRoleEvent {
  type: 'team.role';
  runId: string;
  role: RoleSnapshot;
}

/** `team.done` frame — the run's completion gate changed. */
export interface TeamDoneEvent {
  type: 'team.done';
  runId: string;
  gate: DoneGateState;
}

/** `team.steering` frame — a steering directive's ack/applied state changed. */
export interface TeamSteeringEvent {
  type: 'team.steering';
  runId: string;
  directive: SteeringDirective;
}

/** The compact changeset summary carried on a `team.changes` frame. */
export interface TeamChangesEvent {
  isGitRepo: boolean;
  head: string | null;
  branch: string | null;
  summary: { files: number; insertions: number; deletions: number };
  generatedAt: string;
}

/** `team.changes` frame — the working-tree changeset summary changed. */
export interface TeamChangesFrame {
  type: 'team.changes';
  runId: string;
  changes: TeamChangesEvent;
}

// --- Backend health (mirror of GET /api/health) ---

export interface HealthStatus {
  status: 'ok' | 'degraded';
  ok: boolean;
  db: { ready: boolean; name: string };
  terminals: number;
  dataDir: string;
}

// --- Autonomous queue (mirror of apps/backend/src/queue/types.ts) ---

export type QueueProvider = 'claude' | 'codex' | 'antigravity' | 'mixed';
export type QueueRuleProvider = QueueProvider | 'any';
export type QueueRuleOperator = 'gte' | 'gt' | 'lte' | 'lt' | 'eq';
export type QueueRuleAction = 'block_dispatch';
export type QueueTargetType = 'terminal' | 'project' | 'team';
export type QueueJobStatus =
  | 'queued'
  | 'running'
  | 'blocked_by_limit'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'retrying';
export type QueueStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface QueueJobConfigSnapshot {
  fromStage?: TigerStageId;
  configs?: Partial<Record<TigerStageId, TigerStageRunConfig>>;
  templateName?: string;
  values?: Record<string, unknown>;
}

export interface QueueProjectTargetPayload {
  workspacePath?: string;
  projectName?: string;
  provider?: QueueProvider;
  configSnapshot?: QueueJobConfigSnapshot;
}

export interface QueueTerminalTargetPayload {
  name: string;
  cwd?: string;
  initialCommand?: string;
  groupId?: string | null;
  shell?: Partial<ShellSpec>;
  env?: Record<string, string>;
  autostart?: boolean;
  protected?: boolean;
  cols?: number;
  rows?: number;
}

export interface QueueTeamTargetPayload {
  mode: 'create' | 'append';
  runId?: string;
  workspacePath?: string;
  workspace?: string;
  templateId?: string;
  roles?: unknown[];
  orchestrationMode?: TeamOrchestrationMode;
}

export type QueueTargetPayload = QueueProjectTargetPayload | QueueTerminalTargetPayload | QueueTeamTargetPayload;

export interface QueueTarget {
  type: QueueTargetType;
}

export interface QueueStep {
  id: string;
  jobId: string;
  stepKey: TigerStageId;
  position: number;
  status: QueueStepStatus;
  attempts: number;
  error: string | null;
  checkpoint: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueJob {
  id: string;
  position: number;
  status: QueueJobStatus;
  priority: number;
  provider: QueueProvider;
  workspacePath: string;
  projectName: string | null;
  prompt: string;
  configSnapshot: QueueJobConfigSnapshot;
  targetType?: QueueTargetType | null;
  targetPayload?: QueueTargetPayload | null;
  targetRef?: Record<string, unknown> | null;
  title?: string | null;
  body?: string | null;
  failureKind?: string | null;
  historyArchivedAt?: string | null;
  attempts: number;
  maxAttempts: number;
  blockedReason: string | null;
  resumeAfter: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  currentStep: TigerStageId | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueJobView extends QueueJob {
  steps: QueueStep[];
}

export interface QueueRule {
  id: string;
  name: string;
  enabled: boolean;
  provider: QueueRuleProvider;
  windowKey: string;
  metric: 'percent_used';
  operator: QueueRuleOperator;
  threshold: number;
  action: QueueRuleAction;
  config: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueEvent {
  id: string;
  jobId: string | null;
  type: string;
  message: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export type QueueProviderCounts = Record<QueueProvider, number>;

export interface QueueState {
  queuePipelineV2?: boolean;
  jobs: QueueJobView[];
  liveItems?: QueueJobView[];
  historyCounts?: {
    total: number;
    byStatus: Partial<Record<QueueJobStatus, number>>;
    byTarget: Partial<Record<QueueTargetType, number>>;
  };
  rules: QueueRule[];
  events: QueueEvent[];
  runningByProvider: QueueProviderCounts;
  providerConcurrency: QueueProviderCounts;
  updatedAt: string;
}

export interface QueueHistoryQuery {
  status?: Extract<QueueJobStatus, 'completed' | 'failed' | 'canceled'>;
  target?: QueueTargetType;
  cursor?: string | null;
  limit?: number;
}

export interface QueueHistoryResponse {
  items: QueueJobView[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export type QueueBulkAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'delete';

export interface QueueBulkResult {
  id: string;
  ok: boolean;
  status?: QueueJobStatus;
  error?: string;
}

export interface QueueBulkResponse {
  action: QueueBulkAction;
  results: QueueBulkResult[];
  state: QueueState;
}

export interface QueueEnqueueInput {
  prompt?: string;
  body?: string;
  title?: string;
  workspacePath?: string;
  projectName?: string;
  provider?: QueueProvider;
  priority?: number;
  maxAttempts?: number;
  configSnapshot?: QueueJobConfigSnapshot;
  target?: QueueTarget | QueueTargetType;
  payload?: Record<string, unknown>;
}

export interface QueueClientEvent {
  id: string;
  jobId: string | null;
  type: string;
  message: string;
  payload?: Record<string, unknown> | null;
  createdAt: string;
}

// --- Prompt generation (mirror of apps/backend prompt-generation service) ---

export type PromptGenerationStatus = 'pending' | 'running' | 'done' | 'failed';

export interface PromptGenerationRecord {
  id: string;
  inputText: string;
  outputText: string | null;
  status: PromptGenerationStatus;
  agentType: TigerAgentType;
  model: string | null;
  error: string | null;
  projectId: string | null;
  terminalId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type PromptGenerationReuseAction = 'copy' | 'edit' | 'save-to-library' | 'use-as-project-prompt' | 'enqueue';

export interface PromptGenerationState {
  generation: PromptGenerationRecord;
  progress: AgentRunState | 'blocked' | 'persisting' | 'idle';
  reuseActions: PromptGenerationReuseAction[];
}

export interface PromptGenerationStartInput {
  inputText: string;
  agentType?: TigerAgentType;
  model?: string | null;
  effort?: string | null;
  permission?: string | null;
  projectId?: string | null;
}

// --- Prompt history (mirror of apps/backend prompt_history_events) ---

export type PromptHistoryKind = 'generated' | 'saved_to_library' | 'used_as_project_prompt' | 'enqueue_requested';

export interface PromptHistoryEvent {
  id: string;
  projectId: string | null;
  kind: PromptHistoryKind | string;
  inputText: string | null;
  outputText: string | null;
  generationId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  status?: string | null;
  agentType?: TigerAgentType | null;
  model?: string | null;
  error?: string | null;
}

export interface PromptHistoryFilters {
  text?: string;
  kind?: string;
  projectId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  generationId?: string;
  limit?: number;
}

export interface PromptHistoryListResponse {
  items: PromptHistoryEvent[];
  total?: number;
}

/** Loose shape of any server->client WS message (client reads a subset). */
export interface ServerMessage {
  type: string;
  termId?: string;
  id?: string;
  data?: string;
  state?: TerminalRunState;
  pid?: number;
  cols?: number;
  rows?: number;
  exitCode?: number | null;
  signal?: number | null;
  matched?: number;
  written?: number;
  failed?: { termId: string; code: string }[];
  error?: { message: string; code?: string };
  code?: string;
  message?: string;
  ts?: number;
  // Team live frames (team.role / team.done / team.steering / team.changes).
  runId?: string;
  role?: RoleSnapshot;
  gate?: DoneGateState;
  directive?: SteeringDirective;
  changes?: TeamChangesEvent;
}

// --- Cue (event-driven orchestration engine) ---

export type CueEventType = 'file.changed' | 'time.scheduled' | 'time.once' | 'agent.completed' | 'cli.trigger';

export type CueTargetKind = 'queue' | 'team';

export type CueChangeType = 'created' | 'modified' | 'deleted' | 'any';

export interface CueFilterInput {
  changeType?: CueChangeType;
  pathIncludes?: string;
  triggeredBy?: 'team' | 'tiger';
  allOf?: string[];
}

export interface CueTargetInput {
  kind: CueTargetKind;
  workspacePath?: string;
  projectName?: string;
  provider?: 'claude' | 'codex' | 'antigravity' | 'mixed';
  priority?: number;
  maxAttempts?: number;
}

/** The editable shape of a subscription, mirrored from the backend `CueSubscription`. */
export interface CueSubscriptionInput {
  id: string;
  name?: string;
  event: CueEventType;
  filter?: CueFilterInput;
  prompt?: string;
  promptFile?: string;
  target: CueTargetInput;
  enabled?: boolean;
  watch?: string;
  intervalMs?: number;
  at?: string;
}

export interface CueSubscriptionStatus {
  id: string;
  name: string | null;
  event: CueEventType;
  target: CueTargetKind;
  enabled: boolean;
  lastFiredAt: string | null;
  fireCount: number;
  lastError: string | null;
  pendingSources?: string[];
}

export interface CueEngineStatus {
  enabled: boolean;
  running: boolean;
  workspace: string | null;
  configPath: string | null;
  subscriptions: CueSubscriptionStatus[];
}
