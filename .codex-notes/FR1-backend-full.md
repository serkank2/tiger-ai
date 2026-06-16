**Findings**

1. **HIGH** `apps/backend/src/http/terminals.routes.ts:105`  
   Rejected `PUT /api/terminals/:id` requests can still mutate live state. `def.name` and sometimes `def.groupId` are changed before later validation can return `400` at lines 108 or 116. Because manager definitions share the same object, rejected requests can affect command routing and later persistence.  
   **Fix:** validate into a patch object first, then apply mutations only after all validations pass.  
   **False-positive risk:** low.

2. **HIGH** `apps/backend/src/index.ts:30`, `apps/backend/src/ws/socket.ts:41`  
   Requests with no `Origin` are always trusted. That is only safe while bound to loopback; if `KAPLAN_HOST=0.0.0.0`, remote non-browser clients can drive terminals with no Origin header.  
   **Fix:** allow no-Origin requests only when `req.socket.remoteAddress` is loopback, or require an auth token whenever binding non-loopback. Apply the same check to WS upgrades.  
   **False-positive risk:** medium if this app is guaranteed to stay on `127.0.0.1`.

3. **MEDIUM** `apps/backend/src/store/state.ts:47`, `apps/backend/src/terminal/TerminalSession.ts:189`, `apps/backend/src/terminal/TerminalSession.ts:323`  
   Persisted terminal definitions bypass the `util/paths.ts` guard. `loadState()` accepts arbitrary terminal objects, and pty launch only does `fs.stat(cwd)`, not `safeDirPath()` / `resolveExistingDir()`. A malformed or legacy state file can reintroduce relative, UNC, or otherwise unnormalized cwd values.  
   **Fix:** deep-validate state on load and also call the shared cwd resolver immediately before spawn, then spawn using the normalized returned path.  
   **False-positive risk:** low for API-created terminals, medium for hand-edited or migrated state.

4. **MEDIUM** `apps/backend/src/terminal/TerminalSession.ts:237`  
   `stopImpl()` can report `stopped` even if the forced kill did not actually produce an exit event. In that case `proc`, pty listeners, and possibly the child process remain alive; a later restart can overwrite `this.proc` and orphan the old pty callbacks/process.  
   **Fix:** make the final `waitForExit()` result authoritative. If force-kill times out, surface a failed/kill-timeout state and do not allow a new generation to start until the old process is confirmed gone or explicitly detached with cleaned listeners.  
   **False-positive risk:** medium; depends on how reliably `node-pty` kills the platform/process tree.

5. **MEDIUM** `apps/backend/src/terminal/TerminalManager.ts:184`  
   Command routing reports `written += 1` even if the terminal exits between `hasSession()`/`start()` and `write()`. `write()` is void and silently drops data when the pty is gone.  
   **Fix:** have `TerminalSession.write()` / `TerminalManager.write()` return boolean or throw; re-check after start and count only confirmed writes.  
   **False-positive risk:** low.

6. **MEDIUM** `apps/backend/src/ws/socket.ts:69`  
   Backpressure handling silently drops output for lagging peers, but the peer stays attached and is never told it is desynchronized. The comment says snapshot recovers it, but no automatic reattach/resync occurs.  
   **Fix:** mark the peer/terminal as stale and either close the socket, send a `term.desync` requiring reattach, or automatically send a fresh snapshot once writable.  
   **False-positive risk:** low under heavy output or slow clients.

7. **LOW** `apps/backend/src/http/settings.routes.ts:19`  
   `defaultCwd` accepts any non-empty string, including relative paths or UNC paths. Terminal creation later validates it, so this mostly creates bad saved settings and confusing create failures.  
   **Fix:** use `resolveExistingDir()` here too and return `400` for invalid defaults.  
   **False-positive risk:** low.

8. **LOW** `apps/backend/src/terminal/TerminalManager.ts:165`  
   Selected command targets are not de-duped. A malformed WS message can send the same command to the same terminal multiple times and inflate `matched/written`.  
   **Fix:** normalize selected targets through `new Set()` and cap selected target count.  
   **False-positive risk:** low; normal UI probably sends unique IDs.

**Solid Areas**

- pty lifecycle serialization, generation checks, and delete/dispose guards are largely well-structured.
- Attach flush/snapshot dedup is sound: pending output is flushed before the new peer joins.
- `term.status` enrichment includes runtime state, pid, exit info, error, cols, and rows.
- Terminal create/update cwd validation and fs browse/validate routes correctly use `util/paths.ts`.
- File-level persistence is solid: serialized writes, snapshot-at-enqueue, temp write + fsync + rename, backup recovery.
- Graceful shutdown blocks new starts, waits for autostart, kills sessions, closes WS/HTTP, and has a safety exit timer.
- Typecheck passes: `npm run typecheck -w @kaplan/backend`.