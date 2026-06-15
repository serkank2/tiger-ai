# Nuxt 3 Frontend Recommendation

## 1. Component Tree

```text
layouts/default.vue
  TerminalManagerShell.vue          # container
    TerminalSidebarContainer.vue    # container
      TerminalGroupSection.vue      # presentational
        TerminalListItem.vue        # presentational
    TerminalMainPane.vue            # container
      TerminalHeader.vue            # presentational
      TerminalToolbar.vue           # presentational
      TerminalViewport.vue          # container around xterm.js
        XtermSurface.vue            # presentational-ish DOM mount target
    CommandBarContainer.vue         # container
      CommandTargetPicker.vue       # presentational
      CommandInput.vue              # presentational
    TerminalEditorModal.vue         # container
      TerminalForm.vue              # presentational
    StatusToastHost.vue             # container
```

Recommended pages:

```text
pages/index.vue                     # redirect to /terminals
pages/terminals/index.vue           # main manager view
pages/terminals/[id].vue            # optional deep link to active terminal
```

### Container Components

Use containers for anything that talks to Pinia, routes, WebSocket/API clients, or xterm lifecycle:

- `TerminalManagerShell`
- `TerminalSidebarContainer`
- `TerminalMainPane`
- `TerminalViewport`
- `CommandBarContainer`
- `TerminalEditorModal`

### Presentational Components

Keep these stateless or nearly stateless:

- `TerminalListItem`
- `TerminalGroupSection`
- `TerminalHeader`
- `TerminalToolbar`
- `CommandInput`
- `CommandTargetPicker`
- `TerminalForm`

They should receive props and emit events, not know about WebSockets or Pinia directly.

---

## 2. State Management

Use **Pinia**. It is the right default for Nuxt 3 here.

Do **not** put live `xterm.js` instances in Pinia. Store serializable terminal metadata and UI state in Pinia, and keep xterm instances in a dedicated client-only manager/composable.

### Store Shape

```ts
type TerminalStatus = 'running' | 'exited' | 'error' | 'starting' | 'stopped'

type TerminalRecord = {
  id: string
  name: string
  group: string
  cwd: string
  initialCommand?: string
  status: TerminalStatus
  exitCode?: number
  lastOutput: string
  updatedAt: string
}

type TerminalState = {
  terminalsById: Record<string, TerminalRecord>
  terminalIds: string[]

  activeTerminalId: string | null
  selectedTerminalIds: string[]

  groupsExpanded: Record<string, boolean>

  commandTarget:
    | { type: 'selected' }
    | { type: 'group'; group: string }
    | { type: 'all' }

  connectionStatus: 'connected' | 'connecting' | 'disconnected'
}
```

Suggested stores:

```text
stores/terminals.ts       # metadata, selection, active terminal, CRUD actions
stores/terminalIo.ts      # websocket/API connection state and event dispatch
stores/preferences.ts     # layout, font size, theme, split settings
```

### Actions

```ts
fetchTerminals()
createTerminal(payload)
updateTerminal(id, payload)
startTerminal(id)
stopTerminal(id)
restartTerminal(id)
closeTerminal(id)

setActiveTerminal(id)
toggleSelectedTerminal(id)
sendCommandToTargets(command, target)
handleTerminalOutput(id, chunk)
handleTerminalStatus(id, status)
```

---

## 3. Managing Many xterm.js Instances

Use a client-only `useXtermManager()` composable or service:

```ts
const instances = new Map<string, XtermSession>()
```

Each `XtermSession` owns:

```ts
{
  terminal: Terminal
  fitAddon: FitAddon
  attach: (el: HTMLElement) => void
  detach: () => void
  dispose: () => void
  write: (chunk: string) => void
}
```

Recommended policy:

- Backend PTY/session is authoritative.
- Frontend xterm instance is just a view.
- Keep only visible terminals mounted.
- Keep the active terminal mounted.
- If split panes are enabled, keep only visible split terminals mounted.
- Dispose hidden xterm instances after a short idle timeout, for example 60-120 seconds.
- Retain scrollback/output buffer separately, preferably server-side or in a bounded client ring buffer.
- On reactivation, recreate xterm and replay recent buffer.

Avoid keeping 10+ hidden xterm DOM/renderers alive. It wastes memory, can cause resize issues, and makes the UI feel heavier over time.

Use `markRaw()` if an xterm object must touch Vue state locally, but keep it out of Pinia.

---

## 4. Layout Recommendation

Default layout: **sidebar plus single full terminal view**.

```text
┌────────────────────────────────────────────┐
│ Command bar                                │
├───────────────┬────────────────────────────┤
│ Terminal list │ Active interactive terminal │
│ grouped       │                            │
│ by group      │                            │
└───────────────┴────────────────────────────┘
```

This is the best default for managing **5 to 10+ terminals** because:

- The sidebar scales better than tabs.
- Grouping keeps terminal discovery fast.
- The active terminal gets enough space to be genuinely usable.
- Status and last output remain visible without shrinking the terminal.
- It supports bulk operations naturally through selection, group, and all targets.

Do not use tabs as the primary model. Tabs become noisy once there are more than 4-5 terminals.

Do not use a grid as the default. It looks powerful, but terminals quickly become too small for real work.

Add split panes as an advanced optional mode for comparing 2-4 terminals, not as the main layout.