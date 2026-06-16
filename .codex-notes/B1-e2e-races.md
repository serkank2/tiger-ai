**Findings**

1. **HIGH** - Delete can race with start/restart and spawn an orphaned PTY  
   [apps/backend/src/http/terminals.routes.ts:132](/C:/Users/serkan/Desktop/Kaplan/apps/backend/src/http/terminals.routes.ts:132), [TerminalManager.ts:118](/C:/Users/serkan/Desktop/Kaplan/apps/backend/src/terminal/TerminalManager.ts:118), [TerminalSession.ts:126](/C:/Users/serkan/Desktop/Kaplan/apps/backend/src/terminal/TerminalSession.ts:126)  
   Trigger: terminal is running. Window A deletes it. While `DELETE` is awaiting `manager.remove()`, Window B clicks Start/Restart or sends a routed command with `startTerminalOnSend`. The definition still exists in `ctx.state.terminals` and `manager.defs`, so start is accepted and queued behind `dispose()`. `dispose()` removes manager listeners, `remove()` deletes the session from maps, then queued `startImpl()` can still spawn a PTY on the now-untracked `TerminalSession`. Result: process has no manager entry, no output/status fanout, and no UI control.  
   Fix: make delete a terminal-level exclusive operation. Mark/remove the definition from `state` and `manager.defs` before awaiting process disposal, reject future lifecycle calls for tombstoned ids, and/or use a per-terminal mutex covering route existence checks plus manager lifecycle. Do not allow `start/restart/routeInput` to enqueue behind `dispose()` for a deleted id.

2. **MEDIUM** - Attach/reconnect can duplicate recent output  
   [apps/backend/src/terminal/TerminalSession.ts:325](/C:/Users/serkan/Desktop/Kaplan/apps/backend/src/terminal/TerminalSession.ts:325), [TerminalSession.ts:330](/C:/Users/serkan/Desktop/Kaplan/apps/backend/src/terminal/TerminalSession.ts:330), [apps/backend/src/ws/socket.ts:101](/C:/Users/serkan/Desktop/Kaplan/apps/backend/src/ws/socket.ts:101), [socket.ts:109](/C:/Users/serkan/Desktop/Kaplan/apps/backend/src/ws/socket.ts:109)  
   Trigger: terminal emits data, `handleData()` appends it to `ring` and `pending`, but the 16ms flush timer has not fired. A browser attaches/reconnects in that window. Snapshot reads `ring`, so it includes the pending bytes. The later flush emits the same pending bytes as `term.output` to the attached peer. Result: duplicated output in xterm.  
   Fix: flush pending output before producing an attach snapshot, ideally before adding the new peer to `attached`, or expose an atomic `takeSnapshot()` that drains pending output and returns the buffer.

3. **HIGH** - WebSocket reconnect does not replay global statuses, leaving sidebar states stuck  
   [apps/frontend/app/composables/useSocket.ts:31](/C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/composables/useSocket.ts:31), [useSocket.ts:39](/C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/composables/useSocket.ts:39), [apps/frontend/app/stores/terminals.ts:43](/C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/stores/terminals.ts:43)  
   Trigger: two terminals are running; A is active/attached, B is inactive. WS disconnects or backend restarts; B exits/stops while disconnected. On reconnect, the client only re-attaches ids in the local `attached` set, usually just A. `refreshPreviews()` explicitly avoids status updates. Result: B can remain shown as running forever.  
   Fix: on every WS open/reconnect, fetch the full terminal list or have the backend send a full status snapshot. Merge `status` in `refreshPreviews()` or rename/split that function so there is a real periodic/status reconciliation path.

4. **HIGH** - Multiple browser windows do not receive create/update/delete definition changes  
   [apps/backend/src/http/terminals.routes.ts:126](/C:/Users/serkan/Desktop/Kaplan/apps/backend/src/http/terminals.routes.ts:126), [apps/frontend/app/stores/terminals.ts:60](/C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/stores/terminals.ts:60), [apps/backend/src/ws/socket.ts:122](/C:/Users/serkan/Desktop/Kaplan/apps/backend/src/ws/socket.ts:122)  
   Trigger: Window A deletes a terminal. Window B still has the DTO in Pinia. If it was already attached, no `UNKNOWN_TERMINAL` is sent; keystrokes are silently dropped by `manager.write()`. Start/restart from Window B returns REST 404, but the store does not reconcile the list. Result: stale ghost terminal and lost input.  
   Fix: broadcast definition mutations over WS (`term.created`, `term.updated`, `term.deleted`) or trigger `fetchAll()` on relevant REST 404s and WS write/resize to unknown ids. Backend `term.input` for unknown/deleted ids should return `term.error` instead of silently ignoring.

5. **MEDIUM** - Starting a stopped terminal from the pane uses stale/default PTY dimensions  
   [apps/backend/src/terminal/TerminalManager.ts:96](/C:/Users/serkan/Desktop/Kaplan/apps/backend/src/terminal/TerminalManager.ts:96), [apps/frontend/app/components/TerminalPane.vue:109](/C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/components/TerminalPane.vue:109), [TerminalPane.vue:158](/C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/components/TerminalPane.vue:158)  
   Trigger: open a stopped terminal in a wide pane. The frontend sends resize before start, but backend drops it because no session exists. Clicking Start calls `terminals.start(active.id)` without cols/rows. Result: PTY starts at 80x30 until a later resize happens, causing wrong wrapping and initial-command output layout.  
   Fix: pass current xterm `{ cols, rows }` to start/restart from `TerminalPane`, or have `TerminalManager.resize()` remember desired size per terminal even when no live session exists.

**Solid Areas**

Normal start/stop/restart on one terminal is mostly well guarded: lifecycle operations are serialized in `TerminalSession`, stale PTY callbacks are generation-checked, and reconnect snapshots intentionally reset the xterm view. The serious issues are at system boundaries: delete versus later lifecycle calls, attach versus buffered flush, reconnect reconciliation, and multi-window metadata sync.

Review was static only; I did not run tests because the repo has no test/spec files.