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
  behavior consistent. Every lazily imported package is a dependency or an
  optional peer with a tested `>=` floor (`test/package-peers.test.ts`). The
  tarball ships the built library only, never compiled tests
  (`test/package-contents.test.ts`).
- Treat generated `dist/`, coverage, and dependency folders as build outputs.
- Changes to `main` land only through a pull request. The required deployment
  policy is green `build` and `verify` checks, with every review thread
  resolved (live ruleset `23222371`; workflow files do not configure branch
  protection). Codex reviews each PR automatically; evaluate its findings, but
  do not request or wait for a second Codex pass. No direct pushes,
  force-pushes, or branch deletion.
- Environment and plugin USDC budgets must accept only USDC on the configured
  wallet chain. Client recipient allowlists must not be described as on-chain
  enforcement or isolated signing.
- Persist and reconcile in-flight intents outside these in-memory clients
  before restarting a payment service or replacing its configuration.
- Examples default to testnet, require `AGENT_EXAMPLE_LIVE_ACK` for mainnet,
  build wallets with a deployment identity (`exampleDeploymentIdentity()`;
  the unsafe opt-out is refused), verify the advertised on-chain policy
  (caps no looser, period at least one day) before spending, and never run on import (`test/examples-safety.test.ts`).
- Breaking security changes take a new major version; never republish a
  vulnerable version number.

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
- `.github/` contains verification and review workflows. Local contract:
  `.github/AGENTS.md`.
- `scripts/` contains CI helpers. Local contract: `scripts/AGENTS.md`.
