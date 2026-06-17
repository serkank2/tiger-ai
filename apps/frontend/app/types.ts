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
  | 'stopped';
export type TigerStageStatus = 'not_started' | 'running' | 'completed' | 'failed' | 'stopped';
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

export interface TigerState {
  workspace: string | null;
  tigerRoot: string | null;
  initialized: boolean;
  projectPromptPreview: string;
  currentStage: TigerStageId | null;
  busy: boolean;
  stages: Record<TigerStageId, TigerStageState>;
  tasks: TigerTaskSummary | null;
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

export interface TigerConfig {
  version: number;
  cli: { claude: TigerCliToolConfig; codex: TigerCliToolConfig };
  defaults: TigerStageDefaults;
  timing: Record<string, number>;
  execution: { parallel: boolean; locking: boolean; maxConcurrent: number };
}

export interface TigerUsageEntry {
  label: string;
  percent: number;
  metric: 'used' | 'left';
  reset: string | null;
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
