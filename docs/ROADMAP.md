# Kaplan Roadmap

This roadmap is the consolidated output of a full-codebase production-readiness audit (every
domain: terminals/queue, Tiger pipeline, AI Team, prompts/templates/limits/settings, and
cross-cutting infra). It captures **what exists**, **what's stubbed**, and **what a
Google/Microsoft/large-OSS-grade version needs** — organized into epics, prioritized.

Effort key: **S** = hours · **M** = a day or two · **L** = multi-day.
Status: ☐ todo · ◐ in progress · ☑ done.

---

## Epic 0 — Engineering foundation *(in progress)*

The repo had no README, license, CI, lint, or contribution docs. These define "open-source
quality" and are prerequisites for everyone else's contributions.

- ☑ README, LICENSE (MIT), CONTRIBUTING, CODE_OF_CONDUCT, SECURITY
- ☑ CI (GitHub Actions: typecheck + backend tests + frontend tests + build, Node 20 & 22)
- ☑ `.editorconfig`, issue/PR templates
- ☑ **ESLint (flat config) + Prettier** wired into CI and a `lint` script — **M**
- ☑ `docs/ARCHITECTURE.md` deep-dive + per-domain design notes — **S**
- ☑ Conventional commits (`commitlint`) + `CHANGELOG` (Keep a Changelog) + release process — **S**

## Epic 1 — Security & multi-user readiness *(every domain flagged this #1)*

Kaplan is RCE-by-design and has **no authentication or authorization anywhere**; the only
controls are loopback binding + a WebSocket origin allowlist. Agents run with *dangerous*
default permissions and the workspace boundary is prompt-advisory, not enforced.

- ☐ **Optional auth**: shared-token (or local-socket) middleware on HTTP + WS `verifyClient`, gated by a config flag — **M** · *unblocks any non-loopback use*
- ☐ **Enforce the workspace boundary** for agents (sandbox/cwd jail or write allowlist) instead of trusting the prompt — **M** · *Team + Tiger both run write-capable agents on the real FS*
- ☐ **Restrict run workspaces to an allowlist / approved-project registry** (Team & Tiger routes accept any absolute dir today) — **M**
- ☐ Safer permission defaults (not `--dangerously-*` by default); make dangerous modes explicit opt-in — **S**
- ☐ `helmet` + basic rate limiting on the Express app — **S**
- ☐ Shared `HttpError` + machine-readable `code` on 4xx (clients currently string-match prose) — **S**

## Epic 2 — Observability

Logging is `console.*` only; no structured logs, levels, request IDs, metrics, or tracing.
(`/api/health` exists; readiness/liveness split and metrics do not.)

- ☐ **Structured logger** (levels + JSON in prod) + request-id middleware + correlation between a queue job and the Tiger/Team stages it spawns — **M**
- ☐ `/metrics` (queue depth, lease age, terminal/PTY count, spawn failures, WS peers, dropped-output, agent latency/success-rate) — **M**
- ☐ Per-agent/per-run **structured run metrics** for Tiger & Team (duration, completion method, provider, cost) alongside the markdown run log — **M**
- ☐ Readiness vs liveness endpoints — **S**

## Epic 3 — Test coverage of the highest-risk, untested code

Strong on pure modules; the riskiest concurrency/IO/SQL code is untested, and MySQL repos
are only exercised via in-memory doubles (so SQL drift like the migration-008 charset bug
slips through).

- ☐ **`TerminalManager`** (routing, protected-exclusion, remove-during-start, autostart-during-shutdown) — **M**
- ☐ **WS server `socket.ts`** (attach/snapshot ordering, backpressure drop, origin verify, heartbeat reaping) — **M**
- ☐ **HTTP routes** (terminals, groups, team, settings, limits) — validate→apply, concurrent-DELETE, deferred-edit — **M**
- ☐ **MySQL repos against a real/containerized DB** (`PromptHistoryRepository` filter SQL, Tiger `persistence.ts` lease + `reconcileOnBoot`, queue `MysqlQueueRepository`) — **L**
- ☐ **Frontend component tests** (Team's 9 components, terminals/queue/prompt UIs are largely untested) — **M**
- ☐ Backend `compose-turn`, `snapshot`, `role-session`, `scaffold`, `validate` units — **S**
- ☐ One end-to-end test exercising live PTY → WS → xterm — **M**

## Epic 4 — AI Team product maturity

The Team works, but lacks the surfaces a polished "AI dev team" product needs.

- ◐ **Diff / changed-files / PR view** of what agents actually wrote — *changed-files list + colorized working-tree diff vs HEAD shipped (the "Changes" drawer); remaining: per-file collapse, stage/commit, and one-click PR creation* — **L** · *core product value*
- ☐ **Wire `TaskDirective` actions** (claim/complete/block/needs_work/request_review) into the task board, or remove the advertised contract — **M** · *documented capability is silently dropped*
- ☐ **Token/cost + duration tracking & display** (per-role and per-run); enable the dormant budget/time guards in `completion.ts` — **L**
- ☐ **Run history**: list + re-open past runs (endpoint + UI; `loadLatestRun` already exists) — **M**
- ☐ Fix `DoneGateState.satisfied` to reflect the *full* completion gate + show open blockers in the UI — **S**
- ☐ Live **artifact/diff WS events**; emit the declared-but-unused `role`/`done`/`steering` events — **S**
- ☐ Completion/blocked/failed **notifications** (OS + optional webhook) — **S**
- ☐ Pause/steer a **single role**; mid-run role add/remove/reconfigure — **M**
- ☐ **Real verification records** (command + exit code) instead of regex `inferVerificationOutcome` — **M**
- ☐ Transcript/artifact **export** (download JSON/markdown) — **S**
- ☐ Remove dead `teamTerminalId`; back the `[] as never[]` store stubs (turns/verifications/signoffs) with real data — **S**

## Epic 5 — Tiger pipeline robustness

- ☐ **Semantic completion gate** for executing-plan/review: treat a missing `EXECUTION_RESULT`/`FIX_RESULT` self-report as `blocked`, not `done` (non-reporting agents silently pass today) — **S**
- ☐ Make `maxConcurrent` actually **cap parallelism** (config value is currently ignored; a 20-task stage spawns 20 PTYs) — **S**
- ☐ **Auto-resume** interrupted fan-out stages on attach (reconcile flags them but nothing re-dispatches) — **M**
- ☐ Escalate **lease-heartbeat failure** to a hard stop (prevent split-brain double execution) — **S**
- ☐ Gate `deleteTigerOnComplete` / `cleanupAfterAutoRun` behind explicit confirmation + verified success (silent `fs.rm` data-loss today) — **S**
- ☐ Validate upstream artifacts before auto-advancing / Run-All from a mid stage — **S**

## Epic 6 — Terminals & Queue scale/resilience

- ☐ **Virtualize the terminal grid** + WebGL renderer (one xterm per terminal, no virtualization, won't survive dozens) — **M**
- ☐ Queue: `SKIP LOCKED`/row-lock + owner/expiry check on `leaseNext`/`reclaimStaleLeases` (double-lease & steal-live-job latent bugs) — **M**
- ☐ Queue: **retry backoff + cap** in `failJob` (a deterministically-failing job hot-loops today) — **S**
- ☐ **Fail-open** when the `limit_snapshots` table is missing instead of silently blocking all dispatch — **S** · *footgun*
- ☐ `getState` N+1 `listSteps` → set-based query; `replacePositions` → bulk SQL — **M**
- ☐ Make `ctx.save()` failures not diverge in-memory state from disk (routes mutate before save) — **S**
- ☐ Scrollback persistence / reconnect-to-orphaned-pty across backend restart — **L**
- ☐ Drag-and-drop queue reorder; bulk ops; per-provider concurrency lanes — **M**

## Epic 7 — Accessibility & internationalization

- ☐ Enable xterm `screenReaderMode`; ARIA live regions for status/broadcast/queue transitions — **M**
- ☐ Dialog/overlay `role`+focus-trap+`Esc`; roving `tabindex` on tabs/lists; input labels; keyboard nav for terminal list — **M**
- ☐ Replace `confirm()`/`alert()` with the app's styled modal everywhere — **S**
- ☐ i18n scaffolding (vue-i18n) + non-English reset-text parsing fallback in `resetParse.ts` — **L**

## Epic 8 — Data & persistence integrity

- ☑ Migration 008 missing `utf8mb4` engine clause → fixed + `009` ALTER for existing DBs
- ☐ Down/rollback migrations + contiguous, zero-padded migration IDs — **S**
- ☐ Collapse the dual limit-snapshot source of truth (MySQL + `state.json`) — **S**
- ☐ Limit-rules CRUD (endpoint + UI) or remove the read-only rule-editor scaffolding — **M**

---

### Suggested sequencing

1. **Now:** Epic 0 (foundation) + the quick, safe correctness/footgun fixes from Epics 5–6–8 (semantic gate, `maxConcurrent`, queue fail-open + backoff, charset ✅).
2. **Next:** Epic 1 (auth + workspace enforcement) and Epic 2 (observability) — they unblock everything else and de-risk the RCE surface.
3. **Then:** Epic 3 (tests) in parallel with the headline Epic 4 product features (diff/PR view, cost tracking, run history).
4. **Ongoing:** Epics 7 (a11y/i18n) and 8 as polish passes.
