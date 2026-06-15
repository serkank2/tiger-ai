# Recommendation

Use **raw filesystem JSON**.

For a tiny single-user local terminal manager, `better-sqlite3` is unnecessary operational weight, and `lowdb` does not add much beyond a small wrapper. A single validated JSON document is simple, inspectable, easy to back up, and enough for terminal definitions, groups, and settings.

## File Location

Default to the OS app-data directory, not the project directory.

Examples:

- macOS: `~/Library/Application Support/<app-name>/state.json`
- Windows: `%APPDATA%\<app-name>\state.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/<app-name>/state.json`

Allow an override for development/portable mode:

```ts
TERMINAL_MANAGER_DATA_DIR=/path/to/data
```

Use the project directory only for explicit dev mode, not as the default, because project folders may be deleted, synced, or checked into git accidentally.

## Atomic Write

Write the entire state atomically:

1. Serialize and validate JSON.
2. Write to `state.json.tmp` in the same directory.
3. `fsync` the temp file.
4. Rename `state.json.tmp` to `state.json`.
5. Best effort `fsync` the containing directory.
6. Optionally keep `state.json.bak` before replacement.

On load:

- Parse and validate schema version.
- If corrupted, try `.bak`.
- If both fail, preserve the bad file as `state.corrupt.<timestamp>.json` and start with defaults.

# Data Model

```ts
export type TerminalId = string;
export type GroupId = string;

export type ShellKind =
  | "system-default"
  | "powershell"
  | "pwsh"
  | "cmd"
  | "bash"
  | "zsh"
  | "fish"
  | "custom";

export interface TerminalDefinition {
  id: TerminalId;
  name: string;

  groupId: GroupId | null;

  cwd: string;
  initialCommand?: string;

  shell: {
    kind: ShellKind;
    path?: string;
    args?: string[];
  };

  env?: Record<string, string>;

  autostart?: boolean;
}

export interface TerminalGroup {
  id: GroupId;
  name: string;
  color?: string;
}

export interface AppSettings {
  theme: "system" | "light" | "dark";
  defaultCwd: string;
  defaultShell: TerminalDefinition["shell"];

  confirmBeforeKillingTerminal: boolean;
  restoreRunningTerminalsOnLaunch: boolean;

  commandRouting: {
    appendNewlineByDefault: boolean;
    startTerminalOnSend: boolean;
  };
}

export interface PersistedState {
  schemaVersion: 1;

  terminals: TerminalDefinition[];
  groups: TerminalGroup[];

  settings: AppSettings;

  updatedAt: string;
}
```

Live state is separate and not persisted:

```ts
export interface TerminalRuntimeState {
  id: TerminalId;
  pid: number;
  status: "starting" | "running" | "exited" | "failed";
  startedAt: string;
  exitedAt?: string;
  exitCode?: number;
}
```

# Command Routing

Persisted definitions describe what terminals exist. The PTY manager owns live processes in memory.

```ts
export interface PtyManager {
  hasSession(id: TerminalId): boolean;
  start(definition: TerminalDefinition): Promise<void>;
  send(id: TerminalId, input: string): void;
}
```

## Selection Model

Use one focused terminal plus optional UI group selection.

```ts
export interface SelectionState {
  activeTerminalId: TerminalId | null;
  activeGroupId: GroupId | null;
}
```

Rules:

- `activeTerminalId` is the focused terminal pane/tab.
- `activeGroupId` is the selected group in the sidebar.
- If a terminal is focused, its `groupId` may update `activeGroupId`.
- Command routing should use stable IDs, never terminal names.

## Send To Selected

Target only the focused terminal.

```ts
function sendToSelected(command: string) {
  const id = selection.activeTerminalId;
  if (!id) return;

  sendToTerminal(id, command);
}
```

Behavior:

- If the terminal is running, write to its PTY.
- If it is not running and `settings.commandRouting.startTerminalOnSend` is true, start it first, then send.
- Otherwise skip and surface “terminal is not running”.

## Send To Group

Target all terminals whose `groupId` matches the selected group.

```ts
function sendToGroup(command: string) {
  const groupId = selection.activeGroupId;
  if (!groupId) return;

  const targets = state.terminals.filter(t => t.groupId === groupId);

  for (const terminal of targets) {
    sendToTerminal(terminal.id, command);
  }
}
```

Behavior:

- Preserve terminal order from `state.terminals`.
- Skip missing/deleted definitions.
- Apply the same running/start-on-send rule per terminal.

## Send To All

Target every defined terminal.

```ts
function sendToAll(command: string) {
  for (const terminal of state.terminals) {
    sendToTerminal(terminal.id, command);
  }
}
```

Shared helper:

```ts
async function sendToTerminal(id: TerminalId, command: string) {
  const terminal = state.terminals.find(t => t.id === id);
  if (!terminal) return;

  if (!ptyManager.hasSession(id)) {
    if (!state.settings.commandRouting.startTerminalOnSend) return;
    await ptyManager.start(terminal);
  }

  const input = state.settings.commandRouting.appendNewlineByDefault
    ? `${command}\n`
    : command;

  ptyManager.send(id, input);
}
```

Decisive default: **send only to running terminals unless `startTerminalOnSend` is enabled**. That avoids surprising process launches while still supporting automation when explicitly configured.