# Kaplan — Local Terminal Manager — Design Spec

**Date:** 2026-06-15
**Status:** Approved-to-build (user directive: proceed without per-question approval)
**Scope:** Local, single-user, personal-use terminal management panel. **No** auth, roles, multi-user, cloud sync, or team features.

## 1. Goal

A locally-running app to create, name, group, and control many terminal processes from one UI. Each terminal can run in its own folder, optionally auto-run a startup command (e.g. `npm run dev`, `claude`, `codex`), stream output live, and be used as a **fully interactive terminal** (real pty, not just a command sender). Send a command to selected terminals, to a whole group, or to all. Start / stop / restart / close processes and see their status.

## 2. Architecture — Option B (separate backend + Nuxt frontend)

Decision (synthesized from Codex T3, accepted): split into two local processes.

```
kaplan/                      # repo root (npm workspaces)
  package.json               # workspaces + concurrently dev script
  apps/
    backend/                 # Node + TypeScript (run via tsx), owns ptys
      src/
        index.ts             # bootstrap: express + ws + load state
        config.ts            # paths, ports, env overrides
        http/                # REST control-plane (Express)
          terminals.routes.ts
          groups.routes.ts
          settings.routes.ts
          fs.routes.ts       # validate/browse cwd
        ws/
          socket.ts          # ws server, attach/detach, protocol dispatch
          protocol.ts        # message types (shared shape)
        terminal/
          TerminalSession.ts # one pty + ring buffer + status
          TerminalManager.ts # registry, lifecycle, routing (selected/group/all)
        store/
          state.ts           # atomic JSON persistence (definitions/groups/settings)
          types.ts           # PersistedState + runtime types
    frontend/                # Nuxt 3 + Pinia + xterm.js (UI only)
      nuxt.config.ts
      app.vue
      pages/index.vue
      components/...          # see §6
      composables/
        useSocket.ts          # one WebSocket per window
        useXtermManager.ts    # client-only xterm instance registry
      stores/
        terminals.ts          # definitions + selection + status
        connection.ts         # ws connection state
        preferences.ts        # layout/theme/font
```

**Rationale:** native pty stays out of the Vite/Nitro build pipeline; terminals stay alive while the UI restarts; one process owns terminals, one owns UI → clearer debugging. Both are local, started together with one command.

- Backend: `http://localhost:4517` (REST) + `ws://localhost:4517/ws` (WebSocket).
- Frontend (Nuxt dev): `http://localhost:3000`, talks to backend via configurable base URL.

## 3. Backend: terminal/process management

- **pty package: `node-pty`.** Empirically verified to install (prebuilt binary, no compile) and run on Node v25.2.1 / Windows 11. Cross-platform.
- `TerminalSession` owns one `IPty`: spawn(shell, args, {cwd, env, cols, rows}), `onData` → coalesced output (flush every ~16ms or 16–64KB) → ring buffer (bounded, e.g. last ~256KB) + broadcast to attached ws peers; `write`, `resize`, `kill`. Tracks status + exitCode.
- **Status model:** `starting | running | exited | failed | stopped`.
- **Initial command:** after spawn, if `initialCommand` set, write `initialCommand + os.EOL` once shell is ready.
- **Kill (Windows pitfall):** kill the **process tree**, not just the shell. `pty.kill()` alone does not clean the tree on Windows; run `taskkill /PID <pid> /T /F` via `spawn('taskkill', args, { windowsHide: true })` as the reliable force-kill.
- **cwd validation:** before spawn, verify the path exists and is a directory (via `fs.stat`); normalize Windows drive/UNC paths; reject invalid cwd instead of silently falling back.
- **env (Windows footgun, from Codex T1):** always merge the definition's `env` on top of `process.env` as the base — never replace it. Missing `SystemRoot`/`WINDIR`/`ComSpec`/`Path`/`USERPROFILE` breaks PowerShell spawn.
- **Graceful stop sequence:** write `\x03` (Ctrl+C), optionally `exit` + EOL, wait briefly, then force `taskkill /PID <pid> /T /F` if still alive.
- **Restart:** kill + re-spawn from the same definition (fresh pty, cleared buffer, replays initialCommand).
- **Autostart:** on backend launch, auto-start terminals whose definition has `autostart: true`.

## 4. Real-time transport

- **Library: `ws`** (standalone) hosted on the backend. (Codex T2 recommended Nitro WS, but that assumes a single Nuxt app; since we chose the separate-backend architecture, `ws` on the backend is the consistent choice. We **adopt T2's protocol**, just on a different host.)
- One WebSocket per browser window; terminals multiplexed by `termId`.
- **Message protocol (JSON envelope `{type, termId?, id?, ts?}`):**
  - Client→server: `term.attach` (replays recent buffer then streams live), `term.detach`, `term.input` (raw keystrokes/data), `term.resize {cols,rows}`, `term.broadcastInput {target:{mode:selected|group|all, termIds?|groupId?}, data}`, `ping`.
  - Server→client: `term.attached {status,cols,rows}`, `term.output {data}`, `term.status {status}`, `term.exit {exitCode,signal}`, `term.error {code,message}`, `term.broadcastResult {matched,written,failed[]}`, `pong`.
- **v1 simplifications (KISS/YAGNI):** keep output coalescing, bounded server-side ring buffer (replayed on attach), and heartbeat ping/pong. **Defer** the seq-based resync / backpressure-drop machinery (unnecessary on local loopback).

## 5. Data model + persistence

- **Storage: raw JSON file, atomic write** (write `.tmp` → fsync → rename; keep `.bak`; on corruption fall back to `.bak`, else preserve `state.corrupt.<ts>.json` and start fresh).
- **Location:** OS app-data dir by default (`%APPDATA%\kaplan\state.json` on Windows), overridable via `KAPLAN_DATA_DIR`. Path is logged on startup so it's findable.
- **Persisted** (`schemaVersion: 1`): `terminals[]`, `groups[]`, `settings`. **Live** process state (status, pid, exitCode, scrollback) is in-memory only.

```ts
interface TerminalDefinition {
  id: string; name: string;
  groupId: string | null;
  cwd: string; initialCommand?: string;
  shell: { kind: 'system-default'|'powershell'|'pwsh'|'cmd'|'bash'|'zsh'|'fish'|'custom'; path?: string; args?: string[] };
  env?: Record<string,string>;
  autostart?: boolean;
}
interface TerminalGroup { id: string; name: string; color?: string }
interface AppSettings {
  theme: 'system'|'light'|'dark';
  defaultCwd: string;
  defaultShell: TerminalDefinition['shell'];
  confirmBeforeKill: boolean;
  startTerminalOnSend: boolean;     // default false
  appendNewlineByDefault: boolean;  // default true
}
```

## 6. Command routing + selection (user's spec wins over Codex T4)

The UI supports **multi-selection** (a set of terminal ids), not just one focused terminal. Command target modes:
- **selected** → all `selectedTerminalIds`
- **group** → all terminals with matching `groupId`
- **all** → every defined terminal

Per-target behavior: if running → write to pty; if not running and `startTerminalOnSend` → start then write; else skip and report "not running" in `broadcastResult.failed`. Routing uses stable ids, never names. `appendNewlineByDefault` controls whether a newline is appended (so a sent command actually executes).

## 7. Frontend (Nuxt 3 + Pinia + xterm.js)

- **Layout (Codex T5, accepted): top command bar + left grouped sidebar + main interactive terminal pane.** Tabs/grid rejected (don't scale past ~5 terminals). Split panes = later optional mode.
- **Sidebar:** terminals grouped by group; each row shows name, cwd, status dot, last-output preview, and a **multi-select checkbox**; lifecycle buttons (start/stop/restart/close).
- **Main pane:** xterm.js mounted for the active terminal; live output + full keyboard input; FitAddon for resize → emits `term.resize`.
- **Command bar:** target selector (selected / group / all) + command input → `term.broadcastInput`.
- **Create/Edit modal:** name, group, cwd (text input + backend validation; browse endpoint later), initial command, shell, autostart.
- **State:** Pinia stores hold serializable metadata/selection/connection only. **xterm instances live in a client-only `useXtermManager` registry**, never in Pinia (`markRaw` if ever referenced). v1 mount policy: keep the active terminal mounted; recreate + replay buffer on switch. (Defer the idle-dispose-timeout optimization.)
- **Status indicators:** running / exited / failed / stopped with color coding.

## 8. Tooling / run

- **npm workspaces** (npm 11 present; no pnpm dependency). Root `dev` script runs backend (`tsx watch`) + frontend (`nuxt dev`) together via `concurrently`.
- Backend in **TypeScript via `tsx`** (no build step in dev). Frontend is Nuxt 3 (TS native).
- One command (`npm run dev`) brings the whole panel up.

## 9. Working method (per user directive)

Claude is the lead/integrator and the only reliable file-writer; Codex is a parallel assistant used for (a) architecture alternatives [done: 5 parallel tasks], (b) reviewing Claude's code, and (c) optionally generating well-bounded modules — **every Codex output is critically reviewed by Claude before adoption**, never accepted blindly. Build in milestones, each followed by a parallel Codex review pass.

## 10. Out of scope (YAGNI)

Auth, roles, multi-user, cloud sync, team features, seq-based WS resync, backpressure dropping, idle xterm dispose timers (v1), GUI folder picker beyond a validated text input (v1).
