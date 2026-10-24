# AGENTS.md — CI helpers

## Purpose and ownership

Maintainers own deterministic CI utilities. They do not sign transactions.

## Local contracts

- `security-scan.mjs` validates full commit SHAs and reads NUL-delimited git
  filenames. Never place a changed filename into executable shell source.
- Scan filesystem paths as data, reject non-regular source files, and report
  locations rather than potentially sensitive source text.
- The pattern scan is a heuristic and must not be described as a complete audit.

## Verification

Run `npm test -- test/security-scan.test.ts`, including crafted-filename and
dangerous-pattern cases. No live funds or production credentials.
