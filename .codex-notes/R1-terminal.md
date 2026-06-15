**Findings**

1. **HIGH** `apps/backend/src/terminal/TerminalSession.ts:102`  
   `start()` is not serialized. Two concurrent starts can both pass `isAlive()` before `validateCwd()` completes, spawning two PTYs. The later spawn overwrites `this.proc`, while callbacks from the earlier PTY can still append output and later call `handleExit()`, clearing the current process state.  
   **Fix:** add a per-session lifecycle mutex/operation queue. Also attach a generation token or captured `proc` identity to `onData`/`onExit` and ignore events from stale PTYs.

2. **HIGH** `apps/backend/src/terminal/TerminalSession.ts:171`  
   `stop()` can lose races with `start()`/`restart()`. If `stop()` runs while `start()` is still validating/spawning, it sees no live proc, sets `stopped`, and returns; the in-flight start can then spawn anyway.  
   **Fix:** serialize all `start`/`stop`/`restart` operations through the same queue, and allow stop to cancel or supersede a pending start before spawn.

3. **HIGH** `apps/backend/src/terminal/TerminalSession.ts:196`  
   Graceful-stop timeout force-kills and resolves immediately without waiting for the PTY exit. `restart()` then starts a new PTY while the old one may still be alive; the old `onExit` later runs `handleExit()` and can mark the new session exited/null.  
   **Fix:** after timeout, call force kill, then wait for the matching old PTY’s exit with a bounded second wait before returning or restarting. Guard exit handling by proc/generation.

4. **HIGH** `apps/backend/src/terminal/TerminalSession.ts:222`  
   Windows `taskkill` is fire-and-forget. `spawnChild()` async errors are not handled, non-zero exit is ignored, and `stop()` assumes the tree is gone even if `taskkill` failed.  
   **Fix:** make `forceKill` async on Windows. Spawn with `stdio: 'ignore'`, listen for `error` and `close`, await completion, and fall back to `this.proc?.kill()` or report failure on non-zero exit codes that are not “already gone”.

5. **MEDIUM** `apps/backend/src/terminal/TerminalSession.ts:280`  
   `handleExit()` always sets state to `exited`, even for user-initiated stop/force kill. In the timeout and force paths, `stop()` sets `stopped` first, then the later exit event flips the terminal back to `exited`, contradicting the comment at line 286.  
   **Fix:** track `stopping`/`stopRequested` internally, or add a real `stopping` state. When the exiting proc matches the stopped proc, final state should remain `stopped`.

6. **MEDIUM** `apps/backend/src/terminal/TerminalSession.ts:139`  
   The initial-command timer is not tied to the PTY generation and is not cleared on stop/restart. A quick restart can cause the old timer to write the old initial command into the new shell.  
   **Fix:** store the timer and clear it on stop/exit/restart, or capture the proc/generation and only write if it still matches.

7. **LOW** `apps/backend/src/terminal/TerminalSession.ts:257`  
   `scrollbackBytes` and `outputFlushBytes` are enforced with JS string length, not bytes. Unicode output can exceed the intended byte budget, and slicing can split surrogate pairs.  
   **Fix:** either rename these limits to chars/code units, or maintain scrollback with byte-aware buffering and decode on valid UTF-8 boundaries.

8. **LOW** `apps/backend/src/terminal/TerminalSession.ts:282`  
   `pid` is never cleared on exit/stop/failure, so stopped or exited statuses can expose a stale PID.  
   **Fix:** set `this.pid = undefined` when the matching PTY exits or spawn fails, unless the API intentionally wants historical PIDs.