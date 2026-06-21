<div align="center">

# 🐯 Kaplan

**A local-first control panel for running, orchestrating, and supervising AI coding agents in real terminals.**

Kaplan turns your machine into a cockpit for AI software work: live PTY terminals, a queue, reusable prompts, provider usage limits, a staged "Tiger" pipeline, and an autonomous **AI Team** of role-agents (Lead, Analyst, Developer, Tester, Reviewer) that converse, write code, and sign off — all watchable in live terminal tiles.

[Features](#-features) · [Architecture](#-architecture) · [Quick start](#-quick-start) · [Configuration](#-configuration) · [Development](#-development) · [Contributing](#-contributing)

</div>

---

> **Status:** active development (`0.1.x`). Local, single-user, personal tool. See [the roadmap](#-roadmap) for what is landing next.

> **AI agents:** start with [`AGENTS.md`](AGENTS.md) — the canonical guide for AI coding agents working in this repo.

## ✨ Features

| Area | What it does |
| --- | --- |
| **Terminals** | Create, name, group, and drive real PTY terminals (powered by `node-pty` + `xterm.js`) with full scrollback replay on attach and live streaming over WebSocket. |
| **Command queue** | Schedule commands/prompts to fan out to one or many terminals, with a backend scheduler. |
| **Prompts** | Compose prompts with variables, generate them with AI, keep a searchable history, and organize reusable libraries/templates. |
| **Tiger pipeline** | A staged AI software pipeline (plan → tasks → execute → review) that runs Claude/Codex agents as interactive CLIs and auto-advances on completion markers. |
| **AI Team** | An autonomous, Lead-coordinated team of role-agents working a real project: a file-based task board, conversation transcript, objective done-gate (every required role must sign off + verification must pass), live steering, and *Stop = pause / Close = end* session lifecycle. |
| **Usage limits** | Tracks provider usage/limits and gates agent runs when a provider is rate-limited. |
| **Templates** | Full CRUD for run templates and team templates, with least-privilege-aware role configuration. |

## 🏛 Architecture

Kaplan is an npm-workspaces monorepo with two apps:

```
kaplan/
├── apps/
│   ├── backend/     # Express 5 REST control-plane + ws data-plane, owns the PTY processes
│   │   └── src/
│   │       ├── terminal/      # TerminalManager / TerminalSession (node-pty)
│   │       ├── orchestrator/  # Tiger staged pipeline engine
│   │       ├── team/          # AI Team run engine (TeamOrchestrator + modules)
│   │       ├── queue/         # command queue + scheduler
│   │       ├── services/      # prompt generation, limits, templates …
│   │       ├── repositories/  # MySQL repositories
│   │       ├── http/          # REST routers
│   │       ├── ws/            # WebSocket hub
│   │       └── db/            # pool + migrations
│   └── frontend/    # Nuxt 4 + Vue 3 + Pinia SPA (xterm.js terminals)
│       └── app/
│           ├── pages/         # terminals, team, tiger, queue, prompts, limits, …
│           ├── components/    # per-domain Vue components
│           ├── stores/        # Pinia stores (one per domain)
│           └── composables/   # useApi, useSocket, useTerminalView …
└── prompts/         # on-disk prompt library
```

**Data flow:** the frontend talks to the backend over **REST** (control: create/start/stop) and a **WebSocket** (data: live terminal output + run state). **MySQL is the durable system of record** — the backend connects and migrates on boot and *fails fast* if the database is unreachable (it never silently boots on stale file state).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for a deeper tour.

## 🚀 Quick start

### Prerequisites

- **Node.js ≥ 20**
- **MySQL ≥ 8** running locally (the schema is auto-created on first boot)
- A C/C++ toolchain for `node-pty` (Windows: *Visual Studio Build Tools*; macOS: *Xcode CLT*; Linux: *build-essential*)

### Install & configure

```bash
git clone <your-fork-url> kaplan && cd kaplan
npm install

# Configure the backend's database connection
cp apps/backend/.env.example apps/backend/.env
# edit apps/backend/.env and set KAPLAN_DB_PASSWORD (and host/user if not defaults)
```

### Run (both apps)

```bash
npm run dev          # starts backend (:4517) + frontend (:3000) together
```

Then open **http://localhost:3000**.

Run them separately if you prefer:

```bash
npm run dev:backend  # Express + ws on KAPLAN_PORT (default 4517)
npm run dev:frontend # Nuxt dev server on :3000
```

## ⚙️ Configuration

All backend configuration is via environment variables (read from `apps/backend/.env` or the real environment, which always wins). The most common:

| Variable | Default | Purpose |
| --- | --- | --- |
| `KAPLAN_PORT` | `4517` | Backend HTTP/WS port |
| `KAPLAN_DB_HOST` / `KAPLAN_DB_PORT` | `127.0.0.1` / `3306` | MySQL location |
| `KAPLAN_DB_USER` / `KAPLAN_DB_PASSWORD` | `root` / *(empty)* | MySQL credentials |
| `KAPLAN_DB_NAME` | `kaplan` | Schema name (auto-created) |
| `KAPLAN_CORS_ORIGINS` | dev origins | Comma-separated allowed origins |
| `KAPLAN_DATA_DIR` | OS app-data dir | Where durable file state lives |
| `KAPLAN_PROMPTS_DIR` | `<repo>/prompts` | Prompt library location |

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

- Engineering foundation: CI, linting, contribution guides, architecture docs ✅ *in progress*
- Observability: structured logging, health/readiness endpoints, request tracing
- AI Team maturity: run history & re-open, cost/token budgets, a diff/PR view of agent changes, per-role pause, approval gates
- Security hardening: workspace allow-listing, tighter input validation, optional auth
- Accessibility & i18n passes across every page

## 🤝 Contributing

Contributions are welcome! Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow, coding standards, and how to run the test suites. By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues: see [`SECURITY.md`](SECURITY.md).

## 📄 License

[MIT](LICENSE) © Kaplan contributors.
