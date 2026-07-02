# Kaplan v2 — Redesign

This document is the product + engineering redesign of Kaplan. It is the output of a full
business-analysis pass: a re-statement of what Kaplan is for, an evidence-based autopsy of why the
v1 execution model under-delivers ("runs for 10 hours, produces 2 lines of code"), a survey of how
18+ open-source orchestrators solve the same problems, and the v2 architecture + flows that the
rewrite implements. `docs/REWRITE-TASKS.md` is the task breakdown that executes this design.

---

## 1. Product definition

**Kaplan is a local-first coordination layer for CLI coding agents.** Its job is NOT to _be_ an
agent and NOT merely to _launch_ agents — it is to **help the agent CLIs do their best work**:

1. **Feed them well** — give each agent a small, precise, self-contained brief instead of a wall of
   repeated context.
2. **Carry their communication** — move decisions, results, and hand-offs between agents (and the
   human) over structured machine channels, not prose files.
3. **Verify their claims** — run the build/test/lint itself and treat exit codes, not agent
   optimism, as truth.
4. **Show the human what matters** — live progress, diffs, costs, and one-click steering.

The user is a single developer running Claude Code / Codex / Antigravity locally against real
repositories, who wants to hand Kaplan a goal in the evening and find reviewed, verified, merged
work in the morning — at a defensible token cost.

### What "good" looks like (acceptance north star)

- ≥ 80% of total agent wall-clock time is spent _producing or verifying product changes_, not
  coordinating.
- Zero tokens spent re-sending content an agent session has already seen.
- A run can always answer: _what is being worked on right now, what is blocked on what, what did
  each turn cost_.
- No completion signal is ever inferred from silence (idle timers) — every completion is an
  explicit machine event.

---

## 2. Why v1 under-delivers — the autopsy

v1 works, but its architecture multiplies overhead between every unit of real work. Five compounding
design faults:

### Fault 1 — Human simulation instead of machine interfaces

v1 drives _interactive TUIs_: it spawns `claude` / `codex` / `agy` in a PTY, **types**
"Please read the file …" into the REPL, presses Enter, auto-accepts the trust dialog with `\r`,
then **polls for a `.done` marker file** with output-idle heuristics, dead-stall detection, and
hard timeouts (`role-session.ts`, `AgentSession.ts`).

Every CLI Kaplan supports has a first-class machine interface (verified locally):

| CLI      | Headless run                     | Structured output                                       | Session continuity                                        |
| -------- | -------------------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `claude` | `-p` (trust dialog auto-skipped) | `--output-format stream-json`, `--json-schema`          | `--session-id <uuid>`, `--resume <id>`, `--fork-session`  |
| `codex`  | `exec`                           | `--json` (JSONL events), `--output-schema`, `-o <file>` | `exec resume <id>`, `app-server` (JSON-RPC `thread_fork`) |
| `agy`    | `--print`                        | text (stdout unreliable → file fallback)                | `--conversation <id>`, `--continue`                       |

Consequences of ignoring them: minutes lost per turn to idle-detection; sessions "poisoned" and
killed on timeout (losing all accumulated context); a forgotten marker file wastes an entire turn;
~1,000+ lines of stall/poison/reclaim machinery exist only to compensate.

### Fault 2 — A prose-file contract instead of structured results

Agents must hand-write fenced `TeamMessage` / `TaskDirective` / `VerificationDirective` JSON blocks
into an output `.md` file, which the orchestrator parses after the fact. A malformed block turns
the whole completed turn into a synthetic "blocker". Both major CLIs can _enforce_ an output
schema themselves (`--json-schema` / `--output-schema`) — v1 uses neither.

### Fault 3 — The token inferno: full context re-sent every turn

`compose-turn.ts` rebuilds every turn's prompt from scratch: automation preamble (~1.7k chars) +
persona + 11 "engineering laws" (~4k) + output contract (~4.5k) + the full project prompt + **up to
160,000 characters of transcript window** — _even when the turn is fed into a persistent session
that already has all of it in context_. This is the direct cause of "the same things are read over
and over". A 40-turn run re-transmits the same material dozens of times and then asks the CLI to
`/compact` — by literally typing `/compact` into the TUI.

### Fault 4 — Coordination theater

v1's Team is a turn-based role chat: user prompt → **Lead turn** (assign) → worker turn → **Lead
review turn** → next assignment. Each of those is a full CLI turn with the Fault-3 prompt. One unit
of real work costs 2–3 coordination turns; standing personas (analyst/reviewer/tester) burn further
turns producing chat, sign-offs and ceremony. The done-gate then demands _fresh sign-offs from
every required role_, which triggers yet more turns that produce no code. This is the
ChatDev/MetaGPT pattern, and the evidence (see §3) is unambiguous that it is the wrong pattern for
real repositories.

### Fault 5 — Verification by testimony

Whether checks pass is (post-overhaul) reported by agents via `VerificationDirective`. The
orchestrator still never runs anything itself, so a gate can only be as honest as the most
optimistic agent, and "fresh verification" costs another agent turn instead of a `spawn()`.

**Net effect:** wall-clock and tokens scale with _coordination_, not with _work_ — precisely the
observed "10 hours → 2 lines of code".

---

## 3. Competitive research — 18 projects/sources, what actually works

Deep-dived this pass: **ruvnet/ruflo**, **vibe-kanban** (source-level: `claude.rs`, `codex.rs`),
**OpenHands**, **SWE-agent**, **Aider**, **goose**, **claude-squad**, **Crystal/Nimbalyst**,
**Plandex**, plus the CLIs' own machine interfaces (claude/codex/agy, verified locally), the
Cognition "Don't Build Multi-Agents" essay, Anthropic's multi-agent research write-up, and the
Berkeley MAST failure-taxonomy paper. Previously deep-dived for Epic 9 (see `ROADMAP.md`):
**Maestro**, **agtx**, **CAO**, **CodeMachine**, **myclaude**, plus vibe-kanban. Role-chat
frameworks assessed as the anti-pattern class: **MetaGPT**, **ChatDev**, **CrewAI**, **AutoGen**
(with **LangGraph** as the good "control flow as code" exception).

| Project             | Execution                                                   | Agent ↔ orchestrator channel              | Context strategy                                           | Completion signal                                                     |
| ------------------- | ----------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| vibe-kanban         | `claude -p --output-format=stream-json`; `codex app-server` | NDJSON stdout / JSON-RPC                  | `--resume <session>` — follow-up sends only the new prompt | process exit + `Result` event                                         |
| ruflo (claude-flow) | Claude Code as substrate                                    | ~210 MCP tools                            | vector-DB memory                                           | planner + tool calls                                                  |
| OpenHands           | sandboxed runtime                                           | typed Action/Observation event stream     | condenser (summarize old events)                           | explicit `AgentFinishAction`                                          |
| SWE-agent           | custom ACI commands                                         | structured commands, concise observations | windowed views                                             | explicit submit                                                       |
| Aider               | single API agent                                            | —                                         | graph-ranked repo map under a ~1k-token budget             | user turn                                                             |
| goose               | Rust agent core                                             | _everything_ is an MCP extension          | provider-side                                              | tool-driven                                                           |
| claude-squad        | interactive CLIs                                            | human supervises via tmux                 | worktree per session                                       | human diff review                                                     |
| Plandex             | API agent                                                   | —                                         | tree-sitter project map, load-per-step, caching            | diff sandbox apply                                                    |
| MetaGPT / ChatDev   | role SOPs / chat chains                                     | shared chat                               | docs-as-memory                                             | phase end — **anti-pattern**: role-play burns tokens, toy-app ceiling |
| LangGraph           | graph nodes                                                 | typed state channels                      | checkpointing                                              | explicit edges — control flow lives in **code**                       |

**Load-bearing external findings:**

- Cognition: _"Share full agent traces, not just individual messages"_; _"actions carry implicit
  decisions, and conflicting decisions carry bad results"_; default to **single-threaded agents**,
  add a dedicated compression step for long histories.
- Anthropic: orchestrator-worker shines on _parallelizable, read-heavy_ work with **detailed task
  briefs**; multi-agent ≈ **15× chat token cost**; _"most coding tasks involve fewer truly
  parallelizable tasks than research."_
- MAST (arXiv 2503.13657): the dominant failure classes in multi-agent LLM systems are
  **inter-agent misalignment** and **weak task verification** — exactly Faults 4 and 5.

**Distilled principles for Kaplan v2:**

1. **Machine interface, never human simulation** (vibe-kanban) — headless runs, structured event
   streams, resume-by-id.
2. **Structured results enforced by the CLI** (`--json-schema` / `--output-schema`) — parsing can
   no longer fail an otherwise-good turn.
3. **Control flow lives in code, not in a Lead's chat turns** (LangGraph, Cognition) — the
   orchestrator is a deterministic state machine over a work graph; LLM turns are spent only on
   plan / implement / review.
4. **Fewer, stronger agents** (Cognition, Anthropic) — one primary worker with full context by
   default; parallelism only for independent tasks, each isolated in a git worktree.
5. **Help the tool** (SWE-agent's ACI, Aider's repo map, Plandex) — Kaplan pre-computes small,
   ranked context (project map, task brief, delta of new messages) instead of dumping transcripts.
6. **Verification is deterministic** (MAST) — Kaplan runs the commands and records exit codes;
   agents never self-certify.
7. **The diff is the review unit** (vibe-kanban, claude-squad, Plandex) — not the conversation.
8. **Cost is a first-class metric** — stream events carry usage/cost; surface per turn/task/run.

---

## 4. v2 architecture

```
┌───────────────────────────── Frontend (Nuxt) ─────────────────────────────┐
│ Runs board · live turn stream · diff review · cost meter · steering      │
└──────────────▲──────────────────────────────REST (control) / WS (data)───┘
               │
┌──────────────┴───────────────────────────── Backend ──────────────────────┐
│                                                                            │
│  WorkGraph engine (team/)        AgentRuntime (agents/)                    │
│  ─ tasks + dependencies          ─ providers: claude · codex · agy         │
│  ─ phases: plan→build→verify     ─ headless spawn, NDJSON event stream     │
│    →review→done                  ─ session registry (resume ids)           │
│  ─ deterministic scheduler       ─ normalized AgentEvent + cost/usage      │
│                                                                            │
│  ContextService (context/)       VerificationService (verify/)             │
│  ─ task briefs (delta only)      ─ runs build/test/lint itself             │
│  ─ project map (budgeted)        ─ exit codes are the only truth           │
│                                                                            │
│  Coordination bus: expanded MCP server (mcp/) — agents claim/report/query  │
│  Git layer: worktree-per-parallel-task, diff, merge-back (git/)            │
│  Durable: MySQL (runs, tasks, turns, costs) · queue · limits · terminals   │
└────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 AgentRuntime — the new execution core (replaces PTY-driving for agents)

- **One turn = one headless process** (or one message to a live `app-server`/`stream-json`
  session): `claude -p --output-format stream-json --session-id/--resume …`,
  `codex exec --json` / `codex exec resume <id>`, `agy --print --conversation <id>`.
- stdout is parsed as an **event stream** normalized into `AgentEvent`
  (`turn-started` · `text` · `tool-use` · `usage` · `result` · `error`), broadcast over WS so the
  UI still shows live activity — richer than raw PTY scrollback (the Terminals feature keeps PTYs
  for _human_ terminals; agents no longer run through typing simulation).
- **Completion = the provider's own result event + process exit.** Marker files, output-idle
  heuristics, dead-stall detection, `/compact`-typing: deleted.
- **Session continuity by id.** The `SessionRegistry` stores each work item's provider session id;
  a follow-up turn sends _only the new instruction_. Context accumulation is the provider's job
  (which it already does well); Kaplan never re-sends history.
- **Structured final output** enforced with `--json-schema` (claude) / `--output-schema` (codex);
  `agy` falls back to a result file (its stdout is unreliable). The result schema is small:
  `{ status: done|blocked, summary, followUpTasks?, verificationRequests? }`.

### 4.2 WorkGraph engine — replaces the role-chat Team and subsumes Tiger

The unit of orchestration is a **work item**, not a role turn:

- `plan` items produce/extend the task graph (one planning agent, full context, detailed briefs —
  the Anthropic lesson).
- `build` items implement one task each; independent tasks may run in parallel **only** in
  isolated worktrees; dependent tasks are sequenced by the graph.
- `verify` items are **not agent turns** — the VerificationService runs configured commands and
  records exit codes.
- `review` items review a _diff_ against the task brief and either approve or emit fix tasks.
- The run completes when the graph is drained and the final verification is green. No standing
  personas, no sign-off ceremony, no Lead-review-of-every-message. Steering inserts a
  re-plan item at the next boundary.

Scheduling is a pure function over the graph (ready = deps done; writers serialized unless
isolated), and every state transition is an explicit, persisted event.

### 4.3 ContextService — "feed them well"

- **Task brief** = goal + task description + acceptance criteria + _delta_ of relevant new events
  since the session last ran (never the full transcript — the session already has its history).
- **Project map** = budgeted, ranked file/symbol map (Aider-style, simple ranking to start) built
  once per run and refreshed on demand — so agents stop re-discovering the repo every turn.
- Static preamble (automation rules + output contract) shrinks to a few hundred tokens and is sent
  **once per session**, not once per turn.

### 4.4 Coordination bus — MCP grows up

The existing config-gated MCP server expands from 7 read-mostly tools to the agent-facing board
API: `get_brief`, `list_new_messages(afterSeq)`, `post_message`, `claim_task`, `complete_task`,
`add_task`, `request_verification`. Identity comes from a per-turn token Kaplan injects via
`--mcp-config` (claude) / `-c mcp_servers.…` (codex), so a session can only speak as itself
(preserving v1's impersonation guarantee). MCP is the _mid-turn_ channel; the structured final
output remains the turn's authoritative result.

### 4.5 What stays (reviewed, trimmed, re-pointed)

- **Terminals** (PTY manager + xterm UI) — kept for human terminals; no longer the agent substrate.
- **Queue/Scheduler, Limits, security middleware, DB layer** — sound and orthogonal; reviewed and
  integrated with the runtime (limit gate now also reads real per-turn usage from result events).
- **Git worktree layer** — kept; now the _only_ parallelism mechanism for writers.
- **Prompts library, templates, MCP plumbing, WS hub** — kept with adjusted contracts.

---

## 5. Core flows

### 5.1 Single mission run (the default: one strong agent)

```
User → POST /api/runs {goal, workspace, profile}
Kaplan: build project map → spawn PLAN turn (headless, stream-json)
  ← task graph (structured output, schema-enforced)
loop until graph drained:
  ready task → BUILD turn (resume worker session; brief = task + delta)
    ← live AgentEvents → WS → UI (text, tool use, cost)
    ← structured result {status, summary}
  Kaplan runs verify commands (build/test/lint) → exit codes recorded
  red? → fix task appended (with failing output as brief) → BUILD turn
  green? → REVIEW turn on the diff (separate reviewer session)
    ← approve | fix-tasks
final verification green + graph empty → run done → diff staged for the human
```

### 5.2 Parallel mode (only when the graph proves independence)

Independent `build` tasks fan out, each in its own worktree + own session; merge-back on
completion; conflicts become fix tasks. Writers never share a working tree.

### 5.3 Steering

User message → persisted steering event → at the next graph boundary Kaplan inserts a `plan` item
whose brief = steering + current graph state → planner edits the graph (add/cancel/reprioritize).
No Lead chat-turn required.

### 5.4 Failure recovery

- Process crash → provider session id survives → retry turn resumes the _same_ session (context
  intact — v1 killed and re-briefed from zero).
- Malformed final output is impossible-by-construction for claude/codex (schema); agy falls back
  to result file + one retry.
- A task failing verification twice escalates to `review`; three strikes → `blocked` with the
  evidence attached, run continues on independent branches of the graph.

---

## 6. Success metrics (v2 exit criteria)

1. **Coordination overhead**: coordination turns ÷ total turns < 20% on a reference mission
   (v1: > 60%).
2. **Token efficiency**: repeated-content tokens ≈ 0 (measured: prompt bytes sent per turn is
   O(new information), never O(history)).
3. **Latency**: completion detected < 2s after the provider result event (v1: up to idle-timeout
   minutes).
4. **Truthfulness**: 100% of "verification passed" records carry a Kaplan-executed command + exit
   code.
5. **Legibility**: every run renders a live task graph with per-node cost and duration.

---

## 7. Module mapping (v1 → v2)

| v1                                                                                            | v2                                                                                 |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `team/role-session.ts`, `orchestrator/AgentSession.ts` (PTY typing, markers, idle heuristics) | `agents/` runtime (headless spawn, event streams, session registry) — **replaced** |
| `team/compose-turn.ts` (160k-char re-composition)                                             | `context/` briefs + once-per-session preamble — **replaced**                       |
| `team/message-bus.ts` file contract + output parsing                                          | schema-enforced structured results + MCP bus — **replaced**                        |
| `team/TeamOrchestrator.ts` (4.7k lines, role-chat loop)                                       | `team/` WorkGraph engine — **rewritten**                                           |
| `team/scheduler.ts` (phase/role turn-taking)                                                  | pure graph scheduler — **rewritten**                                               |
| `team/completion.ts` (sign-off done-gate)                                                     | graph-drained + verification-green gate — **rewritten**                            |
| `orchestrator/` Tiger stages                                                                  | preset plan/build/review profiles on the WorkGraph — **absorbed**                  |
| `mcp/tools.ts` (7 read tools)                                                                 | full coordination bus — **expanded**                                               |
| `terminal/`, `queue/`, `limits/`, `security/`, `db/`, `git/`                                  | kept — **reviewed & re-pointed**                                                   |
| frontend `team/tiger` views (chat-centric)                                                    | run board: task graph, live events, diff, costs — **rewritten**                    |

The detailed, sequential execution plan lives in `docs/REWRITE-TASKS.md`.
