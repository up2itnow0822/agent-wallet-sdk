# Contributing

Thank you for your interest in contributing!

## Review requirements

Merges to `main` require the GitHub Actions jobs `build`, `verify`, and
`review-gate`. Those required checks stay on `pull_request` (not
`pull_request_target`) so they survive GitHub's 2 November 2026 restriction
on using `pull_request_target` as a required status.

`review-gate` is a job on the `pull_request` CI workflow. It stays red until
`chatgpt-codex-connector[bot]` reviews the current head commit (full SHA, or
a 7+ hex prefix that uniquely resolves to that head and was posted after
GitHub recorded the push) or Bill applies `codex-waived` on that exact head.
Label, comment (created / edited / deleted), and schedule events re-run that
same CI job; they do not post a separate check.

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
`<!-- review-gate-waiver:v1 {"sha","actor","pr"} -->` for the **current**
40-character head, or when the same-tick `labeled` webhook from Bill
carries that exact SHA. A later push needs a new waiver comment. Human
comments that copy the marker do not count.

### Short-SHA Codex comments

Codex often cites a 7-character prefix. Those still count, but only when:

- GitHub uniquely resolves the prefix to the current 40-character head
  (`GET /commits/{prefix}` → this SHA; HTTP 422 ambiguous is a reject), and
- the comment's `created_at` / `updated_at` is after the earliest
  `pull_request` workflow-run or check-suite `created_at` for that SHA
  (platform push/event time, not `commit.committer.date`).

### Refresh budget

`review-gate-refresh` reruns the CI job at most 8 times per run (GitHub's
cap is 50). The 10-minute schedule backs off exponentially (10 / 20 / 40 /
80 minutes) and **does** recheck a green gate after backoff so an edited
or deleted Codex comment is noticed. A new push opens a new CI run.

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
