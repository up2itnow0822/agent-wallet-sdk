# AGENTS.md -- Agent Wallet SDK

## Purpose

- This repository provides the canonical non-custodial wallet SDK used by the
  AI Agent Economy payment trial.
- It owns spending policy, payment execution, receipts, and supported
  integration surfaces for the `agentwallet-sdk` npm package.

## Ownership

- AI Agent Economy owns the SDK, package, documentation, and release evidence.

## Local Contracts

- Preserve non-custodial key control and fail-closed spending policy behavior.
- Never use live funds, production credentials, or irreversible chain actions
  in default tests.
- Keep npm metadata, README install commands, GitHub releases, and package
  behavior consistent.
- Treat generated `dist/`, coverage, and dependency folders as build outputs.
- `main` is protected by a GitHub ruleset: changes land only through a pull
  request with the `verify` check green and every review thread resolved.
  No direct pushes, force-pushes, or branch deletion.

## Work Guidance

- Make payment-safety and compatibility changes in small, reviewable slices.
- Keep public claims traceable to code, tests, or independently verified use.
- Preserve unrelated local changes by using isolated worktrees.

## Review gate

- The counted `review-gate` check is the `pull_request` CI job named
  exactly `review-gate`. It is not a `checks.create` result. Until this
  branch lands on `main`, `main`'s leftover `checks.create` workflow can
  still publish "Codex reviewed head" for any Codex review on the SHA;
  that is the base-branch evaluator, not this PR's clean-only gate.
- Waiver recording must survive GitHub's 2 November 2026 default block
  on `pull_request_target` for public repos. `record-waiver` therefore
  runs on `schedule` (every 10 minutes) and `workflow_dispatch` from the
  default-branch copy of `.github/workflows/review-gate.yml`. Those
  events read the label timeline: Bill (`up2itnow0822`) must be the
  latest `codex-waived` `labeled` actor after this head's trusted
  arrival (pull_request workflow-run / check-suite `created_at`) and
  after any later `committed` or `head_ref_force_pushed` timeline
  event. Do not use `committed.created_at` — that field does not exist
  on GitHub's committed timeline events. A leftover label after a new
  push does not mint a binding for the new SHA. `pull_request_target`
  stays a faster path while GitHub still allows it. `issue_comment`
  never records a waiver. Evaluate accepts a cited run only when its
  event is `pull_request_target`, `schedule`, or `workflow_dispatch`,
  the path is this workflow file, and `record-waiver` finished with
  `status: completed` and `conclusion: success`. `workflow_dispatch`
  must use the default-branch revision (`run.head_branch`);
  `gh workflow run --ref` of another branch is rejected. Schedule and
  dispatch comments must match a `review-gate-waiver-receipt`
  annotation emitted by that specific job — a bot comment in the
  wall-clock window is not enough. A syntactically valid
  github-actions[bot] marker does not suppress a later genuine record.
  A later `committed` or force-push after the label invalidates a
  persisted binding even if the SHA returns (A→B→A).

## Verification

- Run `npm run build`.
- Run `npm test`.
- Run `npm run lint` when source files change.

## Child DOX Index

- `src/` contains the TypeScript SDK implementation. Local contract:
  `src/AGENTS.md`.
