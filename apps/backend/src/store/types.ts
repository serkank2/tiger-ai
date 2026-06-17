// ---------------------------------------------------------------------------
// Persisted domain model (saved to state.json) + in-memory runtime types.
// ---------------------------------------------------------------------------

export type TerminalId = string;
export type GroupId = string;

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
  /** Required when kind === 'custom'. */
  path?: string;
  args?: string[];
}

export interface TerminalDefinition {
  id: TerminalId;
  name: string;
  groupId: GroupId | null;
  cwd: string;
  initialCommand?: string;
  shell: ShellSpec;
  env?: Record<string, string>;
  autostart?: boolean;
  /** Excluded from fan-out/bulk commands by default; act on it directly or unprotect first. */
  protected?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalGroup {
  id: GroupId;
  name: string;
  color?: string;
}

export interface CommandRoutingSettings {
  /** Append a newline so a sent command actually executes. */
  appendNewlineByDefault: boolean;
  /** If a target terminal is not running, start it before sending. */
  startTerminalOnSend: boolean;
}

export interface AppSettings {
  theme: string;
  defaultCwd: string;
  defaultShell: ShellSpec;
  commandRouting: CommandRoutingSettings;
}

/** Tiger orchestrator persistence (only what must survive a restart). */
export interface TigerPersisted {
  /** Last workspace directory selected for the Tiger orchestrator. */
  lastWorkspace?: string;
  /** Known project workspace directories (the launcher lists these). */
  projects?: string[];
}

export interface PersistedState {
  schemaVersion: 1;
  terminals: TerminalDefinition[];
  groups: TerminalGroup[];
  settings: AppSettings;
  tiger?: TigerPersisted;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Runtime (in-memory) — never persisted.
// ---------------------------------------------------------------------------

export type TerminalRunState = 'starting' | 'running' | 'exited' | 'failed' | 'stopped';

export interface TerminalRuntimeStatus {
  id: TerminalId;
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

// ---------------------------------------------------------------------------
// Command routing (shared between WS protocol and TerminalManager).
// ---------------------------------------------------------------------------

export type CommandTarget =
  | { mode: 'selected'; termIds: TerminalId[] }
  | { mode: 'group'; groupId: GroupId }
  | { mode: 'all' };

export interface RouteResult {
  matched: number;
  written: number;
  failed: { termId: TerminalId; code: string }[];
}
