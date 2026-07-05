// ---------------------------------------------------------------------------
// Tiger orchestrator domain model. The orchestrator drives a project prompt
// through 6 workflow stages (7 system prompts — stage 6 splits into 6A/6B) by
// running interactive Claude/Codex/Antigravity CLI agents, detecting completion,
// validating their output files, and tracking task status. All generated content
// is English.
// ---------------------------------------------------------------------------

export type AgentType = 'claude' | 'codex' | 'antigravity';

/** Canonical ordered list of every supported provider. */
export const AGENT_TYPES: readonly AgentType[] = ['claude', 'codex', 'antigravity'];

/** Type guard for the provider union — use when narrowing untrusted/persisted values. */
export function isAgentType(value: unknown): value is AgentType {
  return value === 'claude' || value === 'codex' || value === 'antigravity';
}

/** Coerce an untrusted/persisted provider value to a known AgentType, never silently mislabeling. */
export function toAgentTypeOr(value: unknown, fallback: AgentType): AgentType {
  return isAgentType(value) ? value : fallback;
}

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
  /** Selectable model identifiers offered in the UI dropdown (empty = use the CLI default). */
  models?: string[];
  /** Flag that selects the model (e.g. "--model" / "-m"); empty string to skip. */
  modelFlag: string;
  /** Claude effort flag (e.g. "--effort"); empty to skip. */
  effortFlag?: string;
  /** Codex effort applied via `-c <key>="<effort>"` (e.g. "model_reasoning_effort"); empty to skip. */
  effortConfigKey?: string;
  /** Flags always included on launch (e.g. codex "--skip-git-repo-check"). */
  extraArgs?: string[];
  /** Permission-mode key -> argv. Defaults are defined in config.ts and may be unrestricted. */
  permissionModes: Record<string, string[]>;
}

export interface StageDefaults {
  claudeAgents: number;
  codexAgents: number;
  antigravityAgents: number;
  claudeModel: string;
  codexModel: string;
  antigravityModel: string;
  claudeEffort: string;
  codexEffort: string;
  antigravityEffort: string;
  /** Permission-mode keys (must exist in cli.<type>.permissionModes). */
  claudePermission: string;
  codexPermission: string;
  antigravityPermission: string;
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
  /** Max wait for the TUI to settle after the priming Enter (accepting the trust dialog). */
  settleMaxWaitMs: number;
  /** Pause between typing the instruction and pressing Enter to submit it. */
  submitDelayMs: number;
}

export interface TigerConfig {
  version: number;
  cli: { claude: CliToolConfig; codex: CliToolConfig; antigravity: CliToolConfig };
  defaults: StageDefaults;
  timing: TigerTiming;
  execution: {
    parallel: boolean;
    locking: boolean;
    /** Max agents running at once per stage. 0 means UNLIMITED (launch every selected agent). */
    maxConcurrent: number;
    lockTtlMs: number;
    /** Total attempts per agent run (1 = no retry, 2 = one automatic retry on failure). */
    maxAttempts: number;
    /**
     * Auto-advance past a stage that FAILED (after retries) as long as it produced some output,
     * instead of halting the auto-run. A user stop/interrupt always halts regardless.
     */
    continueOnFailure: boolean;
    /** Maximum number of correction cycles (routing Stage 6B issues back) before routing stops. */
    maxCorrectionCycles: number;
    /** Delete the whole .tiger workspace after an auto-run (Run All) completes the final stage. */
    deleteTigerOnComplete: boolean;
  };
}

// ---------------------------------------------------------------------------
// Per-stage run configuration (chosen by the user before each stage runs).
// ---------------------------------------------------------------------------

export interface StageRunConfig {
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
  | 'stopped'
  | 'interrupted';

export type CompletionMethod = 'marker' | 'idle' | 'exit';

export interface AgentRun {
  id: string;
  runId?: string;
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
  /**
   * Working directory the agent's PTY is launched in. Defaults to the tiger root (the shared
   * workspace) when unset. Set to a per-task git worktree path when worktree-per-task isolation
   * is enabled, so the agent's file edits are isolated from sibling agents.
   */
  cwd?: string;
  startedAt?: string;
  endedAt?: string;
  attempts: number;
}

export type StageStatus = 'not_started' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';

export interface StageState {
  id: StageId;
  status: StageStatus;
  runs: AgentRun[];
  startedAt?: string;
  endedAt?: string;
  /** Human-readable English summary of the last outcome. */
  message?: string;
  /** User explicitly chose to continue past this stage's failures. */
  continued?: boolean;
  /** The run configuration this stage last ran with (so the UI can show what was used). */
  config?: StageRunConfig;
}

// ---------------------------------------------------------------------------
// Tasks (tiger/merged-tasks/tasks.md is the source of truth during execution).
// ---------------------------------------------------------------------------

export type ExecutionStatus = 'not_started' | 'in_progress' | 'done' | 'blocked';
export type ReviewStatus = 'pending' | 'reviewing' | 'approved' | 'needs_fix' | 'fixed';

/** Stage 6B final-decision vocabulary (exactly the four values mandated by the prompt). */
export type FinalDecision = 'approved' | 'minor_fixes_required' | 'major_fixes_required' | 'rejected';

export const EXECUTION_STATUSES: ExecutionStatus[] = ['not_started', 'in_progress', 'done', 'blocked'];
export const REVIEW_STATUSES: ReviewStatus[] = ['pending', 'reviewing', 'approved', 'needs_fix', 'fixed'];
export const FINAL_DECISIONS: FinalDecision[] = [
  'approved',
  'minor_fixes_required',
  'major_fixes_required',
  'rejected',
];

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

/** Review finding lifecycle (status encoded in the finding's filename). */
export type FindingStatus = 'open' | 'fixing' | 'fixed' | 'wontfix';

export interface FindingsSummary {
  total: number;
  open: number;
  fixing: number;
  fixed: number;
  wontfix: number;
}

// ---------------------------------------------------------------------------
// The full serializable orchestrator state sent to the UI.
// ---------------------------------------------------------------------------

/** Summary of a known project workspace, shown in the launcher. */
export interface ProjectInfo {
  /** Workspace directory the user selected (tiger/ lives inside it). */
  path: string;
  tigerRoot: string;
  /** Display name (workspace folder name). */
  name: string;
  /** First lines of the project prompt (preview). */
  promptPreview: string;
  initialized: boolean;
  exists: boolean;
  completedStages: number;
  totalStages: number;
  /** Whether this is the currently-open project. */
  active: boolean;
  updatedAt?: string;
}

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
  /** Review findings queue summary (null when review has not produced findings). */
  findings: FindingsSummary | null;
  /** How many correction cycles (Stage 6B → 5/6A re-routes) have been used. */
  correctionCycles: number;
  /** Configured ceiling on correction cycles. */
  maxCorrectionCycles: number;
  /** Whether the workflow is currently auto-advancing through stages. */
  autoAdvance: boolean;
}

/** A saved Run All configuration: per-stage configs + where to start. Stored in MySQL. */
export interface RunTemplate {
  /** Stable database id. Built-ins use deterministic ids; custom templates use generated ids. */
  id?: string;
  name: string;
  description?: string;
  /** Which stage the auto-run should start from. */
  fromStage?: StageId;
  /** Built-in templates ship with the app and cannot be deleted. */
  builtin?: boolean;
  /** Monotonic metadata version for custom template edits. */
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  /** Per-stage run configuration. */
  configs: Partial<Record<StageId, StageRunConfig>>;
}
