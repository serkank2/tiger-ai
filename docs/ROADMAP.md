# Kaplan Roadmap

This roadmap is the consolidated output of a full-codebase production-readiness audit (every
domain: terminals/queue, Tiger pipeline, AI Team, prompts/templates/limits/settings, and
cross-cutting infra). It captures **what exists**, **what's stubbed**, and **what a
Google/Microsoft/large-OSS-grade version needs** — organized into epics, prioritized.

Effort key: **S** = hours · **M** = a day or two · **L** = multi-day.
Status: ☐ todo · ◐ in progress · ☑ done.

> **Update (2026-06-19):** A multi-wave implementation pass landed nearly the entire roadmap
> (Epics 0–8) plus a set of competitor-extracted features (git worktree-per-task isolation,
> an MCP server, a PR-style diff/review loop with inline comments, git stage/commit/PR). The
> tree is green: full typecheck, `npm run lint` (0 errors), 416 backend + 160 frontend tests,
> and a production frontend build all pass. Items still open are marked ☐ with a note; the
> remaining net-new competitor features are tracked in the new **Epic 9** below.

---

## Epic 0 — Engineering foundation ☑

The repo had no README, license, CI, lint, or contribution docs. These define "open-source
quality" and are prerequisites for everyone else's contributions.

- ☑ README, LICENSE (MIT), CONTRIBUTING, CODE_OF_CONDUCT, SECURITY
- ☑ CI (GitHub Actions: typecheck + backend tests + frontend tests + build, Node 20 & 22)
- ☑ `.editorconfig`, issue/PR templates
- ☑ **ESLint (flat config) + Prettier** wired into CI and `lint`/`format` scripts (lint = correctness net, Prettier owns formatting; 0 errors)
- ☑ `docs/ARCHITECTURE.md` deep-dive + per-domain design notes
- ☑ Conventional commits (commitlint) + `CHANGELOG` + documented release process

## Epic 1 — Security & multi-user readiness ☑

Kaplan was RCE-by-design with **no authentication or authorization anywhere**.

- ☑ **Optional auth**: shared-token middleware on HTTP + WS upgrade verify, config-gated (`KAPLAN_AUTH_TOKEN`), no-op when unset; frontend sends the token + surfaces 401/429
- ☑ **Enforce the workspace boundary** for agents (`security/workspace.ts` allow-list + containment check), wired into Tiger + Team run creation, opt-in via `KAPLAN_ENFORCE_WORKSPACE`
- ☑ **Restrict run workspaces to an allowlist / approved-project registry** (`KAPLAN_WORKSPACE_ALLOWLIST`)
- ☑ Safer permission defaults — the blanket `--dangerously-*` flag is now opt-in (`KAPLAN_ALLOW_DANGEROUS_AGENT_PERMISSIONS`)
- ☑ `helmet` + per-IP rate limiting on the Express app
- ☑ Shared `HttpError` + machine-readable `code` on 4xx (central `errorHandler`)

## Epic 2 — Observability ☑

- ☑ **Structured logger** (levels + JSON in prod) replacing `console.*` + request-id middleware (`X-Request-Id`) + per-request structured logging
- ☑ `/api/metrics` (queue depth, terminal/PTY count, WS peers, uptime/memory, request counters)
- ☑ Per-agent/per-run **structured run metrics** for the Team (duration, turns, provider) emitted via the logger
- ☑ Readiness (`/api/health/ready`) vs liveness (`/api/health/live`) split alongside legacy `/api/health`

## Epic 3 — Test coverage of the highest-risk, untested code ☑ (core)

- ☑ **`TerminalManager`** (routing, protected-exclusion, remove-during-start, autostart-during-shutdown)
- ☑ **WS server `socket.ts`** (attach/snapshot ordering, origin verify, broadcast, garbage-frame resilience) — _heartbeat-reaping + 8MB backpressure-drop left as noted seams (need fake timers/stalled socket)_
- ☑ **HTTP routes** (terminals, groups, settings, fs, limits) — validate→apply, concurrent-DELETE, error envelopes
- ☐ **MySQL repos against a real/containerized DB** — **L** · _deferred: needs a DB container in CI_
- ☑ **Frontend component tests** (Team done-gate/metrics/history, modal a11y, queue, useApi auth, i18n)
- ☑ Backend `compose-turn`, `snapshot`, `role-session`, `scaffold`, `validate` units (+ completion-gate, worker-pool, retry, concurrency, workspace, write, worktree)
- ☐ One end-to-end test exercising live PTY → WS → xterm — **M** · _deferred: needs a real pty backend + browser_

## Epic 4 — AI Team product maturity ☑

- ☑ **Diff / changed-files / PR view** — per-file collapsible colorized diff + inline file:line comments bundled into a steering directive (review→follow-up loop) + Stage/Commit/Create-PR (gh, no force-push)
- ☑ **Wire `TaskDirective` actions** (claim/complete/block/needs_work/request_review) into the task board
- ☑ **Duration tracking & display** (per-role + per-run) + enabled budget/time guards · _token/cost = documented extension point (interactive PTY CLIs don't self-report usage)_
- ☑ **Run history**: list + read-only reopen
- ☑ Fixed `DoneGateState.satisfied` to reflect the full gate + open-blockers shown in the UI
- ☑ Live **artifact/diff WS events** (`team.role`/`team.done`/`team.steering`/`team.changes`)
- ☑ Completion/blocked/failed **notifications** (OS opt-in + optional webhook)
- ☑ Pause/steer a **single role**; mid-run role add/remove/reconfigure
- ☑ **Real verification records** (command + exitCode + outcome) superseding the regex inference
- ☑ Transcript/artifact **export** (JSON/markdown)
- ☑ Removed dead `teamTerminalId`; backed the `turns`/`verifications`/`signoffs` store stubs with real data

## Epic 5 — Tiger pipeline robustness ☑

- ☑ **Semantic completion gate** (missing `EXECUTION_RESULT`/`FIX_RESULT` ⇒ `blocked`, not silently `done`)
- ☑ `maxConcurrent` now **caps parallelism** (bounded worker pool)
- ☑ **Auto-resume** interrupted fan-out stages (opt-in flag; detection always on)
- ☑ Escalate **lease-heartbeat failure** to a hard stop (prevents split-brain)
- ☑ Gated destructive cleanup behind opt-in + verified success
- ☑ Validate upstream artifacts before auto-advancing / Run-All
- ☑ `ctx`/config `save()` before in-memory assignment (no disk/memory divergence)

## Epic 6 — Terminals & Queue scale/resilience ☑ (core)

- ☑ **Virtualize the terminal grid** (IntersectionObserver mount/teardown, lossless via scrollback replay) + WebGL renderer with fallback
- ☑ Queue: `SKIP LOCKED` + owner/expiry on lease/reclaim (no double-lease, no stealing live jobs)
- ☑ Queue: **retry backoff + cap** (no hot-loop)
- ☑ **Fail-open** when the `limit_snapshots` table is missing
- ☑ `getState` N+1 → batched query; `replacePositions` → bulk SQL
- ☑ `ctx.save()` divergence fix (see Epic 5)
- ☐ Scrollback persistence / reconnect-to-orphaned-pty across backend restart — **L** · _deferred_
- ☑ Drag-and-drop queue reorder; bulk ops; per-provider concurrency lanes

## Epic 7 — Accessibility & internationalization ☑

- ☑ xterm `screenReaderMode`; ARIA live regions for status/broadcast/toasts
- ☑ Dialog `role`+focus-trap+`Esc`; roving `tabindex` on segmented controls; input labels; `:focus-visible`
- ☑ Replaced `confirm()`/`alert()` with a promise-based styled dialog (one team call-site noted)
- ☑ i18n scaffolding (vue-i18n) + non-English reset-text parsing fallback in `resetParse.ts`

## Epic 8 — Data & persistence integrity ☑

- ☑ Migration 008 missing `utf8mb4` engine clause → fixed + `009` ALTER
- ☑ Down/rollback migrations (`rollbackLast` + CLI) + zero-padded migration-id convention (legacy ids untouched for upgrade safety)
- ☑ Collapsed the dual limit-snapshot source of truth (MySQL authoritative; `state.json` = one-time back-compat import)
- ☑ Limit-rules CRUD (endpoint + service + repo + UI)

## Epic 9 — Competitor-extracted features _(net-new, from vibe-kanban / Maestro / agtx / CAO / CodeMachine / myclaude)_

Distilled from a deep analysis of the six leading open-source orchestrators. **Landed** so far:

- ☑ **Git worktree-per-task isolation** (`git/worktree.ts`) + wired into the Tiger fan-out (opt-in `KAPLAN_WORKTREE_PER_TASK`; merge-back + conflict-safe) — _vibe-kanban/agtx parallelism primitive_
- ☑ **MCP server** exposing the board to agents (`mcp/**`: list/enqueue/team-steering over stdio, `KAPLAN_MCP_ENABLED`) — _bidirectional-MCP_
- ☑ **PR-style review loop**: per-file colorized diff + inline comments → agent follow-up; git stage/commit/PR — _vibe-kanban review UX_
- ☑ Multi-provider agents already supported (Claude/Codex/Antigravity) with per-stage/per-role model + permission

**Landed in Wave 5:**

- ☑ **Attempt model** — multiple diffable attempts per Team run, worktree-isolated, conflict-safe "promote" (vibe-kanban)
- ☑ **Unified executor/provider registry** — `ProviderAdapter` interface + registry; 3 wired providers reproduce identical argv; experimental opencode/gemini/copilot adapters (vibe-kanban `Executor` / myclaude wrapper)
- ☑ **Worktree-per-task for the Team** (opt-in `KAPLAN_TEAM_WORKTREE_PER_TASK`) + merge-back/discard endpoint + UI
- ☑ **Event-driven orchestration ("Cue")** — `file.changed`/`time.scheduled`/`time.once`/`agent.completed` (fan-in)/`cli.trigger` → queue-enqueue or team-steer; `.kaplan/cue.json`; opt-in `KAPLAN_CUE_ENABLED` (Maestro Cue)
- ☑ **Coordination verbs** — `handoff` (sync, done-gate dependency) / `assign` (async) / `sendMessage` (inbox) on the message-bus, roleId trust-boundary enforced (CAO)

**Still open (further net-new surfaces):**

- ☐ **Context compaction / transfer** — chunked summarization at a token threshold; move a conversation between agents (Maestro) — **M**
- ☐ **Integrated dev-server preview + port-pool** daemon for live output review (vibe-kanban) — **L**
- ☐ **Workflow-as-code** — `.workflow.js`/declarative phase pipelines with loop+iteration caps (CodeMachine) — **M**
- ☐ **Terminal scrollback archival + restore** (CAO `terminal restore`) — **S** (pairs with Epic 6 scrollback persistence)

---

### What landed, by wave (2026-06-19)

1. **Wave 1** — Tiger/queue/persistence robustness & footgun fixes (Epics 5, 6-queue, 8).
2. **Wave 2** — security hardening (Epic 1) + observability (Epic 2).
3. **Wave 3** — AI Team maturity backend + frontend (Epic 4) + worktree module + MCP server + terminal virtualization.
4. **Wave 4** — worktree→Tiger wiring + git-write API + queue UX + test coverage (Epics 3, 6), then tooling/docs (Epic 0) + a11y/i18n (Epic 7) + git-button/auth UI.

Each wave was typecheck/test-verified and committed independently; the tree is green at every commit.
