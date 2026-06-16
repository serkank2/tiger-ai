## Findings

### HIGH
**File:line:** [useSocket.ts](<C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/composables/useSocket.ts:97>), [terminals.ts](<C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/stores/terminals.ts:10>), [protocol.ts](<C:/Users/serkan/Desktop/Kaplan/apps/backend/src/ws/protocol.ts:55>)  
**Issue:** WS status contract is not consumed exactly. Backend sends `cols`/`rows` on `term.attached`, `term.snapshot`, and `term.status`, but frontend only applies `state` plus `pid/exitCode/signal/error`. `TerminalStatus.cols/rows` can become stale after attach/reconnect/status updates.  
**Fix:** Add `cols`/`rows` to `StatusInfo`, pass them from all three handlers, and update `t.status.cols/rows`. Prefer discriminated frontend WS message types mirroring `ServerMsg`.

### HIGH
**File:line:** [CommandBar.vue](<C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/components/CommandBar.vue:26>), [useSocket.ts](<C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/composables/useSocket.ts:119>), [socket.ts](<C:/Users/serkan/Desktop/Kaplan/apps/backend/src/ws/socket.ts:161>)  
**Issue:** Multi-terminal command routing clears the command as soon as the WS frame is sent, before `term.broadcastResult`. If all targets fail (`NOT_RUNNING`, `START_FAILED`), user input is lost even though nothing ran. The frontend also ignores the result `id`, so it cannot correlate result/error to the send.  
**Fix:** Have `broadcast()` return an id/promise or register a one-shot result callback. Clear input only after acceptable `written` result, and keep/show retry when `failed.length > 0`.

### MEDIUM
**File:line:** [useSocket.ts](<C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/composables/useSocket.ts:119>), [TerminalManager.ts](<C:/Users/serkan/Desktop/Kaplan/apps/backend/src/terminal/TerminalManager.ts:181>)  
**Issue:** `term.broadcastResult.failed[].code` is semantically richer than the UI message. Frontend always says failed targets were “not running”, but backend can return `UNKNOWN`, `NOT_RUNNING`, or `START_FAILED`.  
**Fix:** Group failures by `code` and show accurate text; for `UNKNOWN` trigger `fetchAll()`, for `START_FAILED` surface start failure and refresh status.

### MEDIUM
**File:line:** [socket.ts](<C:/Users/serkan/Desktop/Kaplan/apps/backend/src/ws/socket.ts:17>), [socket.ts](<C:/Users/serkan/Desktop/Kaplan/apps/backend/src/ws/socket.ts:115>), [TerminalGrid.vue](<C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/components/TerminalGrid.vue:15>)  
**Issue:** Grid renders every terminal, but backend silently ignores attaches after `MAX_ATTACH = 256`. Extra tiles get no `term.attached`, no snapshot, and no output, with no frontend error.  
**Fix:** Send `term.error { code: 'ATTACH_LIMIT' }`, expose/cap the limit in the UI, or virtualize grid attachment so only visible tiles attach.

### MEDIUM
**File:line:** [socket.ts](<C:/Users/serkan/Desktop/Kaplan/apps/backend/src/ws/socket.ts:66>)  
**Issue:** If a peer is lagging, backend drops `term.output` when `bufferedAmount > MAX_BUFFERED`, but does not notify the client or force a snapshot. The comment says snapshot recovers it, but no reattach/resync is triggered. Grid view with many busy tiles can permanently miss output.  
**Fix:** On drop, send a gap/error and force client reattach, close the socket to trigger reconnect+snapshot, or implement explicit snapshot/sequence resync.

### MEDIUM
**File:line:** [TerminalEditModal.vue](<C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/components/TerminalEditModal.vue:28>), [TerminalEditModal.vue](<C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/components/TerminalEditModal.vue:79>), [terminals.routes.ts](<C:/Users/serkan/Desktop/Kaplan/apps/backend/src/http/terminals.routes.ts:85>)  
**Issue:** Settings `defaultShell` does not round-trip into new terminals. The modal defaults new terminals to `system-default` and always sends `shell`, so the backend’s `ctx.state.settings.defaultShell` fallback is bypassed.  
**Fix:** Initialize create form shell fields from `settings.settings.defaultShell` and send that value, including `path/args` for custom shells.

### LOW
**File:line:** [useSocket.ts](<C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/composables/useSocket.ts:116>), [terminals.ts](<C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/stores/terminals.ts:126>), [socket.ts](<C:/Users/serkan/Desktop/Kaplan/apps/backend/src/ws/socket.ts:85>)  
**Issue:** `term.exit` handler only applies `exitCode/signal`; it does not change state. Current backend sends `term.status` immediately before `term.exit`, so normal flow works, but `term.exit` is not independently meaningful.  
**Fix:** Either remove `term.exit` and rely on `term.status`, or include `state` in `ExitMsg` and have frontend set terminal state there.

### LOW
**File:line:** [theme.ts](<C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/stores/theme.ts:14>), [settings.routes.ts](<C:/Users/serkan/Desktop/Kaplan/apps/backend/src/http/settings.routes.ts:16>), [themes.ts](<C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/theme/themes.ts:84>)  
**Issue:** Theme persistence works on the happy path, but failures are swallowed and backend accepts any theme string while frontend silently falls back. That can leave persisted settings and displayed theme divergent.  
**Fix:** Report/revert failed `theme.set()` persistence, and validate theme ids through a shared allowlist or normalize unknown persisted ids.

## Contract Summary

REST paths/verbs in `useApi.ts` match backend routes for terminals, groups, settings, and fs helpers. Main REST flow gap is settings defaults being bypassed by create-terminal UI.

WS message names match backend dispatch, but the frontend does not consume the full payload contract for `term.status`, `term.snapshot`, `term.attached`, `term.broadcastResult`, `term.error`, and `term.exit`.

Verification: `npm run typecheck` passed for the backend. No frontend typecheck/test script exists in the repo.