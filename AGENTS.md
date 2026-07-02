# AGENTS.md — guide for AI coding agents

This file is the canonical, machine-first orientation for AI coding agents (Claude Code, Codex,
Antigravity, and any MCP/CLI agent) working in this repository. Read it before editing. It mirrors
the human docs but is condensed for fast, accurate action. When something here disagrees with the
code, the code wins — and please flag the drift.

## What Kaplan is

Kaplan is a local-first, single-user control panel for running, orchestrating, and supervising AI
coding agents in real terminals. It is an npm-workspaces monorepo: an Express 5 + WebSocket
**backend** that owns real PTY processes (`node-pty`) and a Nuxt 4 + Vue 3 + Pinia **frontend** that
renders and steers them. MySQL is the durable system of record. See
[`README.md`](README.md) for the product tour and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for
the deep dive.

## Repository map

```
kaplan/
├── apps/
│   ├── backend/     # @kaplan/backend — Express 5 REST + ws data-plane, owns PTYs (node-pty)
│   └── frontend/    # @kaplan/frontend — Nuxt 4 + Vue 3 + Pinia SPA (xterm.js terminals)
├── prompts/         # on-disk prompt library
└── docs/            # ARCHITECTURE.md, ROADMAP.md
```

## Prerequisites (hard requirements)

- **Node.js ≥ 20** (`engines.node` in `package.json`).
- **MySQL ≥ 8** running locally. MySQL is required, not optional: the backend runs migrations on
  boot **before** the HTTP server listens and **fails fast** (`process.exit(1)`) if the database is
  unreachable after its retry window — it never silently boots on stale file state.
- A C/C++ toolchain for `node-pty` (Windows: Visual Studio Build Tools; macOS: Xcode CLT; Linux:
  build-essential).
- Configure the backend DB connection before running it:
  ```bash
  cp apps/backend/.env.example apps/backend/.env   # then set KAPLAN_DB_PASSWORD
  ```
  Real `.env` files are gitignored; only [`apps/backend/.env.example`](apps/backend/.env.example) is
  committed.

## Commands

Run these from the repo root. Every command below is copied verbatim from `package.json`,
`apps/backend/package.json`, or `apps/frontend/package.json` — do not invent new ones.

```bash
# Install all workspaces
npm install

# Run both apps together (backend :4517 + frontend :3000)
npm run dev
npm run dev:backend      # backend only
npm run dev:frontend     # frontend only

# Type-check backend + frontend (must be clean)
npm run typecheck

# Tests
npm test -w @kaplan/backend     # backend tests (node:test via tsx)
npm test -w @kaplan/frontend    # frontend tests (vitest)

# Lint & format
npm run lint             # eslint .
npm run lint:fix         # eslint . --fix
npm run format           # prettier --write .
npm run format:check     # prettier --check .

# Production build of the SPA
npm run build:frontend

# Database migrations (backend workspace)
npm run migrate -w @kaplan/backend        # apply (tsx src/db/migrate.ts up)
npm run migrate:down -w @kaplan/backend   # roll back the last migration
```

## Backend subsystem map (`apps/backend/src`)

- `agents/` + `run/` + `context/` + `verify/` — the **v2 execution core** (headless agent turns
  over a WorkGraph with engine-run verification; see `docs/REDESIGN.md`). The v1 PTY-driven
  Tiger/Team engines have been removed; `orchestrator/` retains only provider config + usage
  probing, and `providers/config-store.ts` is the global CLI-config home.
- `terminal/` — `TerminalManager` / `TerminalSession`: the `node-pty` PTY model (serialized ops,
  generation tagging, input routing).
- `queue/` — the MySQL-backed durable command queue + `Scheduler` (lease + `SKIP LOCKED`,
  per-provider lanes).
- `ws/` — the WebSocket hub that pushes live terminal output and run-state deltas.
- `db/` — the MySQL pool and idempotent migrations.
- `mcp/` — the optional Model Context Protocol server (see below).

Other directories you will encounter: `http/` (REST routers under `/api`), `services/`,
`repositories/`, `limits/`, `obs/` (logging + metrics), `security/`, `git/`, and `executors/`.

## Conventions

- **TypeScript everywhere, ESM modules.** No `any` escape hatches without a comment explaining why.
- **REST is the control plane; the WebSocket is the data plane.** Side-effecting create/start/stop
  goes over REST; live terminal output and run-state updates are pushed over WS (the frontend never
  polls for live data).
- **One Pinia store per domain** on the frontend — the single source of truth components read.
- **A single authoritative writer per persisted artifact** on the backend (e.g. the
  `RunEngine` is the only writer of a run's `events.jsonl`).
- **Match the surrounding code.** Mirror each file's existing naming, comment density, and idioms
  rather than introducing a new style.

## Optional MCP server

The backend ships a config-gated stdio MCP server that exposes the board to coding agents. It is
**off by default** and starts only when `KAPLAN_MCP_ENABLED` is set to `1`/`true`/`yes`
(`apps/backend/src/mcp/server.ts`). When enabled it exposes these tools: `list_queue_jobs`,
`get_queue_job`, `enqueue_prompt`, `get_run`, `list_run_events`, and `steer_run`.

## Do not

- **Never commit a real `.env`.** `.env` and `.env.*` are gitignored; only `*.env.example` files are
  tracked. Never paste real secrets into docs, commits, or the transcript.
- **`.tiger/` is private run bookkeeping and is gitignored.** Do not commit it, and do not treat its
  contents as product source.
- **No unrelated refactors.** Make the smallest change that fully solves the task; do not reformat or
  "improve" code outside your task while you are in there.
- **Keep the planes separate.** Do not move control logic onto the WebSocket or push live data over
  REST.

## Commits

This repo uses [Conventional Commits](https://www.conventionalcommits.org), enforced by commitlint
(`commitlint.config.js`): `<type>(<optional scope>): <subject>`. Common types: `feat`, `fix`,
`docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. Scopes used here
include `backend`, `frontend`, `team`, `tiger`, `queue`, `db`, `ws`, `ci`, `docs`. The header may be
up to 100 characters.

## See also

- [`README.md`](README.md) — product overview and quick start.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the deep architectural tour.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, coding standards, and the pre-PR gates.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what is planned next.
- [`SECURITY.md`](SECURITY.md) — how to report vulnerabilities.
