No CRITICAL findings. Serious lifecycle risks remain.

- **HIGH** `apps/frontend/app/components/TerminalPane.vue:58`  
  **Issue:** `mount(id)` is async and unguarded. Rapid active-terminal switches can let an older `mount()` resume after a newer one, creating/attaching a stale xterm instance and overwriting shared `term/fit/ro/mountedId` state. This can cause double attach, missed detach, leaked terminal/addon/observer instances, or output routed to the wrong pane.  
  **Fix:** Add a monotonically increasing mount token or `AbortController`. After every `await`, bail if the token is stale; only assign globals after the mount is still current. Serialize teardown/mount per active id.

- **HIGH** `apps/frontend/app/components/TerminalPane.vue:101`  
  **Issue:** `watch()` plus `onMounted()` can call `mount()` independently, and neither awaits/cancels the previous call. This amplifies the async race during initial load, HMR, restored store state, or fast active-id changes.  
  **Fix:** Use one lifecycle path: create the watcher in `onMounted` with `{ immediate: true, flush: 'post' }`, stop it in `onBeforeUnmount`, and route all changes through the guarded mount token.

- **MEDIUM** `apps/frontend/app/components/TerminalPane.vue:82`  
  **Issue:** `socket.attach(id)` happens before the final post-DOM `fit()` and explicit `socket.resize()`. If the first `safeFit()` cannot measure correctly, the server may replay/stream against the wrong terminal size.  
  **Fix:** Open terminal, wait `nextTick()` plus `requestAnimationFrame`, run `fit()`, register output listener, send `socket.resize(id, term.cols, term.rows)`, then `socket.attach(id)` so replay starts after dimensions are known.

- **MEDIUM** `apps/frontend/app/components/TerminalPane.vue:89`  
  **Issue:** `ResizeObserver` is created after awaits without checking whether the mount is still current or the component is still mounted. A stale mount can observe the host after teardown/switch, and queued callbacks call global `safeFit()` against whatever `fit` currently points to.  
  **Fix:** Guard observer creation with the same mount token; capture the local `fit`/`term` in the callback or make `safeFit(token)` no-op for stale mounts. Disconnect before replacing globals.

- **LOW** `apps/frontend/app/components/TerminalPane.vue:87`  
  **Issue:** `term?.focus()` always steals focus on active-terminal changes, including programmatic changes or list/sidebar interactions.  
  **Fix:** Focus only on explicit terminal selection/open, or skip focus when `document.activeElement` is an input, textarea, button, or contenteditable element.