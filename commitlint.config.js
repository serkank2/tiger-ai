// Commitlint configuration — Conventional Commits.
//
// Commit messages are validated against the Conventional Commits spec
// (https://www.conventionalcommits.org). This drives the CHANGELOG and a
// predictable, machine-readable history. Format:
//
//   <type>(<optional scope>): <subject>
//
// Common types: feat, fix, docs, style, refactor, perf, test, build, ci,
// chore, revert. Scopes used in this repo include: backend, frontend, team,
// tiger, queue, db, ws, ci, docs.
//
// Run manually:  npx commitlint --from=HEAD~1
// Wire into a commit-msg hook (e.g. husky) to enforce on commit.

/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Allow a slightly longer header than the 72-char default; this repo's
    // history favors descriptive subjects.
    'header-max-length': [2, 'always', 100],
    // Body/footer line length is advisory, not a hard gate.
    'body-max-line-length': [1, 'always', 100],
  },
};
