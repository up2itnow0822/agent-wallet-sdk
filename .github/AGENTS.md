# AGENTS.md — GitHub workflows

## Purpose and ownership

Maintainers own verification and merge-gate workflows for the SDK.

## Local contracts

- The `build` and `verify` jobs run build, tests, lint and dependency audit.
- PR-controlled filenames, bodies and metadata are data, never executable
  shell or JavaScript interpolation. Pass commit SHAs through validated inputs.
- PR code runs with read-only permissions and checkout credentials removed.
- `review-gate` runs from trusted default-branch code and never executes PR code.
- Live required-check rules are configured separately in GitHub. Do not claim
  a ruleset was changed solely because a workflow was edited.

## Verification

Run `npm test -- test/security-scan.test.ts` for scanner changes and the root
verification commands for changes to job behavior.
