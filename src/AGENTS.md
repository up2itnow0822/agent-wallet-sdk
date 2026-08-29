# AGENTS.md -- Agent Wallet SDK Source

## Purpose

- This directory contains the TypeScript implementation exported by the
  `agentwallet-sdk` npm package.

## Ownership

- The Agent Wallet SDK maintainers own source behavior, public exports, and
  source-level tests.

## Local Contracts

- Preserve non-custodial key control and fail-closed spending limits.
- Keep optional-chain dependencies lazy so core EVM use does not require them.
- Pair behavioral changes with tests in the nearest existing test directory.
- Keep public exports and generated declaration output consistent.

## Work Guidance

- Treat bridge, swap, escrow, token transfer, and transaction-submitting paths
  as funds-sensitive code.
- Keep network and deployment claims traceable to implementation or tests.

## Verification

- Run `npm run build` and `npm test`.
- Run `npm run lint` when source files change.

## Child DOX Index

- No child contracts are currently defined.
