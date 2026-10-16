# Contributing

Thank you for your interest in contributing!

## Review requirements

Merges to `main` require the GitHub Actions jobs `build`, `verify`, and
`review-gate`. Those required checks stay on `pull_request` (not
`pull_request_target`) so they survive GitHub's 2 November 2026 restriction
on using `pull_request_target` as a required status.

`review-gate` is a job on the `pull_request` CI workflow. It stays red until
`chatgpt-codex-connector[bot]` posts a **clean** no-findings review of the
current head (a "Didn't find any major issues" receipt or a summary whose
state has `has_any_findings: false`) — never merely because a Codex review
exists — or Bill applies `codex-waived` on that exact head and base.
Trusted Codex comments (created / edited / deleted), Bill's `codex-waived`
label, base retarget, ready-for-review, reopen, schedule, and dispatch
re-run that same CI job; they do not post a separate check. Author
comments, title/body edits, junk labels, and `github-actions[bot]`
comments (including `security-review.yml`) do not consume a rerun.

### Trusted evaluator

The counted `review-gate` job does **not** check out the PR. It fetches
`scripts/review-gate.mjs` from the PR's **base SHA** (the `main` tip at
open/sync) via the GitHub Contents API and runs that copy. A PR that edits
the evaluator therefore cannot make its own gate pass.

Until this change is on `main`, a PR that already uses the fetch will 404
(the file is not on the base yet) and fail closed. That is expected for
PR #90; Bill's one bypass merge is the intended first landing.

### Residual risk: a PR can still edit `ci.yml`

GitHub runs the **PR's** `.github/workflows/ci.yml` for `pull_request`.
A PR that replaces the fetch/evaluate steps with `exit 0` (or renames /
duplicates a job called `review-gate`) can still mint the required context.
The base-SHA fetch closes the evaluator-rewrite hole; it does not close the
workflow-file hole. This repository's default workflow permissions stay
read-only, and Codex reviews `.github/workflows/`.

That residual risk is a GitHub platform limit, not something this PR can
patch without a ruleset change.

### Write-up for Bill (rulesets — do not edit from this PR)

Ruleset 23222371 already requires `build`, `verify`, and `review-gate` from
GitHub Actions (app 15368) with strict up-to-date. Do **not** move those
required checks onto `pull_request_target`.

Two stronger follow-ups, in order of preference:

1. **Required workflow (best).** Add a repository or org *required
   workflow* (or a ruleset required-workflow entry) that always runs a
   workflow file from `main` / a designated ref. That copy can evaluate
   Codex the same way and publish a required check the PR cannot rewrite.
   This PR does not add that entry.
2. **Pinned action (weaker).** Extract the evaluator into a repo-owned
   Action pinned by commit SHA. A PR can still change the pin in `ci.yml`,
   so this only helps if workflow files are CODEOWNERS-protected and the
   required-workflow option is unavailable.

Either follow-up is a ruleset / org-settings change. Leave it for Bill;
this branch does not edit rulesets.

### Waiver binding

`codex-waived` is honored only when the label is present **and** a
`github-actions[bot]` comment records
`<!-- review-gate-waiver:v1 {"sha","base","baseSha","actor","pr","run","workflow"} -->`
for the **current** head SHA, base ref, and base SHA. Evaluate then fetches
that `run` and requires:

- `path` is `.github/workflows/review-gate.yml`
- `event` is `pull_request_target`, `schedule`, or `workflow_dispatch`
  (GitHub always executes `main`'s copy for those events)
- the run has a successful `record-waiver` job (only that trusted workflow
  defines it)

`record-waiver` does not depend on `pull_request_target` remaining allowed
after 2 November 2026. Schedule (every 10 minutes) and `workflow_dispatch`
scan open PRs from the default-branch copy and post a binding comment only
when Bill's latest `codex-waived` timeline event is `labeled` after the
last head move and base retarget. `pull_request_target` stays a faster
path while GitHub still allows it. `issue_comment` never records a waiver.

The latest waiver-label timeline event must be an allow-listed `labeled`
event (Bill) whose actor matches the persisted record, and the record
comment must be created at or after that event. Removing `codex-waived`
and having someone else re-apply it does not resurrect the old record.

A later push or retarget needs a new waiver. Human comments and comments
posted by other workflows (including a PR-edited `security-review.yml`)
do not count: they can impersonate the bot login but cannot mint a
trusted `review-gate.yml` run that contains `record-waiver`.
Check runs / commit statuses were not used because any PR workflow that
adds `checks: write` or `statuses: write` can also mint those as the
GitHub Actions app.

### Clean Codex reviews

A Codex `COMMENTED` / `APPROVED` review is not enough. The 3a31911 review
had P1s and still produced a review object; the old gate treated that as
"Codex reviewed head". The evaluator now requires a no-findings result.

### Short-SHA Codex comments

Codex often cites a 7-character prefix. Those still count, but only when:

- GitHub uniquely resolves the prefix to the current 40-character head
  (`GET /commits/{prefix}` → this SHA; HTTP 422 ambiguous is a reject), and
- the Code Review row's own `datetime` (summaries) or the receipt's
  `created_at` is after the earliest `pull_request` workflow-run or
  check-suite `created_at` for that SHA (not the comment's overall
  `updated_at`, which Codex rewrites for unrelated security-review activity).

### Refresh budget

`review-gate-refresh` never calls `reRunJobForWorkflowRun` when the
published `review-gate` conclusion already matches evaluate. That stops
green polling from walking into GitHub's 50-rerun-per-run ceiling (~3
days). Schedule still evaluates on the 10-minute cron and reruns only to
*flip* the check (dismissal, new findings, new clean review, waiver
revoke). If reevaluation cannot produce a verdict, an existing green
gate is rerun or ceiling-failed rather than treated as unchanged. A 403
on a green gate fails the refresh job instead of being swallowed.
Waiting-state polls without a verdict still cap at 8.

`pull_request_review` is omitted because GitHub would execute the PR's
copy with `actions: write`. When several Codex results exist on the same
SHA, the newest completed result wins: later findings override an older
clean review or comment.

Fork PRs can have an empty `workflow_run.pull_requests[]` (actions/runner
#3444). Refresh then matches the `pull_request` CI run by head SHA + head
repository + branch. If several open PRs share a SHA and the run cannot be
attributed, refresh fails closed rather than rerunning the wrong job.

## How to Contribute

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m "feat: add my feature"`
4. Push to the branch: `git push origin feature/my-feature`
5. Open a Pull Request

## Code Standards

- Follow existing code style
- Add tests for new functionality
- Update documentation as needed

## Issues

Found a bug or have a feature request? [Open an issue](../../issues/new).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
