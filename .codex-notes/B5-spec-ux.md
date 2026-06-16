## Verdict

Not fully spec-complete. Core pty-backed terminal management is implemented and wired end-to-end, but there are UX/spec gaps around cwd validation, failed lifecycle feedback, and persisted settings that are defined but unreachable.

Backend `npm run typecheck -w @kaplan/backend` passes. I did not run the full app because this session is read-only and backend startup writes local state.

## Feature Coverage

| Feature | Status |
|---|---|
| Create/name terminals | Implemented |
| Per-terminal working dir | Partially implemented |
| Optional auto-run command | Implemented |
| Groups create + assign | Implemented |
| Send command to selected/group/all | Implemented |
| Live output | Implemented |
| Fully interactive terminal | Implemented |
| Start/stop/restart/close | Implemented with gaps |
| Status running/closed/error | Partially implemented |
| List shows group/folder/last-output/status | Implemented |
| Local persistence | Implemented |

## Findings

### HIGH — Failed start/restart has no useful UX error path

**File:** [TerminalSession.ts](</C:/Users/serkan/Desktop/Kaplan/apps/backend/src/terminal/TerminalSession.ts:185>), [socket.ts](</C:/Users/serkan/Desktop/Kaplan/apps/backend/src/ws/socket.ts:68>), [terminals.ts](</C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/stores/terminals.ts:67>)

**Gap:** backend captures spawn/cwd errors and sets `failed`, but WS status broadcasts only `state`/`pid`, dropping `error`. Frontend lifecycle calls also do not catch REST failures, so invalid cwd/start errors can become an unhandled promise with only a vague failed dot.

**Fix:** include `error`, `exitCode`, `signal`, timestamps in `term.status`; catch `start/stop/restart/remove` failures in store or callers; show the error in `TerminalPane` with an edit/retry path.

### MEDIUM — cwd validation is advisory only; invalid cwd can be saved

**File:** [TerminalEditModal.vue](</C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/components/TerminalEditModal.vue:40>), [TerminalEditModal.vue](</C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/components/TerminalEditModal.vue:55>), [terminals.routes.ts](</C:/Users/serkan/Desktop/Kaplan/apps/backend/src/http/terminals.routes.ts:77>)

**Gap:** the modal checks cwd on blur, but `save()` does not require a successful validation and the backend create/update routes accept cwd without validation. User can create a terminal that only fails later at start.

**Fix:** validate cwd in POST/PUT using shared backend logic, reject invalid/non-directory cwd, and block modal save while cwd is bad/checking.

### MEDIUM — persisted command-routing settings are unreachable from UI

**File:** [settings.routes.ts](</C:/Users/serkan/Desktop/Kaplan/apps/backend/src/http/settings.routes.ts:29>), [settings.ts](</C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/stores/settings.ts:7>), [CommandBar.vue](</C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/components/CommandBar.vue:26>)

**Gap:** backend supports `appendNewlineByDefault` and `startTerminalOnSend`, but the frontend has no settings UI or command-bar control for them. `broadcast()` is always called without an explicit newline option.

**Fix:** add preferences UI or inline command-bar toggles, wire them through `settings.update()`, and pass explicit `appendNewline` where appropriate.

### MEDIUM — `confirmBeforeKill` is persisted but ignored

**File:** [state.ts](</C:/Users/serkan/Desktop/Kaplan/apps/backend/src/store/state.ts:18>), [TerminalPane.vue](</C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/components/TerminalPane.vue:158>), [TerminalSidebar.vue](</C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/components/TerminalSidebar.vue:55>)

**Gap:** default settings say `confirmBeforeKill: true`, but Stop/Restart actions immediately kill/restart running terminals. Close/delete has its own two-click confirm, but stop/restart do not honor the persisted setting.

**Fix:** check `settings.confirmBeforeKill` before stop/restart/delete-while-running and show a confirmation modal.

### LOW — cwd path rules are inconsistent

**File:** [fs.routes.ts](</C:/Users/serkan/Desktop/Kaplan/apps/backend/src/http/fs.routes.ts:12>), [TerminalSession.ts](</C:/Users/serkan/Desktop/Kaplan/apps/backend/src/terminal/TerminalSession.ts:313>)

**Gap:** `/api/fs/validate` rejects relative and UNC paths, while terminal start only `stat()`s whatever cwd is stored. This means validation and actual launch can disagree.

**Fix:** move cwd normalization/validation into one shared helper used by fs validation, terminal create/update, and pty start.