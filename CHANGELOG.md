# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Commit & release process

Commits follow [Conventional Commits](https://www.conventionalcommits.org):
`<type>(<scope>): <subject>` (e.g. `feat(team): add changes drawer`,
`fix(queue): reclaim stale lease`). Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`,
`perf`, `test`, `build`, `ci`, `chore`, `revert`. Messages are validated by `commitlint`
(`commitlint.config.js`, extending `@commitlint/config-conventional`); run
`npx commitlint --from=HEAD~1` locally, or wire it into a `commit-msg` hook.

Releases: cut from `master`. Move the `Unreleased` entries into a new `## [x.y.z] - YYYY-MM-DD`
section (SemVer — `feat` ⇒ minor, `fix` ⇒ patch, breaking ⇒ major), bump `version` in the
`package.json` files, tag `vx.y.z`, and start a fresh `Unreleased` section.

## [Unreleased]

### Removed
- **v1 execution engines deleted (second pass of the v2 redesign):** the Tiger staged pipeline
  (`orchestrator/Orchestrator.ts`, `AgentSession`, stage compose/tasks/findings machinery), the
  Team role-chat engine (`team/**` — `TeamOrchestrator`, role sessions, compose-turn, message-bus
  file contract, sign-off done-gate), their REST routers (`/api/tiger`, `/api/team`), template
  services, translation service, WS frames, MCP tools, and the frontend Tiger/Team/Templates
  pages, stores, and component trees. Schema history is preserved verbatim in
  `db/legacy-migrations.ts`. The queue's `project`/`team` targets now dispatch onto the v2 run
  engine (create-run / steer), prompt generation runs as a headless v2 turn, Cue steers the v2
  run, and provider CLI configuration moves to an app-level `providers.json`
  (`providers/config-store.ts`).

### Added
- **Council (importance-scaled multi-perspective ensemble):** a run's `importance`
  (low/normal/high/critical → 1/1/3/5) sizes independent, PARALLEL, read-only agents at the two
  phases where the evidence says ensembles win: plan candidates (each arguing a distinct lens —
  correctness, risk, simplicity, architecture, testing, sequencing, security, edge cases — across
  a provider rotation) merged by a synthesis turn on the planner's session, and review lenses
  whose findings are merged + deduped in code. The write path stays single-agent. Explicit
  `council {plan, review, providers[]}` overrides the preset (capped at 12).
- **Live intervention:** `steer(body, {interrupt: true})` aborts the in-flight turn via per-turn
  abort controllers — the item re-queues (attempt refunded), the re-plan applies the steering
  immediately, and sessions resume with their context. UI: an "Apply now" button beside Steer,
  plus a Verbose toggle on the live feed that shows EVERYTHING the agents emit (stderr and usage
  included) — the headless replacement for watching PTY scrollback.
- **Runs UX package:** diff-first review — `GET /api/runs/current/changes` + a Changes panel
  (file list, colorized unified diff, ± summary) that opens automatically when a run settles;
  work-item drill-down modal (brief, attempts, per-item events, cost); run history (global
  `runs-index.json` maintained by the engine, `GET /api/runs` / `GET /api/runs/:id`, read-only
  reopen); a Providers settings card backed by `GET/PUT /api/providers/config` (validated
  executable/model/effort/permission per provider); Runs is now the landing page; workspace
  folder picker + last-workspace memory; localized policy labels; stop confirmation dialog;
  error toasts; live-feed auto-scroll; queue/cue target labels renamed to run terminology;
  RunView + runs-store test suites.
- **v2 execution core (docs/REDESIGN.md):** a full redesign of how Kaplan drives coding agents,
  built from an 18-source competitive study (vibe-kanban, ruflo, OpenHands, SWE-agent, Aider,
  goose, claude-squad, Plandex, Cognition/Anthropic/MAST evidence). New backend domains:
  `agents/` (headless drivers — `claude -p --output-format stream-json --resume`,
  `codex exec --json`/`exec resume`, `agy --print` + result file — normalized `AgentEvent`
  streams, provider-reported completion, session resume via `SessionRegistry`), `run/` (the
  WorkGraph engine: plan → build → review items over a pure dependency scheduler; steering =
  engine-inserted re-plan; per-turn token/cost accounting), `context/` (once-per-session
  preamble + delta-only task briefs + budgeted project map) and `verify/` (Kaplan runs
  build/test/lint itself; exit codes are the only "passed"). Control plane `/api/runs`; WS
  `run.state`/`run.event` frames; MCP tools `get_run`/`list_run_events`/`steer_run`; a new
  **Runs** screen (work graph, live activity, per-run cost meter, steering) with EN/TR locales.
  This supersedes the v1 PTY-typing/`.done`-marker/transcript-refeed execution model; legacy
  Team/Tiger engines stay mounted pending surface migration (see `docs/REWRITE-TASKS.md`).
- **Engineering tooling (Epic 0):** ESLint 9 flat config (`eslint.config.js`) covering backend
  TS (ESM) and frontend Vue + TS, wired to `npm run lint` and a CI `lint` job; Prettier config
  (`.prettierrc`/`.prettierignore`) matching the codebase style (2-space, single quotes,
  semicolons, trailing commas, 120 width); `eslint-config-prettier` last so lint and formatting
  never fight; `commitlint` Conventional-Commits config; and a deep-dive `docs/ARCHITECTURE.md`.
  Lint is a correctness net (errors for real bugs; stylistic/opinionated rules off or warn) and
  exits 0 on the current codebase.
- **AI Team — Changes view:** a new "Changes" drawer surfaces the real product changes a run
  made in its workspace (git working-tree diff vs HEAD): changed-file list with status
  badges, a colorized diff, and +/− summary. Backend `GET /api/team/runs/:id/changes`
  (`team/changes.ts`, best-effort, degrades cleanly on a non-git workspace).
- Engineering foundation: `README`, `LICENSE` (MIT), `CONTRIBUTING`, `CODE_OF_CONDUCT`,
  `SECURITY`, `.editorconfig`, GitHub Actions CI (typecheck + tests + build on Node 20 & 22),
  issue/PR templates, and `docs/ARCHITECTURE.md` + `docs/ROADMAP.md`.
- AI Team: regression tests asserting an agent's output cannot impersonate another role
  (`from` and sign-off `roleId` are forced to the executing role).

### Changed
- AI Team done-gate now also blocks completion on queued/in-progress per-role task-board
  work, and requeues in-progress tasks on resume so an interrupted run can't deadlock.
- AI Team `Close` now permanently ends a run (cannot resume into killed sessions); the UI
  hides Resume/Close accordingly.

### Fixed
- Headless drivers no longer inherit interactive-era `tool.extraArgs` — codex runs crashed with
  exit 2 (`unexpected argument '--no-alt-screen'`) because the v1 TUI flag leaked into
  `codex exec`; only engine-supplied per-turn args are appended now.
- AI Team: a user prompt (steering) is no longer dropped when the Lead turn that received it
  fails — it stays pending and is re-delivered.
- AI Team: verification text like "0 errors"/"no failures" is no longer misread as a failure.
- AI Team: a timed-out role CLI session is now discarded instead of being reused (which could
  bleed stale output into the next turn).
- AI Team: serialized `start`/`resume` and guarded run creation so two run loops can't race
  against one run's state.
- AI Team: task claiming is now true FIFO across the board (no role starvation).
- Prompt-generation/history tables are now explicitly `utf8mb4` (migration `009`), preventing
  silent loss of 4-byte characters (emoji, supplementary code points) on non-utf8mb4 servers.
- Frontend: the Limits page no longer renders blank after a failed initial load; the Team
  view clears a stale run when the server has none; per-terminal prompt sends now report
  partial fan-out failures.

[Unreleased]: https://github.com/your-org/kaplan/commits/master
