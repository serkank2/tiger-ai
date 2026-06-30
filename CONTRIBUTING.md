# Contributing to Kaplan

Thanks for your interest in improving Kaplan! This guide covers how to get set up, the
standards we hold code to, and how to get a change merged.

## Getting set up

1. **Prerequisites:** Node.js ≥ 20, a local MySQL ≥ 8, and a C/C++ toolchain (for `node-pty`).
2. Fork & clone, then:
   ```bash
   npm install
   cp apps/backend/.env.example apps/backend/.env   # set KAPLAN_DB_PASSWORD
   npm run dev                                        # backend :4517 + frontend :3000
   ```

## Before you open a PR

Every change must pass the same gates CI runs:

```bash
npm run typecheck                 # backend + frontend type-check (must be clean)
npm test -w @kaplan/backend       # backend tests (node:test)
npm test -w @kaplan/frontend      # frontend tests (vitest)
npm run build:frontend            # the SPA must build
```

If you added or changed behavior, **add or update tests** that cover it. Bug fixes should
come with a regression test that fails before the fix and passes after.

## Coding standards

- **TypeScript everywhere**, ESM modules, strict types — no `any` escape hatches without a
  comment explaining why.
- **Match the surrounding code.** Mirror the file's existing naming, comment density, and
  idioms rather than introducing a new style.
- **Architecture boundaries:** REST is the control-plane, the WebSocket is the data-plane.
  Keep one Pinia store per domain on the frontend, and a single authoritative writer per
  persisted artifact on the backend.
- **Comments explain _why_, not _what_.** Prefer a short rationale on a non-obvious decision
  over narrating the code.
- **Errors are values to handle, not noise to swallow.** Surface failures to the user with a
  clear message; never silently `catch {}` something the user needs to know about.

## Commit & PR conventions

- Write focused commits with imperative subject lines (e.g. `team: stop dropping steering on
a failed Lead turn`).
- Keep PRs scoped to one logical change. Describe **what** changed, **why**, and **how you
  verified it** (commands run, manual checks).
- Reference any issue the PR closes.

## Reporting bugs & requesting features

Open an issue using the templates in `.github/ISSUE_TEMPLATE/`. For bugs, include repro
steps, expected vs actual behavior, and your environment (OS, Node version). For security
vulnerabilities, **do not open a public issue** — follow [`SECURITY.md`](SECURITY.md).

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind.
