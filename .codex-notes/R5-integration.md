**Findings**

- **CRITICAL** `apps/backend/src/ws/socket.ts:17` - REST CORS is allowlisted, but the WebSocket server accepts any browser `Origin`. CORS does not protect WS, so another site could connect to `ws://localhost:4517/ws` and send input to running terminals.  
  **Fix:** enforce the same `config.corsOrigins` allowlist during WS upgrade/connection, optionally allowing missing `Origin` for non-browser local clients.

- **HIGH** `apps/backend/src/terminal/TerminalSession.ts:222` - Windows `taskkill` is fire-and-forget. `killAll()` and shutdown can finish before the process tree is actually killed, and async `taskkill` failures never fall back to `pty.kill()`.  
  **Fix:** make `forceKill` async, await `taskkill` `close/error` with a short timeout, fall back to `this.proc?.kill()`, and only resolve shutdown after kill completion.

- **HIGH** `apps/backend/src/terminal/TerminalSession.ts:206` - user stop can be overwritten by `handleExit()` at `TerminalSession.ts:280`, which always sets state to `exited`. Timeout/force-stop paths mark `stopped` before the pty exit event arrives, then later become `exited`.  
  **Fix:** track `stopRequested`/`disposeRequested`; have `handleExit()` emit `stopped` for user-initiated stops and `exited` only for natural exits.

- **MEDIUM** `apps/backend/src/index.ts:54` - autostart is launched with `void manager.autostartAll()` and is not tracked or cancellable. Shutdown during autostart can race with terminals still being started.  
  **Fix:** keep an `autostartPromise` and/or pass an abort/shutdown guard into `autostartAll()` so no new sessions start after shutdown begins.

- **MEDIUM** `apps/backend/src/terminal/TerminalManager.ts:69` - stopping an existing terminal that has never been started throws `no session`, producing a 500 from `POST /api/terminals/:id/stop`. Stop should be idempotent.  
  **Fix:** if the definition exists but no session exists, return a `stopped` runtime status instead of throwing.

- **MEDIUM** `apps/backend/src/terminal/TerminalSession.ts:105` - invalid cwd failures happen before the `try`, so failed autostarts remain `stopped` with no recorded error, contrary to the spec’s `failed` status model.  
  **Fix:** move cwd validation into the guarded startup path and set `errorInfo` + `failed` for all startup failures.

- **LOW** `apps/backend/src/store/types.ts:51` - `AppSettings` nests routing flags under `commandRouting`, but the approved spec defines `startTerminalOnSend` and `appendNewlineByDefault` as top-level settings.  
  **Fix:** either align the backend schema/API to the spec or update the spec/frontend contract consistently.

**Single Most Important Thing**

Fix the WebSocket origin check first. It is the only issue that can let an unrelated browser page send commands into local terminals.

Typecheck passed: `npm run typecheck -w @kaplan/backend`.