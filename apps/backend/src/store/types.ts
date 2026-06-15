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
  theme: 'system' | 'light' | 'dark';
  defaultCwd: string;
  defaultShell: ShellSpec;
  confirmBeforeKill: boolean;
  commandRouting: CommandRoutingSettings;
}

export interface PersistedState {
  schemaVersion: 1;
  terminals: TerminalDefinition[];
  groups: TerminalGroup[];
  settings: AppSettings;
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
