# Security Policy

## Threat model (read this first)

Kaplan is a **local-first, single-user developer tool** whose entire purpose is to spawn
real shells and run AI agents that execute commands and edit files on your machine. By
design it is a remote-code-execution surface. Treat it accordingly:

- **Do not expose the backend to an untrusted network.** It currently has no
  authentication. Bind it to `localhost` and keep it there unless you add an auth layer
  in front of it. The WebSocket enforces an origin allowlist (`KAPLAN_CORS_ORIGINS`), but
  the REST API does not authenticate callers.
- **AI agents run with write-capable permissions** on the project you point them at. The
  workspace boundary is currently advisory (instructed in the agent prompt), not
  sandbox-enforced. Only run the team against projects you are willing to let an autonomous
  agent modify.
- **Secrets:** put database credentials in `apps/backend/.env` (gitignored), never in
  source. Provider/CLI credentials are managed by the underlying CLIs (Claude, Codex, …),
  not by Kaplan.

Hardening these (auth, an enforced workspace jail, secret redaction) is on the
[roadmap](docs/ROADMAP.md).

## Supported versions

This project is pre-1.0; only the latest `main` receives security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.** Instead, report
privately via GitHub's [Security Advisories](../../security/advisories/new) for this
repository (or contact the maintainer directly if advisories are unavailable).

Include: a description, reproduction steps, affected version/commit, and impact. We aim to
acknowledge within a few days and will credit reporters who wish to be named once a fix is
released.
