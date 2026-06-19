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

### Added
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
