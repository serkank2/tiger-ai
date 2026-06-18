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

export type ShellKind =
  | 'system-default'
  | 'powershell'
  | 'pwsh'
  | 'cmd'
  | 'bash'
  | 'zsh'
  | 'fish'
  | 'custom';

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

export type TigerAgentType = 'claude' | 'codex';
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

export type TigerRunTemplatePayload = Pick<
  TigerRunTemplate,
  'name' | 'description' | 'fromStage' | 'configs'
>;

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
  claudeModel: string;
  codexModel: string;
  claudeEffort: string;
  codexEffort: string;
  claudePermission: string;
  codexPermission: string;
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
  cli: { claude: TigerCliToolConfig; codex: TigerCliToolConfig };
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
  providers: Record<TigerAgentType, { provider: TigerAgentType; latest: LimitSnapshot[]; latestCheckedAt: string | null; ok: boolean; error?: string }>;
  rules: LimitRule[];
  decision: LimitDecision;
  staleAfterMs: number;
  updatedAt?: string;
}

export interface TigerStageRunConfig {
  claudeAgents: number;
  codexAgents: number;
  claudeModel: string;
  codexModel: string;
  claudeEffort: string;
  codexEffort: string;
  claudePermission: string;
  codexPermission: string;
  parallel: boolean;
  mergeAgent?: TigerAgentType;
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

export type QueueProvider = 'claude' | 'codex' | 'mixed';
export type QueueRuleProvider = QueueProvider | 'any';
export type QueueRuleOperator = 'gte' | 'gt' | 'lte' | 'lt' | 'eq';
export type QueueRuleAction = 'block_dispatch';
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

export interface QueueState {
  jobs: QueueJobView[];
  rules: QueueRule[];
  events: QueueEvent[];
  updatedAt: string;
}

export interface QueueEnqueueInput {
  prompt: string;
  workspacePath?: string;
  projectName?: string;
  provider?: QueueProvider;
  priority?: number;
  maxAttempts?: number;
  configSnapshot?: QueueJobConfigSnapshot;
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

export type PromptGenerationReuseAction =
  | 'copy'
  | 'edit'
  | 'save-to-library'
  | 'use-as-project-prompt'
  | 'enqueue';

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
}
