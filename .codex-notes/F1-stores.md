**Findings**

- **MEDIUM** [terminals.ts:68](C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/stores/terminals.ts:68): `applyStatus()` leaves stale lifecycle fields. Server status frames omit `pid` when undefined, so old PIDs survive `starting`/`exited`/`stopped`; exit fields can also remain stale across a new run. `applyExit()` also relies on a separate prior status event for final state.  
  **Fix:** send/apply full `TerminalStatus` for WS status/exit/attached, or at minimum always clear/set `pid`, clear `exitCode/signal/error/endedAt` on `starting`/`running`, and include final state in exit handling.

- **MEDIUM** [groups.ts:23](C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/stores/groups.ts:23): deleting a group only updates `groups`; backend also nulls terminal `groupId`s. The frontend terminal store keeps stale group ids, and `commandGroupId` can keep pointing at the deleted group, causing UI counts to disagree with backend routing.  
  **Fix:** after delete, update `useTerminalsStore()` too: null matching terminal `groupId`s or `fetchAll()`, and clear/switch `commandGroupId` when it matches the deleted id.

- **LOW** [terminals.ts:100](C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/stores/terminals.ts:100): `buildTarget()` can return invalid semantic targets: group mode emits `groupId: ''`, selected mode can emit empty/stale ids. Current `CommandBar` guards some cases, but the store API itself is unsafe.  
  **Fix:** return `CommandTarget | null` or throw for invalid state; filter selected ids through `byId`, require a real group id, and make callers send only non-null targets.

- **LOW** [terminals.ts:22](C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/stores/terminals.ts:22): `fetchAll()` does not reconcile existing `activeId` or `selectedIds` against the fetched list. A refresh after external/server-side deletion can leave stale ids.  
  **Fix:** after assigning `items`, build a valid-id set, filter `selectedIds`, and set `activeId` to itself only if valid, otherwise first terminal or `null`.

No critical/high issues found. The `byId` computed-map mutation pattern is reactive here: the map values are the reactive array element proxies, so mutating `t.status`/`t.lastOutput` through `byId.value[id]` holds reactivity. Local `remove()` also handles active/selected cleanup correctly for the normal delete path.