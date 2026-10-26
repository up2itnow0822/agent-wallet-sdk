# AGENTS.md — GitHub workflows

## Purpose and ownership

Maintainers own the verification workflows for the SDK.

## Local contracts

- The `build` and `verify` jobs run build, tests, lint and dependency audit.
- PR-controlled filenames, bodies and metadata are data, never executable
  shell or JavaScript interpolation. Pass commit SHAs through validated inputs.
- PR code runs with read-only permissions and checkout credentials removed.
- Every `uses:` reference is pinned to a full 40-character commit SHA with a
  version comment; update pins only through reviewed PRs (Dependabot).
- Codex reviews every PR automatically and its findings arrive as review
  threads. No workflow gates a merge on Codex review evidence, and agents do
  not request a second Codex pass (`@codex review`) or wait for one.
- Live required-check rules are configured separately in GitHub. Do not claim
  a ruleset was changed solely because a workflow was edited.

## Verification

Run `npm test -- test/security-scan.test.ts` for scanner changes,
`npm test -- test/workflow-security.test.ts` for workflow pins, and the root
verification commands for changes to job behavior.
