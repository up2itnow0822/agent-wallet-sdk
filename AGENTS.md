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

## Work Guidance

- Make payment-safety and compatibility changes in small, reviewable slices.
- Keep public claims traceable to code, tests, or independently verified use.
- Preserve unrelated local changes by using isolated worktrees.

## Verification

- Run `npm run build`.
- Run `npm test`.
- Run `npm run lint` when source files change.

## Child DOX Index

- `src/` contains the TypeScript SDK implementation. Local contract:
  `src/AGENTS.md`.
