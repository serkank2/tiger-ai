# Prompt Library + Advanced Composer — Design Spec

Date: 2026-06-16
Status: Approved (v1 scope)
Informed by: 5 Codex consultations (`.codex-notes/pc-1..5`), critically filtered.

## Goal

Let the user keep reusable prompts as `.md` files, edit one in a rich modal, fill in
variables, pick target terminals/groups by drag-and-drop, preview the final text, and
send it — without the single-line command bar's limits. Personal, local, no auth.

## Decisions (locked)

1. **Prompts location:** project root `prompts/` (override via `KAPLAN_PROMPTS_DIR`),
   auto-created if missing. Seeded with example `.md` files.
2. **Default send mode:** **Paste** (write text, *no* trailing Enter). `Run` (append
   Enter) is an explicit per-send toggle. Rationale: accidental Enter across many
   terminals is the top footgun; pasting prompts into AI CLIs (claude/codex) wants no Enter.
3. **v1 scope** as below; listed items deferred to v2.

## Architecture

Reuses existing pieces; adds one backend router + frontend prompt store + composer modal.
**Sending introduces no new write path** — the composer renders variables client-side and
dispatches through the existing `socket.broadcast()` → `term.broadcastInput` →
`TerminalManager.routeInput` (selected/group/all + appendNewline) flow.

### Backend

- `config.promptsDir` = `KAPLAN_PROMPTS_DIR` || `<repoRoot>/prompts`. `mkdir -p` on startup.
- **`.md` format** — optional flat frontmatter + body:
  ```
  ---
  title: Code review
  description: Review a file for bugs
  tags: [review, claude]
  target: group:Frontend      # or `selected` / `all` / `group:<name>`
  run: false                  # false = Paste, true = Run (append newline)
  ---
  Review {{file}} in {{terminal.name}} for correctness and edge cases.
  ```
  - **Variables auto-detected from the body** via `{{name}}` regex (no frontmatter schema).
    *Divergence from Codex's full-YAML `variables:` block — chosen to avoid a `yaml`
    dependency and keep the format trivial to parse and hand-edit.*
  - Built-in variables (evaluated per terminal at send): `{{terminal.name}}`,
    `{{terminal.cwd}}`, `{{date}}` (`YYYY-MM-DD`). Escape with `\{{...}}` → literal.
  - Frontmatter parsed by a minimal flat parser (`key: value`, `tags: [a, b]`). Invalid /
    missing frontmatter ⇒ treat whole file as body with defaults (never destructive).
- **`prompts.ts` path guard** (mirrors `util/paths.ts`): `resolvePromptPath(rel)` rejects
  absolute/UNC/backslash/`..`/empty-segment/non-`.md`/control-char paths and symlinks;
  resolves against `realpath(promptsDir)` and requires the result to stay inside it.
  `MAX_PROMPT_BYTES = 128 * 1024`.
- **REST `/api/prompts`**:
  | Method | Path | Body / Query | Notes |
  |---|---|---|---|
  | GET | `/api/prompts` | — | summaries: `{ path, title, description, tags, target, run, size, mtimeMs, version }` |
  | GET | `/api/prompts/file?path=` | — | full: `{ path, content, body, meta, version }` |
  | POST | `/api/prompts` | `{ path, content, overwrite? }` | 409 if exists |
  | PUT | `/api/prompts/file` | `{ path, content, expectedVersion? }` | atomic tmp+rename; **409 if version stale** |
  | DELETE | `/api/prompts/file?path=` | — | 204 |
  | POST | `/api/prompts/rename` | `{ fromPath, toPath, overwrite?, expectedVersion? }` | inside root only |
  - `version` = `mtimeMs:size` (cheap) or content hash — used for optimistic concurrency.
  - Router gets its own body-size cap (~160 KB).
- Mount in `index.ts`; add `promptsDir` to `config.ts`.

### Frontend

- `stores/prompts.ts` — list, current, dirty flag, CRUD via `useApi()`; client-side
  variable detection + rendering helpers.
- `useApi()` — add the `/api/prompts*` calls.
- **Expand button** (⤢) in `CommandBar.vue` next to the input → opens the composer.
- **`PromptComposerModal.vue`** — 3 columns:
  - **Library** (left): search, file list, `+ New`, `Save`, `Save as`, `Rename`, `Delete`,
    `Refresh`. Shows source filename + unsaved-dirty marker.
  - **Editor** (center): body textarea; auto-detected **variable fill-in panel** (global
    values v1); **Mode: (•) Paste ( ) Run**; live char count + the shell-limit warning
    (reuse `CommandBar`'s `SHELL_LIMITS` logic, extracted to a shared composable/util).
  - **Send to** (right): **Available** panel (terminals grouped, collapsible) → **drop
    zone**. Native HTML5 drag-drop (drag terminal *or* whole group) **plus Add/Remove
    buttons and keyboard activation** for accessibility. `aria-live` announces changes.
    Source of truth: `selectedTermIds: Set<string>`; groups are bulk-add shortcuts that
    normalize to terminal IDs. Already-added rows dimmed; running vs stopped indicated.
  - **Footer**: recipient summary ("Sending to N: a, b") + **Preview** + **Send**.
- **Preview** before send: final rendered text (note per-terminal differences when
  built-ins are used), target list, mode, and warnings (unresolved vars, over-limit).
  Extra confirm for `Run` to many / `all`.
- **Send**: render variables; if per-terminal built-ins are present, loop one broadcast per
  terminal with that terminal's rendered text; otherwise one broadcast to all targets.
  Multi-line bodies wrapped in **bracketed paste** (`\x1b[200~ … \x1b[201~`) so lines don't
  each execute prematurely.

## Test prompts (seeded into `prompts/`)

`code-review.md`, `restart-dev.md`, `claude-task.md`, `git-status.md`, `summarize-logs.md`
— each demonstrating frontmatter, a `target`, `run`, and `{{variables}}` incl. a built-in.

## Adopted from Codex (credited)

Paste-don't-submit default · mandatory pre-send preview · bracketed paste for multi-line ·
per-terminal interpolation · optimistic-concurrency (`expectedVersion`) · single
`resolvePromptPath` security helper · normalize selection to terminal IDs (groups = shortcut).

## Deferred to v2 (with reason)

- **Live folder watch (fs.watch + WS push):** v1 uses refetch-on-open + a Refresh button;
  external-edit clobbering is already prevented by `expectedVersion` 409s.
- **Per-terminal variable override table:** v1 = global user-var values + per-terminal built-ins.
- **Protected terminals** (exclude from group/all): adds data-model surface; revisit later.
- **Dispatch history / replay**, **staggered sends**, **>16K temp-file fallback for Run**:
  valuable but bloat v1; the shell-limit warning already covers the over-limit case.

## Out of scope (project-wide)

Auth, roles, multi-user, cloud sync — unchanged.
