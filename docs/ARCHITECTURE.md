# Kaplan Architecture

Kaplan is an npm-workspaces monorepo: a TypeScript **backend** that owns OS processes and a
Nuxt **frontend** that renders them. This document explains how the pieces fit; per-domain
detail lives next to the code.

## High-level shape

```
┌────────────────────────────┐         REST (control)          ┌─────────────────────────────┐
│  Frontend (Nuxt 4 / Vue 3) │ ──────────────────────────────► │  Backend (Express 5)        │
│  Pinia stores per domain   │ ◄────────────────────────────── │  REST routers + services    │
│  xterm.js terminals        │         WebSocket (data)        │  TerminalManager (node-pty) │
└────────────────────────────┘ ◄──────────────────────────────►│  Orchestrators (Tiger/Team) │
                                                                 │  MySQL (system of record)   │
                                                                 └─────────────────────────────┘
```

**Two planes:**

- **Control plane = REST.** Create/start/stop/configure. Side-effecting, request/response.
- **Data plane = WebSocket.** Live terminal output and run-state updates are *pushed*; the
  frontend never polls for live data. On (re)connect the client re-attaches and reconciles a
  full snapshot, so output isn't double-delivered.

## Backend (`apps/backend`)

- **`terminal/`** — `TerminalManager` (registry + input routing to `selected`/`group`/`all`,
  protected-terminal exclusion) over `TerminalSession` (one PTY each, all operations
  serialized through a promise lock, each PTY generation-tagged so stale events can't corrupt
  newer state).
- **`orchestrator/`** — the **Tiger** staged pipeline (brainstorm → plan → tasks → merge →
  execute → review). Agents run as *interactive* CLIs in real PTYs (not headless); completion
  is detected via a `.done` marker with output-idle + timeout fallbacks. Fan-out stages run
  bounded-concurrency agent pools; tasks/findings are claimed via atomic file rename.
- **`team/`** — the **AI Team** run engine (`TeamOrchestrator`). A Lead coordinates role
  agents that run as *persistent* per-role CLI sessions (context preserved across turns). A
  file task board (todo/in-progress/done) drives delegation; a pure, code-enforced done-gate
  decides completion (all tasks done + verification passed + every required role holds a fresh
  sign-off). *Stop* pauses (sessions alive); *Close* ends (sessions killed).
- **`queue/` + `services/QueueService.ts`** — a durable MySQL-backed command queue with a
  single-worker scheduler, lease + heartbeat, crash-recovery (stale-lease reclaim), and
  limit-aware dispatch.
- **`services/`, `repositories/`, `db/`** — prompt generation, limits probing, template CRUD;
  MySQL repositories; pool + idempotent migrations keyed in `schema_migrations`.
- **`http/`, `ws/`** — Express routers and the WebSocket hub (origin allowlist, heartbeat,
  per-peer backpressure drop, snapshot-on-attach).

**Durability:** MySQL is the system of record. The backend migrates on boot and *fails fast*
if the DB is unreachable. A small amount of UI/terminal-definition state also lives in a
defensively-validated JSON state file (atomic writes, corruption quarantine + `.bak`).

## Frontend (`apps/frontend`)

- **`pages/`** — one route per domain (terminals, team, tiger, queue, prompts, limits, …).
- **`stores/`** — one Pinia store per domain; the single source of truth the components read.
- **`composables/`** — `useApi` (typed REST client), `useSocket` (singleton multiplexed WS
  with exponential-backoff reconnect), `useTerminalView` (lazy xterm mount + ref-counted
  attach).

## Invariants worth knowing

- **Single authoritative writer** per persisted artifact (e.g. the `TeamOrchestrator` is the
  only writer of `conversation.jsonl`; the runner only parses and returns).
- **An agent's output may only ever speak as itself** — the message bus forces a message's
  `from` and a sign-off's `roleId` to the executing role, so one agent can't impersonate
  another to self-assign work or sign off on its behalf.
- **One run per workspace** is enforced by a MySQL execution lease (with heartbeat) shared by
  Tiger and Team, so the two can't drive the same `.tiger` root simultaneously.

For the gap analysis and what's planned next, see [`ROADMAP.md`](ROADMAP.md).
