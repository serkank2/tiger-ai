<div align="center">

# 🐯 Kaplan

**A local-first control panel for running, orchestrating, and supervising AI coding agents in real terminals.**

Kaplan turns your machine into a cockpit for AI software work: live PTY terminals, a durable command queue, reusable prompts, provider usage limits, and a headless **Runs** engine that drives Claude / Codex / Antigravity over a work graph — plan → build → review with engine-run verification, optional multi-agent councils, parallel git-worktree builds, and live steering — all watchable per agent.

[Features](#-features) · [Architecture](#-architecture) · [Quick start](#-quick-start) · [Configuration](#-configuration) · [Development](#-development) · [Contributing](#-contributing)

</div>

---

> **Status:** active development (`0.1.x`). Local, single-user, personal tool. See [the roadmap](#-roadmap) for what is landing next.

> **AI agents:** start with [`AGENTS.md`](AGENTS.md) — the canonical guide for AI coding agents working in this repo.

## ✨ Features

| Area                | What it does                                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runs**            | A headless work-graph engine (`plan → build → review`) that drives Claude / Codex / Antigravity as one-shot turns with session resume and delta briefs. Kaplan runs the checks itself — exit code 0 is the only definition of "green."            |
| **Councils**        | Optional multi-agent ensembles at the read-only phases: N independent plan candidates (distinct lenses, synthesized into one graph) and N review lenses (findings merged). The write path stays single-agent. Per-phase counts and skip planning. |
| **Parallel builds** | Build tasks fan out into isolated git worktree lanes and merge back as patches (Kaplan never commits on your branch); conflicts fall back to a sequential retry.                                                                                  |
| **Live control**    | Watch every agent's stream per-terminal, steer mid-run (queued or interrupt-now), and run agents as interactive PTYs you type into when you want to drive by hand.                                                                                |
| **Terminals**       | Create, name, group, and drive real PTY terminals (`node-pty` + `xterm.js`) with full scrollback replay on attach and live streaming over WebSocket.                                                                                              |
| **Command queue**   | A MySQL-backed durable queue + scheduler that fans commands/prompts out to one or many terminals or run targets.                                                                                                                                  |
| **Prompts**         | Compose prompts with variables, generate them with AI, keep a searchable history, and organize reusable libraries.                                                                                                                                |
| **Usage limits**    | Tracks provider usage/limits and gates dispatch when a provider is rate-limited.                                                                                                                                                                  |

## 🏛 Architecture

Kaplan is an npm-workspaces monorepo with two apps:

```
kaplan/
├── apps/
│   ├── backend/     # Express 5 REST control-plane + ws data-plane, owns the PTY processes
│   │   └── src/
│   │       ├── run/          # v2 Runs engine: WorkGraph, lanes, staged planning
│   │       ├── agents/       # headless + interactive provider drivers (claude/codex/agy)
│   │       ├── context/      # session preamble + delta briefs + project map
│   │       ├── verify/       # engine-run verification (exit code = truth)
│   │       ├── terminal/     # TerminalManager / TerminalSession (node-pty)
│   │       ├── orchestrator/ # provider CLI config + usage probing
│   │       ├── queue/        # durable command queue + scheduler
│   │       ├── services/     # prompt generation, limits …
│   │       ├── repositories/ # MySQL repositories
│   │       ├── http/         # REST routers (/api)
│   │       ├── ws/           # WebSocket hub
│   │       └── db/           # pool + migrations
│   └── frontend/    # Nuxt 4 + Vue 3 + Pinia SPA (xterm.js terminals)
│       └── app/
│           ├── pages/         # runs, terminals, queue, cue, prompts, limits, settings
│           ├── components/    # per-domain Vue components
│           ├── stores/        # Pinia stores (one per domain)
│           └── composables/   # useApi, useSocket, useTerminalView …
└── prompts/         # on-disk prompt library
```

**Data flow:** the frontend talks to the backend over **REST** (control: create/start/stop) and a **WebSocket** (data: live terminal output + run state). **MySQL is the durable system of record** — the backend connects and migrates on boot and _fails fast_ if the database is unreachable (it never silently boots on stale file state).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for a deeper tour.

## 🚀 Quick start

### Prerequisites

- **Node.js ≥ 20**
- **Docker** (Compose v2) — used to run MySQL locally with one command. _(Or bring your own MySQL ≥ 8 and skip Docker.)_
- A C/C++ toolchain for `node-pty` (Windows: _Visual Studio Build Tools_; macOS: _Xcode CLT_; Linux: _build-essential_)
- The **AI coding CLIs** you want to drive, installed and authenticated on your `PATH` — [`claude`](https://docs.anthropic.com/en/docs/claude-code), `codex`, and/or `agy` (Antigravity). Kaplan orchestrates these; it does not bundle them.

### Fastest path (Make + Docker) — clone to running in ~5 minutes

```bash
git clone <your-fork-url> kaplan && cd kaplan
make setup     # writes apps/backend/.env, installs deps, starts MySQL (Docker), runs migrations
make dev       # starts backend (:4517) + frontend (:3000)
```

Then open **http://localhost:3000**. A DB browser (Adminer) is at **http://localhost:8080** (server `mysql`, user `root`, password `kaplan`).

Run `make help` to see every target (`test`, `lint`, `typecheck`, `db-down`, `db-reset`, …).

### Manual path (no Make)

```bash
git clone <your-fork-url> kaplan && cd kaplan
npm install

# Start MySQL (Docker) …
docker compose up -d
# … or point at your own MySQL instead.

# Configure the backend's database connection
cp apps/backend/.env.example apps/backend/.env
# set KAPLAN_DB_PASSWORD=kaplan (matches docker-compose), or your own credentials

npm run migrate -w @kaplan/backend   # apply migrations (also runs automatically on boot)
npm run dev                          # backend (:4517) + frontend (:3000) together
```

Run them separately if you prefer:

```bash
npm run dev:backend  # Express + ws on KAPLAN_PORT (default 4517)
npm run dev:frontend # Nuxt dev server on :3000
```

> **Stopping / resetting the database:** `make db-down` (keeps data) or `make db-reset` / `docker compose down -v` (wipes the volume).

## ⚙️ Configuration

All backend configuration is via environment variables (read from `apps/backend/.env` or the real environment, which always wins). The most common:

| Variable                                | Default              | Purpose                         |
| --------------------------------------- | -------------------- | ------------------------------- |
| `KAPLAN_PORT`                           | `4517`               | Backend HTTP/WS port            |
| `KAPLAN_DB_HOST` / `KAPLAN_DB_PORT`     | `127.0.0.1` / `3306` | MySQL location                  |
| `KAPLAN_DB_USER` / `KAPLAN_DB_PASSWORD` | `root` / _(empty)_   | MySQL credentials               |
| `KAPLAN_DB_NAME`                        | `kaplan`             | Schema name (auto-created)      |
| `KAPLAN_CORS_ORIGINS`                   | dev origins          | Comma-separated allowed origins |
| `KAPLAN_DATA_DIR`                       | OS app-data dir      | Where durable file state lives  |
| `KAPLAN_PROMPTS_DIR`                    | `<repo>/prompts`     | Prompt library location         |

See [`apps/backend/.env.example`](apps/backend/.env.example) for the full list.

## 🧑‍💻 Development

```bash
npm run typecheck                    # type-check backend + frontend
npm test -w @kaplan/backend          # backend tests (node:test via tsx)
npm test -w @kaplan/frontend         # frontend tests (vitest)
npm run build:frontend               # production build of the SPA
```

**Conventions:** TypeScript everywhere, ESM, one Pinia store per domain, REST for control + WS for live data, and a single authoritative writer per persisted artifact. New code should match the density, naming, and idioms of the file around it.

## 🗺 Roadmap

The near-term direction (see [`docs/ROADMAP.md`](docs/ROADMAP.md) for the full, prioritized backlog):

- Runs engine depth: worktree merge-back tuning, richer diff/PR review, cost/token budgets
- Observability: structured logging, health/readiness endpoints, request tracing
- Provider breadth: more coding CLIs behind the same driver contract
- Security hardening: workspace allow-listing, tighter input validation, shared-token auth
- Accessibility & i18n passes across every page

## 🤝 Contributing

Contributions are welcome! Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow, coding standards, and how to run the test suites. By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues: see [`SECURITY.md`](SECURITY.md).

## 📄 License

[MIT](LICENSE) © Kaplan contributors.
