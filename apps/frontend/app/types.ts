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
