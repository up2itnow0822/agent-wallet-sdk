# AGENTS.md — CI helpers

## Purpose and ownership

Maintainers own deterministic CI utilities. They do not sign transactions.

## Local contracts

- `security-scan.mjs` validates full commit SHAs and reads NUL-delimited git
  filenames. Never place a changed filename into executable shell source.
- Scan filesystem paths as data, reject non-regular source files, and report
  locations rather than potentially sensitive source text.
- The pattern scan is a heuristic and must not be described as a complete audit.
- `security-check.mjs` is the `build`/`verify` dependency-audit gate. High and
  critical findings fail closed. GHSA-fc5q-39xc-vjpf may be excepted only when
  every `via` chain ends at that advisory, the prod tree has zero high/critical
  and no picomatch, GitHub lists no patched picomatch, and the clock is before
  2026-12-15 23:59 America/Chicago. Lookup failure, expiry, mixed, cyclic,
  unresolved, or unknown chains block. No skip flag or env bypass.

## Verification

Run `npm test -- test/security-scan.test.ts`, including crafted-filename and
dangerous-pattern cases. Run `npm test -- test/security-check.test.ts` for the
audit-gate fixtures. `npm audit --omit=dev --audit-level=high` must report
zero high/critical. No live funds or production credentials.
