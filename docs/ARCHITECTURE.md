# Kaplan Architecture

Kaplan is an npm-workspaces monorepo: a TypeScript **backend** that owns OS processes (real
PTYs) and a Nuxt **frontend** that renders and steers them. This document is the deep-dive —
it explains how the pieces fit and why. Per-domain detail lives next to the code; per-domain
design notes are collected at the end.

> **⚠️ Doc drift notice.** The v1 staged **Tiger** pipeline and the role-based **AI Team**
> engine described in parts of this file have been **removed**. The current execution model
> is the headless **v2 Runs** engine — a WorkGraph of `plan → build → review` items with
> engine-run verification (`apps/backend/src/{run,agents,verify,context}`), documented in
> [`REDESIGN.md`](REDESIGN.md). Sections below still referencing Tiger/Team are being
> rewritten; [`AGENTS.md`](../AGENTS.md) is the accurate quick reference in the meantime.

## High-level shape

```
┌────────────────────────────┐         REST (control)          ┌─────────────────────────────┐
│  Frontend (Nuxt 4 / Vue 3) │ ──────────────────────────────► │  Backend (Express 5, ESM)   │
│  Pinia stores per domain   │ ◄────────────────────────────── │  REST routers + services    │
│  xterm.js terminals        │         WebSocket (data)        │  TerminalManager (node-pty) │
└────────────────────────────┘ ◄──────────────────────────────►│  Orchestrators (Tiger/Team) │
                                                                 │  Queue · Limits · MCP       │
                                                                 │  MySQL (system of record)   │
                                                                 └─────────────────────────────┘
```

### Two planes

- **Control plane = REST.** Create/start/stop/configure. Side-effecting, request/response,
  small JSON bodies. Routers live in `apps/backend/src/http/` and are mounted under `/api`.
- **Data plane = WebSocket.** Live terminal output and run-state updates are _pushed_; the
  frontend never polls for live data. On (re)connect the client re-attaches and reconciles a
  full snapshot, so output is never double-delivered. The hub lives in `apps/backend/src/ws/`.

This split keeps the control surface auditable and idempotent while letting the high-volume
byte stream and run-state deltas flow over a single multiplexed socket.

## Boot sequence & durability

MySQL is the **system of record**. `apps/backend/src/index.ts` runs migrations _before_ the
HTTP server listens and **fails fast** (`process.exit(1)`) if the DB is unreachable after the
retry window — Kaplan never silently boots on stale file state. After migration it:

1. Loads the defensively-validated JSON state file (atomic writes, corruption quarantine +
   `.bak`) for UI/terminal definitions.
2. Constructs the `TerminalManager`, the v2 `RunEngine`, the `ProviderConfigStore`, the
   `QueueService` + `Scheduler`, the `LimitService`, and the prompt-generation service — all
   sharing a single MySQL pool (`db/pool.ts`).
3. Installs middleware in order: per-request id + child logger + access log
   (`requestContext`), `helmet`, CORS, a server-side Origin guard, optional shared-token auth,
   and an optional per-IP rate limiter.
4. Exposes `/api/health/live` (always 200, no I/O), `/api/health/ready` (200 only when the DB
   pings), and `/api/metrics` (Prometheus text, or JSON via `?format=json`).
5. Starts the WS hub, the queue scheduler, limits probing, and (config-gated) the MCP server.

Shutdown is graceful: SIGINT/SIGTERM (and last-resort `unhandledRejection`/`uncaughtException`)
stop the scheduler, close MCP, abort running stages so no new agents spawn, close any live Team
run, kill all PTYs, close the DB pool, and exit — with a 2s safety-net timer.

## Backend (`apps/backend/src`)

### `agents/` + `run/` + `context/` + `verify/` — the v2 execution core

> **v2 (docs/REDESIGN.md) supersedes the PTY-driven Tiger/Team execution model below.** The
> legacy engines remain mounted while their surfaces migrate.

- **`agents/`** — headless provider drivers (`claude -p --output-format stream-json
--session-id/--resume`, `codex exec --json` / `exec resume`, `agy --print` + result-file
  fallback) that translate each CLI's machine output into normalized `AgentEvent`s. Completion is
  the provider's own result event + process exit — **no marker files, no output-idle heuristics,
  no trust-dialog keystrokes**. `SessionRegistry` stores provider session ids so follow-up turns
  resume the same session and send **only the new brief** (delta context).
- **`run/`** — the WorkGraph engine: a run is a dependency graph of `plan` / `build` / `review`
  items scheduled by a pure function. The planner's structured output (schema-enforced by the CLI)
  seeds the graph; builders execute tasks in resumed sessions; steering inserts a re-plan item at
  the next boundary (code, not a Lead chat turn). Control plane: `/api/runs`; data plane:
  `run.state` / `run.event` WS frames; per-turn usage/cost from the provider's own usage report.
- **`context/`** — briefs: a once-per-session preamble (goal + budgeted project map + contract)
  and per-turn task briefs of O(new information) — never O(history).
- **`verify/`** — Kaplan runs build/test/lint itself (`spawn`, no shell) and records exit codes;
  a red check retries the same session with the failing tail as evidence. The only source of
  "passed" anywhere is an exit code observed here.

### `terminal/` — the PTY model

`TerminalManager` is a registry over `TerminalSession`, where each session wraps exactly one
`node-pty` PTY. Key invariants:

- **Serialized operations.** Every operation on a session runs through a promise lock, so
  spawn/write/resize/kill can never interleave and corrupt state.
- **Generation tagging.** Each PTY is generation-tagged; events from a stale (killed/restarted)
  generation are ignored, so a late event can't corrupt newer state.
- **Input routing.** Input is fanned out to a target set — `selected`, a `group`, or `all` —
  with **protected-terminal** exclusion so a destructive broadcast can't hit a guarded session.

### Retired: the v1 Tiger staged pipeline and Team role-chat engine

Both v1 execution engines (interactive-PTY driving, `.done` markers, role-turn chat,
sign-off done-gate) were removed after the v2 core landed — see `docs/REDESIGN.md`
for the autopsy and `db/legacy-migrations.ts` for their preserved schema history.
The queue's `project`/`team` targets now dispatch onto the v2 run engine.

### `queue/` + `services/QueueService.ts` — durable command queue

A MySQL-backed job queue (`MysqlQueueRepository.ts`) dispatched by a single `Scheduler`:

- **Lease + SKIP LOCKED.** The dispatch query selects eligible jobs with
  `FOR UPDATE SKIP LOCKED`, so two schedulers running concurrently can never lease the same
  row. A leased job records `lease_owner` + `lease_expires_at`; a heartbeat keeps it alive.
- **Crash recovery.** A job whose lease has expired (owner gone, no live heartbeat) is
  reclaimed and re-dispatched.
- **Backoff / retry.** `attempts` vs `max_attempts` with backoff (`retry.ts`); exhausted jobs
  are parked, not spun.
- **Per-provider lanes.** `concurrency.ts` caps concurrency _per provider_
  (`claude`/`codex`/`antigravity`/`mixed`), env-tunable via `KAPLAN_QUEUE_CONCURRENCY_*`
  (default 1 each). `mixed` jobs occupy their own lane. This lets, e.g., 2 Claude + 2 Codex
  jobs run in parallel while bounding any single provider.
- **Limit-aware dispatch.** The scheduler consults the limit gate before leasing a provider's
  job (see below).

### `limits/` + `services/LimitService.ts` — usage gate

`LimitService` periodically probes each CLI provider's usage/quota and persists it; the
`StateLimitGate` (`gate.ts`) evaluates configurable rules (`rules.ts`) to return a
`LimitRuleDecision` for a provider. `resetParse.ts` parses provider "resets at …" text so a
blocked provider can auto-unblock at its reset. The queue scheduler and orchestrators call the
gate before dispatching a provider's work, so a rate-limited provider is held rather than
hammered.

### `obs/` — observability

- `logger.ts` — structured JSON logger; a per-request child logger (with `req.id`) is attached
  by the request-context middleware.
- `metrics.ts` — a lightweight registry rendered as Prometheus text (or JSON). Live gauges are
  computed from the real `ctx` on every scrape (never stale): `queue_depth`, `terminal_count`,
  `terminal_running_count`, `ws_peers`, uptime, and RSS.

### `security/` + `http/middleware/` — auth & origin

Loopback-binding plus a **server-side Origin allowlist** (CORS only blocks reading the
_response_; a simple cross-origin POST could still hit a route, so the Origin guard rejects
disallowed browser origins outright; non-browser local clients send no Origin and are allowed).
Optional shared-token auth (`KAPLAN_AUTH_TOKEN`) gates `/api/*` (no-op when unset; liveness is
always exempt), and an optional per-IP fixed-window rate limiter guards against abuse. A
client-supplied workspace path is validated by `security/workspace.ts` — UNC/device paths are
rejected and, when enforcement is on, a segment-aware `path.relative` check confirms the path
lies inside an allowlisted root (no `../` escapes), throwing `403 workspace_not_allowed`
otherwise.

### `mcp/` — Model Context Protocol server

A config-gated (`KAPLAN_MCP_ENABLED=1`, OFF by default) stdio MCP server (`server.ts`) exposes
the board to coding agents. Tools (`tools.ts`) are plain JSON-serializable handlers adapted into
MCP `registerTool` calls: `list_queue_jobs`, `get_queue_job`, `enqueue_prompt`, `get_run`,
`list_run_events`, and `steer_run`.

### `db/`, `repositories/`, `services/`

MySQL pool (`db/pool.ts`), idempotent migrations keyed in `schema_migrations`
(`db/migrate.ts`), typed repositories per aggregate, and the services that compose them
(prompt generation, limits, queue, run/team templates).

## Frontend (`apps/frontend/app`)

- **`pages/`** — one route per domain (runs, terminals, queue, cue, prompts, limits, settings).
- **`stores/`** — one Pinia store per domain; the single source of truth components read.
- **`composables/`** — `useApi` (typed REST client), `useSocket` (singleton multiplexed WS with
  exponential-backoff reconnect), `useTerminalView` (lazy xterm mount + ref-counted attach).
- **`components/`** — domain component trees (e.g. `team/TeamView.vue`,
  `team/TeamChangesPanel.vue`) bound to the WS event contracts in `types.ts`.

## Invariants worth knowing

- **Single authoritative writer** per persisted artifact — e.g. the `RunEngine` is the only
  writer of a run's `state.json` / `events.jsonl`.
- **An agent's output may only ever speak as itself** — the message bus forces a message's
  `from` and a sign-off's `roleId` to the executing role.
- **One run per workspace** — a MySQL execution lease (with heartbeat) is shared by Tiger and
  Team, so the two can never drive the same `.tiger` root simultaneously.
- **No silent boot** — the backend migrates on boot and fails fast if MySQL is unreachable.
- **No shell strings to git** — all git/gh invocations pass discrete argv tokens; Kaplan never
  force-pushes or bare-pushes.

---

## Per-domain design notes

- **Terminals.** PTYs are inherently stateful and racy; the promise-lock + generation-tag
  combination is what makes broadcast input and reconnect-reconcile safe.
- **Tiger pipeline.** Driving real interactive CLIs (not headless API calls) means completion
  is _observed_, not _returned_ — hence the `.done` marker with idle/timeout fallbacks, and why
  worktree-per-task isolation matters for parallel safety.
- **AI Team.** The done-gate is _pure and code-enforced_ on purpose: agents can claim they're
  finished, but only the gate decides, and it can't be talked past. Verification text like
  "0 errors" is treated as success, not failure.
- **Queue.** `SKIP LOCKED` + lease/heartbeat is the durable, multi-scheduler-safe primitive;
  per-provider lanes decouple throughput from provider rate limits.
- **Limits.** Probing + a rules-based gate keeps providers from being hammered into hard
  rate-limit walls; reset parsing lets blocked providers auto-recover.
- **Security.** Kaplan is RCE-by-design (it runs agent CLIs); the current controls are loopback
  binding + Origin allowlist + optional token + rate limit. Hardening is tracked in
  [`ROADMAP.md`](ROADMAP.md) (Epic 1).

For the gap analysis and what's planned next, see [`ROADMAP.md`](ROADMAP.md).
