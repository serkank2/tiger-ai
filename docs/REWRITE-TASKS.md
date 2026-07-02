# Kaplan v2 — Rewrite task breakdown

Executes `docs/REDESIGN.md`. Tasks are **strictly sequential** (one worker, no parallel agents);
each keeps the tree buildable. Status: ☐ todo · ◐ in progress · ☑ done.

> **Status (2026-07-02, second pass):** RT-01…RT-11 and RT-13 are ☑ — the v1 Tiger/Team engines,
> routes, stores, views, and tests are DELETED (schema history preserved in
> `db/legacy-migrations.ts`; queue `project`/`team` targets now dispatch onto the v2 run engine;
> prompt generation runs headless). Remaining: RT-12's diff-review panel on the Runs screen and
> RT-14's README/config-table rewrite. Gates: backend 312 tests, frontend 171 tests, lint 0
> errors, both typechecks + prod build green.

## RT-01 ☑ AgentRuntime foundation (`apps/backend/src/agents/`)

Normalized `AgentEvent` model; `ProviderDriver` interface; drivers for **claude**
(`-p --output-format stream-json --session-id/--resume`, NDJSON mapper), **codex**
(`exec --json` / `exec resume <id>`, JSONL mapper), **antigravity** (`--print
--conversation <id>`, result-file fallback); Windows-safe no-shell spawn helper; `TurnRunner`
(spawn → stream-parse → result on provider result event + exit; hard timeout only; abort).
`SessionRegistry` mapping work-item → provider session id. Unit tests with recorded fixtures.
**Accept:** a turn runs headless end-to-end with zero marker files / idle heuristics.

## RT-02 ☑ Structured result contract (`agents/result.ts`)

`TurnResult` = `{ status: done|blocked, summary, followUpTasks?, verificationRequests? }` as a
JSON schema passed via `--json-schema` (claude) / `--output-schema` (codex); tolerant extraction +
one retry for agy. **Accept:** malformed-output turn loss impossible for claude/codex paths.

## RT-03 ☑ ContextService (`apps/backend/src/context/`)

Task-brief composer: goal + task + acceptance criteria + **delta** of new events since the
session's last seq — never full history to a live session. Budgeted project map (ranked file/dir
summary, Aider-lite). Once-per-session static preamble (few hundred tokens).
**Accept:** measured prompt bytes per follow-up turn = O(new info).

## RT-04 ☑ VerificationService (`apps/backend/src/verify/`)

Kaplan runs configured check commands itself (`spawn`, shell:false, timeout, captured tail),
persists `{command, exitCode, outcome, durationMs, outputTail}`. Presets read from package.json
scripts. **Accept:** the only source of "passed" anywhere is a Kaplan-recorded exit code 0.

## RT-05 ☑ WorkGraph model + pure scheduler (`apps/backend/src/run/graph.ts`)

Work items `plan|build|review` + verification nodes; states
`backlog→ready→running→verifying→reviewing→done|blocked|cancelled`; dependencies; pure
`selectReady()` (writers serialized unless worktree-isolated; bounded concurrency). Persistence:
`.tiger/runs/<runId>/graph.json` + append-only `events.jsonl`, MySQL run index/lease reused.

## RT-06 ☑ WorkGraph engine (`apps/backend/src/run/engine.ts`)

Run loop wiring graph + AgentRuntime + ContextService + VerificationService + git worktrees:
plan turn seeds graph → build turns (resume sessions) → auto-verify → red appends fix task with
failing tail → review turn on diff → approve/fix-tasks → done when drained + green. Steering
inserts re-plan at boundary. Failure policy: resume-same-session retry; 2×-fail → review;
3× → blocked branch, run continues elsewhere. Emits WS events (`run.state`, `run.item`,
`run.event`, `run.cost`).

## RT-07 ☑ MCP coordination bus (`apps/backend/src/mcp/`)

Add `get_brief`, `list_new_messages(afterSeq)`, `post_message`, `claim_task`, `complete_task`,
`add_task`, `request_verification`; per-turn identity token injected via `--mcp-config` /
`-c mcp_servers…`; caller can only speak as itself.

## RT-08 ☑ Control plane (`http/`, `ws/`, `index.ts`, `context.ts`)

`/api/runs` CRUD + start/stop/steer for v2 runs; WS fan-out of engine events; boot wiring;
graceful shutdown aborts turns via AbortSignal (no PTY kills for agents).

## RT-09 ☑ Tiger retired

Tiger pipeline becomes a preset profile (plan→build→review) on the WorkGraph engine; existing
Tiger REST/UI surface mapped or explicitly deprecated; stage-file compose machinery deleted.

## RT-10 ☑ Team v1 decommissioned

`TeamOrchestrator` role-chat loop, role-session PTY driving, compose-turn, message-bus file
contract replaced by engine-backed equivalents; conversation/history kept as the engine's event
log; run history endpoints preserved.

## RT-11 ☑ Support layers reviewed & re-pointed

Limits gate consumes real usage/cost from result events; queue/terminals/security/db reviewed,
dead code deleted (`.done` watchers, stall detection, `/compact` typing, poison/reclaim paths).

## RT-12 ◐ Frontend rewrite of run surfaces (Runs board/live feed/costs/steering landed; diff-review panel + legacy view retirement pending)

Run board (task graph + statuses), live turn stream (normalized events, not scraped PTY), diff
review, cost meter per turn/task/run, steering box; Pinia stores + types aligned to new DTOs;
terminals page untouched (human PTYs).

## RT-13 ☑ Test suite realignment

New units (drivers, result contract, brief composer, graph scheduler, verify service, engine
loop with fake driver); obsolete v1 tests removed with their code; backend + frontend suites
green.

## RT-14 ◐ Docs & release (ARCHITECTURE/AGENTS/CHANGELOG updated; full README/config-table rewrite pending)

README / ARCHITECTURE / AGENTS.md rewritten for v2; CHANGELOG entry; config flag table
(`KAPLAN_*`); migration notes for `.tiger` layout.
