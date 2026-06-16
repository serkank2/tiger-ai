## Findings

- **MEDIUM** `apps/frontend/app/composables/useSocket.ts:135` / `apps/frontend/app/composables/useSocket.ts:139`  
  **Issue:** `attached` is a plain `Set<string>`, not reference-counted. If two `useTerminalView` instances ever bind the same terminal ID, teardown of one sends `term.detach` and removes the ID from reconnect state while the other view still has live local listeners.  
  **Fix:** Track `Map<termId, count>`. Send attach only on `0 -> 1`, detach only on `1 -> 0`, and reconnect IDs with count > 0.

- **MEDIUM** `apps/frontend/app/components/TerminalGrid.vue:30` + `apps/frontend/app/composables/useTerminalView.ts:90`  
  **Issue:** Grid eagerly mounts a full xterm instance per tile, including addons, 8000-line scrollback, listeners, ResizeObserver, attach, and snapshot replay. With 9+ tiles, mode switches/reconnects can replay many full buffers and hitch the UI.  
  **Fix:** Lazy-mount/virtualize visible tiles, cap grid tile count, batch/defer attaches, and consider a lighter grid profile: lower scrollback and skip `WebLinksAddon`.

- **LOW** `apps/frontend/app/composables/useTerminalView.ts:116` / `apps/frontend/app/composables/useTerminalView.ts:130`  
  **Issue:** Every tile has its own `ResizeObserver`; each callback calls `fit()`, which can drive `onResize` and send `term.resize`. Grid relayout/window resize can burst resize frames across all tiles.  
  **Fix:** rAF-throttle `safeFit`, cache last `{ cols, rows }`, and only send `socket.resize` when dimensions actually change.

## Solid

Lifecycle cleanup is mostly correct: output/snapshot unsubscribes, xterm data/resize disposables, `ResizeObserver`, terminal instance, and mousedown handler are all torn down in `useTerminalView.ts:58`.

Mount-token handling is sound for rapid active-ID changes and unmounts: stale async mounts are cancelled, and later mounts call teardown before taking ownership.

Backend fan-out supports multiple different terminal IDs on one shared WebSocket: per-peer attached sets and per-terminal output routing make simultaneous grid attach/snapshot workable.