# AGENTS.md — CI helpers

## Purpose and ownership

Maintainers own deterministic CI utilities. They do not sign transactions.

## Local contracts

- `security-scan.mjs` validates full commit SHAs and reads NUL-delimited git
  filenames. Never place a changed filename into executable shell source.
- Scan filesystem paths as data, reject non-regular source files, and report
  locations rather than potentially sensitive source text.
- The pattern scan is a heuristic and must not be described as a complete audit.
- `check-dependency-sources.mjs` is a fail-closed, offline check of
  package.json, package-lock.json and `.npmrc`. It rejects `npm:` aliases,
  non-registry specs, non-npmjs lock resolutions, lock name/path mismatches,
  missing integrity, and non-npmjs `.npmrc` registries. There is no skip flag
  and no environment bypass. `scripts/dependency-sources-allowlist.json` ships
  empty and every allowlisted entry is printed.

## Verification

Run `npm test -- test/security-scan.test.ts`, including crafted-filename and
dangerous-pattern cases. Run `npm test -- test/dependency-sources.test.ts`
for the dependency-source fixtures (T0–T10 and the 79592d6 replay). No live
funds or production credentials.
