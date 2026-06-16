// ---------------------------------------------------------------------------
// Tiger orchestrator domain model. The orchestrator drives a project prompt
// through 6 workflow stages (7 system prompts — stage 6 splits into 6A/6B) by
// running interactive Claude/Codex CLI agents, detecting completion, validating
// their output files, and tracking task status. All generated content is English.
// ---------------------------------------------------------------------------

export type AgentType = 'claude' | 'codex';

/** Workflow stages. Stage 6 is split into task-review (6A) and requesting-code-review (6B). */
export type StageId =
  | 'brainstorming'
  | 'writing-plan'
  | 'writing-tasks'
  | 'merge-tasks'
  | 'executing-plan'
  | 'task-review'
  | 'requesting-code-review';

export const STAGE_ORDER: StageId[] = [
  'brainstorming',
  'writing-plan',
  'writing-tasks',
  'merge-tasks',
  'executing-plan',
  'task-review',
  'requesting-code-review',
];

/** Per-stage metadata: directory name, system-prompt file, output-file suffix, English title. */
export interface StageMeta {
  id: StageId;
  /** Stage working directory under tiger/ (e.g. "brainstorming"). */
  dir: string;
  /** System-prompt file under tiger/system-prompts/ (e.g. "01-brainstorming.md"). */
  promptFile: string;
  /** Output filename suffix: tiger/<dir>/<type>-<NN>-<suffix> (e.g. "brainstorming.md"). */
  outputSuffix: string;
  title: string;
  /** Stages whose output dirs feed into this stage as context. */
  contextDirs: string[];
  /** merge-tasks runs exactly one agent. */
  singleAgent?: boolean;
}

// ---------------------------------------------------------------------------
// Configuration (persisted to tiger/config.json). Command templates + flags are
// fully configurable so Claude/Codex invocation can change without code edits.
// ---------------------------------------------------------------------------

export interface CliToolConfig {
  /** Executable name or absolute path (e.g. "claude" / "codex"). */
  executable: string;
  /** Flag that selects the model (e.g. "--model" / "-m"); empty string to skip. */
  modelFlag: string;
  /** Claude effort flag (e.g. "--effort"); empty to skip. */
  effortFlag?: string;
  /** Codex effort applied via `-c <key>="<effort>"` (e.g. "model_reasoning_effort"); empty to skip. */
  effortConfigKey?: string;
  /** Flags always included on launch (e.g. codex "--skip-git-repo-check"). */
  extraArgs?: string[];
  /** Permission-mode key -> argv. Dangerous modes live here but are never the default. */
  permissionModes: Record<string, string[]>;
}

export interface StageDefaults {
  claudeAgents: number;
  codexAgents: number;
  claudeModel: string;
  codexModel: string;
  claudeEffort: string;
  codexEffort: string;
  /** Permission-mode keys (must exist in cli.<type>.permissionModes). */
  claudePermission: string;
  codexPermission: string;
  parallel: boolean;
}

export interface TigerTiming {
  /** Idle gap after launch output that marks the CLI "ready" for input. */
  readyIdleMs: number;
  /** Max wait for readiness before sending the instruction anyway. */
  readyMaxWaitMs: number;
  /** Output-idle fallback: if the output file exists and the terminal is idle this long, treat as done. */
  doneIdleMs: number;
  /** How often to poll for the completion marker / output file. */
  markerPollMs: number;
  /** Hard ceiling for a single agent run before it is failed. */
  agentTimeoutMs: number;
}

export interface TigerConfig {
  version: number;
  cli: { claude: CliToolConfig; codex: CliToolConfig };
  defaults: StageDefaults;
  timing: TigerTiming;
  execution: { parallel: boolean; locking: boolean; maxConcurrent: number };
}

// ---------------------------------------------------------------------------
// Per-stage run configuration (chosen by the user before each stage runs).
// ---------------------------------------------------------------------------

export interface StageRunConfig {
  claudeAgents: number;
  codexAgents: number;
  claudeModel: string;
  codexModel: string;
  claudeEffort: string;
  codexEffort: string;
  claudePermission: string;
  codexPermission: string;
  parallel: boolean;
  /** merge-tasks only: which single agent type performs the merge. */
  mergeAgent?: AgentType;
}

// ---------------------------------------------------------------------------
// Runtime state (in-memory; serialized to the frontend over REST/WS).
// ---------------------------------------------------------------------------

export type AgentRunState =
  | 'pending'
  | 'starting'
  | 'waiting_ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped';

export type CompletionMethod = 'marker' | 'idle' | 'exit';

export interface AgentRun {
  id: string;
  /** Equal to id — the ephemeral terminal id used for the live xterm tile. */
  terminalId: string;
  stage: StageId;
  type: AgentType;
  /** 1-based index within this type for the stage. */
  index: number;
  /** Display label, e.g. "claude-01". */
  label: string;
  /** Absolute path of the expected output file. */
  outputPath: string;
  /** Output path relative to the tiger root (for display). */
  outputRel: string;
  markerPath: string;
  promptPath: string;
  /** The launch command line used (for the run log + UI). */
  command: string;
  state: AgentRunState;
  completion?: CompletionMethod;
  exitCode?: number | null;
  error?: string;
  /** executing-plan only: the task this run was assigned. */
  taskId?: string;
  startedAt?: string;
  endedAt?: string;
  attempts: number;
}

export type StageStatus = 'not_started' | 'running' | 'completed' | 'failed' | 'stopped';

export interface StageState {
  id: StageId;
  status: StageStatus;
  runs: AgentRun[];
  startedAt?: string;
  endedAt?: string;
  /** Human-readable English summary of the last outcome. */
  message?: string;
}

// ---------------------------------------------------------------------------
// Tasks (tiger/merged-tasks/tasks.md is the source of truth during execution).
// ---------------------------------------------------------------------------

export type ExecutionStatus = 'not_started' | 'in_progress' | 'done' | 'blocked';
export type ReviewStatus = 'pending' | 'reviewing' | 'approved' | 'needs_fix' | 'fixed';

export const EXECUTION_STATUSES: ExecutionStatus[] = ['not_started', 'in_progress', 'done', 'blocked'];
export const REVIEW_STATUSES: ReviewStatus[] = ['pending', 'reviewing', 'approved', 'needs_fix', 'fixed'];

export interface TaskRecord {
  id: string;
  title: string;
  executionStatus: ExecutionStatus;
  assignedAgent: string;
  startedAt: string;
  completedAt: string;
  reviewStatus: ReviewStatus;
  reviewNotes: string;
  /** Character offsets of this task's block in the source file (for surgical rewrites). */
  start: number;
  end: number;
}

export interface TaskSummaryItem {
  id: string;
  title: string;
  executionStatus: ExecutionStatus;
  reviewStatus: ReviewStatus;
  assignedAgent: string;
}

export interface TaskSummary {
  total: number;
  byExecution: Record<ExecutionStatus, number>;
  byReview: Record<ReviewStatus, number>;
  items: TaskSummaryItem[];
}

// ---------------------------------------------------------------------------
// The full serializable orchestrator state sent to the UI.
// ---------------------------------------------------------------------------

export interface OrchestratorState {
  /** Directory the user selected; tiger/ is created inside it. */
  workspace: string | null;
  /** Absolute path to the tiger/ root. */
  tigerRoot: string | null;
  initialized: boolean;
  /** First lines of the original project prompt (preview only). */
  projectPromptPreview: string;
  currentStage: StageId | null;
  busy: boolean;
  stages: Record<StageId, StageState>;
  tasks: TaskSummary | null;
}
