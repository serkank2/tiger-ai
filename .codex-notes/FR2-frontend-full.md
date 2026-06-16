**Findings**

1. **MEDIUM** [SettingsModal.vue](C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/components/SettingsModal.vue:49)  
   `checkCwd()` can mark the default cwd as bad, but `save()` never blocks on `cwdState === 'bad'`. Backend settings persistence also accepts any non-empty `defaultCwd`, so an invalid default can be saved and later break new terminal creation/start flows.  
   **Fix:** mirror `TerminalEditModal`: before saving, reject `bad`, and ideally await/re-run validation for a changed non-empty cwd.

2. **MEDIUM** [theme.ts](C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/stores/theme.ts:14)  
   Theme persistence is fire-and-forget and concurrent. Rapid theme clicks can send overlapping `settings.update({ theme })` calls; a slower older request can win on the backend, so the visible theme and persisted theme diverge. Errors are also swallowed, so reload may silently revert.  
   **Fix:** serialize/debounce theme writes, track a request token, and surface persistence failure via `notices.push(...)`.

3. **LOW** [app.vue](C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/app.vue:24)  
   `Promise.all([terminals.fetchAll(), groups.load(), settings.load()])` rejects on the first failure, then `theme.init(settings.settings?.theme)` runs immediately. If `settings.load()` is still pending and later succeeds, the persisted theme is not applied because there is no watcher.  
   **Fix:** use `Promise.allSettled`, then initialize theme after the settings promise has settled, or watch `settings.settings?.theme` once on initial load.

4. **LOW** [useSocket.ts](C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/composables/useSocket.ts:129)  
   `term.error` with `UNKNOWN_TERMINAL` calls `void terminals.fetchAll()` without a catch. If the backend is unreachable during that recovery fetch, this can produce an unhandled promise rejection.  
   **Fix:** `void terminals.fetchAll().catch(() => {});` or route through a guarded resync helper.

5. **LOW** [TerminalEditModal.vue](C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/components/TerminalEditModal.vue:40)  
   Cwd validation is race-prone. Two blur validations can resolve out of order, and `save()` allows `cwdState === 'checking'`, so the UI can show stale validation or submit before the latest validation completes. Backend validation limits the damage, but the modal state can mislead users.  
   **Fix:** track a validation sequence/current path and ignore stale results; in `save()`, await validation for the current cwd before submitting.

**Solid Areas**

`useTerminalView` is generally solid: teardown disposes xterm, resize observer, subscriptions, xterm disposables, rAF, and WS attach state; the mount token protects rapid terminal switches. The WS singleton and ref-counted attach/detach design is sound for focus/grid swaps and reconnect reattach. Grid tiling is simple and stable for desktop layouts, with no obvious listener leak. Theme live recolor works through CSS variables plus the xterm theme watcher; the main gap is persistence reliability.