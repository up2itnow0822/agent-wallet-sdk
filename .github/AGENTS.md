# AGENTS.md — GitHub workflows

## Purpose and ownership

Maintainers own verification and merge-gate workflows for the SDK.

## Local contracts

- The `build` and `verify` jobs run build, tests, lint and dependency audit.
- PR-controlled filenames, bodies and metadata are data, never executable
  shell or JavaScript interpolation. Pass commit SHAs through validated inputs.
- PR code runs with read-only permissions and checkout credentials removed.
- `review-gate` runs from trusted default-branch code and never executes PR code.
- Every `uses:` reference is pinned to a full 40-character commit SHA with a
  version comment; update pins only through reviewed PRs (Dependabot).
- `review-gate` evidence must post-date the base branch's move to its current
  SHA (repository activity log, `after` + `timestamp`, parsed by
  `latestBaseMoveMs`; unknown means fail closed). Its only `push` trigger is
  the protected `main` branch.
- A clean Codex pass (no review object) is proven only by the Codex bot's
  summary `codex-review-state:v1` line: `completed`, no findings, full head
  SHA (`codexCleanSummaryShas`). Gate parsers live between `// BEGIN name`
  and `// END name` markers so tests extract and run them on real payloads. Codex's visible table shows a short SHA, which is never accepted.
  Gate changes take effect only once merged to the default branch.
- Live required-check rules are configured separately in GitHub. Do not claim
  a ruleset was changed solely because a workflow was edited.

## Verification

Run `npm test -- test/security-scan.test.ts` for scanner changes,
`npm test -- test/workflow-security.test.ts` for workflow pins and review-gate
binding, and the root verification commands for changes to job behavior.
