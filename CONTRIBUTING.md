# Contributing

Thank you for your interest in contributing!

## Review requirements

Merges to `main` require the GitHub Actions jobs `build`, `verify`, and
`review-gate`. `review-gate` is a job on the `pull_request` CI workflow. It
stays red until `chatgpt-codex-connector[bot]` reviews the current head
commit (full SHA or a 7+ hex prefix in a clean Codex summary) or Bill applies
`codex-waived` on that head. Label, review, and comment events re-run that
same CI job; they do not post a separate check.

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
