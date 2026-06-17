# Kaplan Feature Verification Matrix

Generated for TASK-012 on 2026-06-17.

## Sign-Off Summary

The current Kaplan product validates green for the automated checks required by TASK-012:

- `npm test -w @kaplan/backend`: passed, 54 tests, 0 failures.
- `npm run typecheck -w @kaplan/backend`: passed.
- `npm run build:frontend`: passed. Nuxt completed with non-fatal warnings about sourcemaps, chunk size, and a Vue package deprecation.

Core smoke coverage also passed against an isolated backend instance using a temporary data directory and OS-selected loopback port. The smoke covered health, settings/theme, groups, terminal create/edit/start/stop/restart/remove, env preservation, running-edit `pendingRestart`, WebSocket attach, broadcast to selected terminals, protected-terminal skip reporting, prompt library CRUD/rename/delete, Tiger project initialization/listing, built-in templates, artifact viewing, usage endpoint shape, and final-review correction routing.

## Feature Matrix

| Capability | Intended behavior | Verdict | Evidence |
| --- | --- | --- | --- |
| Terminals: create | Create terminal definitions with name, group, cwd, shell, env, initial command, autostart, and protected flag; reject invalid cwd, shell, group, env, or overlong initial command. | Verified | REST smoke created a terminal with group, `cmd` shell, initial command, and env including an empty string value. `terminals.routes.ts` validates inputs before mutating state. |
| Terminals: edit | Editing stopped terminals applies immediately; editing a running terminal defers runtime-affecting cwd/shell/env/initial-command changes until restart and returns `pendingRestart: true`. | Fixed | TASK-008 added `TerminalSession` pending definition handling and `pendingRestart` response. `npm test` includes running/stopped edit tests. REST smoke confirmed `pendingRestart: true` while running. |
| Terminals: start/stop/restart | Lifecycle endpoints are idempotent for known terminals where appropriate, preserve size, and do not spawn during shutdown. Restart uses the latest committed definition. | Verified | REST smoke started, stopped, and restarted a real pty. Backend tests cover session lifecycle through `TerminalSession.test.ts` and `AgentSession.test.ts`. |
| Terminals: remove | Removing a terminal disposes the live session, deletes manager state, clears saved definition, and prevents concurrent route/start from resolving the deleted id. | Verified | REST smoke deleted both normal and protected test terminals. `TerminalManager.remove()` removes definition before disposing session. |
| Terminals: broadcast | Command routing sends input to selected, group, or all targets, applies newline/start settings, reports matched/written/failed targets, and settles frontend waiters distinctly for success, timeout, disconnect, or not-sent. | Fixed | TASK-010 changed frontend `BroadcastOutcome` to a discriminated union. WebSocket smoke sent a broadcast and received `term.broadcastResult`. |
| Terminals: protected | Protected terminals are excluded from fan-out/bulk commands and from frontend bulk selection, while direct lifecycle actions remain available. | Verified | WebSocket smoke broadcast to one normal plus one protected terminal and received one write plus `PROTECTED` failure. Store selection excludes protected terminals. |
| Terminals: env | Environment maps accept string values, preserve empty values such as `FOO=`, and merge with process env so OS-required variables remain available. | Verified | REST smoke created `EMPTY_VALUE: ""` and read it back unchanged. `TerminalSession.ts` merges definition env over `process.env`. |
| Groups | Groups can be listed, created, edited, and removed; deleting a group unassigns terminals from that group. | Verified | REST smoke created, updated, and deleted a group. `groups.routes.ts` unassigns terminal `groupId` on delete. |
| Settings and theme | Settings persist theme, default cwd/shell, and command-routing preferences; frontend applies persisted theme and recolors terminals. | Verified | REST smoke loaded and updated settings/theme and command routing. `theme.ts` applies/persists selected theme through settings. |
| Prompt library and composer | Prompt files can be listed, created, opened, updated, renamed, and deleted; composer renders and sends prompts through the existing broadcast path with transport failure messages. | Fixed | REST smoke created/read/renamed/deleted a prompt. TASK-010 updated `PromptComposerModal.vue` for explicit broadcast outcomes. |
| Tiger project launcher | User can initialize a workspace, scaffold `.tiger`, preserve/load project prompt, list/open/close/forget known projects, and recover project status from artifacts. | Verified | REST smoke initialized a temporary workspace and listed known projects. `Orchestrator.initialize()` and `listProjects()` cover scaffold and status reconstruction. |
| Per-stage run | Running a stage creates agent runs, protected ephemeral terminals, prompt/runtime files, output paths, marker detection, retry/continue controls, and live `tiger.state` updates. | Verified | Backend tests cover prompt composition, output validation, marker/exit/idle completion, and prompt contract preservation. Smoke verified Tiger state and control endpoints. |
| Run All and templates | Run All starts from the first incomplete or selected stage using per-stage configs; built-in templates include Optimum, Balanced, Fast, and Thorough; custom templates round-trip as Markdown. | Fixed | TASK-004 added Optimum defaults/templates. `templates.test.ts` covers built-ins, slugging, and custom template round-trip. Smoke confirmed the `Optimum` template is exposed. |
| Task execution | Merged tasks split into per-task files, agents claim one task by atomic rename, outputs parse `EXECUTION_RESULT`, and task summaries update. | Verified | `tasks.test.ts` covers parsing, splitting, atomic claim, finish, review status, and result parsing. TASK-005 wired the automatic stale `in_progress` reclaim sweep into `Orchestrator.ts` — it runs on workspace attach/load (`Orchestrator.ts:157`) and on entry to the executing-plan stage (`:399`, `:449`) via helpers at `:634-667` — verified end-to-end by `tasks.test.ts:227`. |
| Task review and fix | Review agents partition done tasks, emit `## FINDING` blocks or `No findings.`, findings split into per-finding files, fix agents claim by atomic rename, and results parse `FIX_RESULT`. | Verified | `findings.test.ts`, `prompt-files.test.ts`, and `AgentSession.test.ts` cover parser and queue contracts. TASK-005 also wired the automatic stale `fixing` reclaim sweep into `Orchestrator.ts` — it runs on entry to the task-review stage (`:400`, `:574`) via helpers at `:634-667` — verified end-to-end by `findings.test.ts:96`. |
| Final review and correction routing | Final review receives a concise pipeline summary, records final decision values, writes a final summary, and unresolved work can be routed back to executing-plan or task-review within configured cycle limits. | Fixed | Prompt contract tests assert final decision vocabulary. REST smoke called `/api/tiger/route` and verified `currentStage: executing-plan`. |
| Usage probing | Usage endpoint probes Claude/Codex usage panels best-effort and returns a stable shape with entries, raw output, highlights, errors, and timestamps. | Verified | `usage.test.ts` covers Claude/Codex parser fixtures and de-duplication. REST smoke verified `/api/tiger/usage` returns both `claude` and `codex` probes. |
| Artifact viewing | UI/backend can read bounded files within the active `.tiger` root and reject absolute paths, traversal, directories, missing files, and oversized files. | Verified | REST smoke read `project-prompt.md` through `/api/tiger/file`. `Orchestrator.readArtifact()` path-guards and size-limits artifact reads. |

## Optimum Token Evidence

TASK-002 optimized composed-prompt assembly by shrinking the automation preamble, adding prompt-size measurement, and replacing alphabetical context selection with deterministic priority/size/recency ranking. The current-source TASK-002 execution log records:

| Representative composed prompt | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| `writing-plan` with several upstream docs | 8044 characters, approximately 2011 tokens | 7815 characters, approximately 1954 tokens | 229 characters, approximately 57 tokens |
| `executing-plan` with one assigned task | 4311 characters, approximately 1078 tokens | 4083 characters, approximately 1021 tokens | 228 characters, approximately 57 tokens |

TASK-003 then right-sized the seven stage prompts plus `FIX_FINDING_PROMPT` while preserving parser-critical headings and markers:

| Prompt body set | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Eight runtime prompt bodies | 15862 characters | 14142 characters | 1720 characters |

Token counts are approximate by design, using the implemented `ceil(characters / 4)` estimator. Exact provider billing can vary by tokenizer, but the measured source-controlled input size is lower while contract tests still pass.

## Deferred Items

No deferred items remain from the TASK-012 verification pass. The frontend fallback defaults for Tiger run configs were aligned with the backend Optimum profile during final review.

## Validation Commands

Executed from `C:\Users\serkan\PROJECT\Kaplan`:

```powershell
npm test -w @kaplan/backend
npm run typecheck -w @kaplan/backend
npm run build:frontend
```

Manual smoke command summary:

- Started backend through `node .\node_modules\tsx\dist\cli.mjs apps\backend\src\index.ts`.
- Used temporary `KAPLAN_DATA_DIR`, temporary `KAPLAN_PROMPTS_DIR`, and an OS-selected loopback port.
- Exercised REST and WebSocket flows listed in the sign-off summary.
- Final result: `SMOKE_RESULT: passed`.

Non-product harness notes:

- One early smoke attempt used `ProcessStartInfo.ArgumentList`, which is unavailable in Windows PowerShell in this environment.
- One early retry selected a random Windows-reserved port and failed with `listen EACCES`; the final run used an OS-selected available port and passed.
