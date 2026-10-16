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
- X402 settlements must bind proof to a call-time request snapshot and retain unresolved payee or protocol-fee phases with their reservation; unknown or queued phases never authorize another transfer or become `X-PAYMENT` proof. A confirmed protocol fee stays in the client daily total when the payee transfer fails; the retry reserves only the payee amount.
- Spend attempts classify as `settled` | `released` | `hold-unknown`. Only a successful receipt plus valid EVM tx hash(es) may commit a reservation. Definite not-charged outcomes may release and retry. Unknown outcomes stay locked until on-chain reconcile; a timer never unlocks them.
- `SpendingPolicy.reserve` holds capacity before execute. `check()` remains a reserve-then-commit compatibility wrapper.
- `createX402Fetch` / `wrapWithX402` / `X402Client.fetch` must materialize `Request` method, headers, and body before the first hop so a 402 retry cannot collapse to GET.
- `selectPaymentOption` / `executePayment` must reject 402 networks whose chain id is missing or differs from `wallet.chain.id`. Transfers always submit on the wallet chain.
- Only a fresh `reserve` result with status `reserved` authorizes execution.
  An `existing` reservation is a view of the original intent, never permission
  to execute again. Approved drafts authorize one reservation; unresolved and
  committed claims cannot be replayed or mutated through returned objects.
- HTTP delivery or encoding failures after payment never release a confirmed
  debit. Unicode payloads and recipient/asset validation must be safe before
  the first fee or payee submission.
- An RPC submission error can mean broadcast without a returned hash. Keep
  the intent and its capacity locked; never infer non-payment from the absence
  of a hash. Recovery must verify the original submission rather than retry it.
- Public fetch wrappers and retained Eliza fetch sessions expose reconciliation
  on that original client. Configuration guards apply to recovery too; creating
  a replacement client is never a way to resolve a retained hold.
- A queued error takes precedence over the success of its outer receipt. Only
  separate verified execution evidence can settle the pending transfer.
- Reissued challenges extend the protected retry window monotonically; a later
  shorter timeout never reduces it or permits another fee/payee transfer.
  Unkeyed settlements stay protected until proof delivery succeeds; a later
  identical request is then a new purchase.
- The environment and Eliza helpers use wallet-chain USDC only. Runtime
  refreshes retain client budget and unresolved holds; different runtimes never
  share a signer. Configuration changes must not silently reset these controls.
- Configured nonempty USDC caps must parse exactly with no floating point or
  rounding; malformed, negative or over-precision values fail before writes or
  client creation. Blank optional settings retain documented defaults.
- ERC-8004 metadata has no default external network fetch. Caller resolvers
  explicitly own destination, DNS, redirect and connection security. Bound
  inline data and accepted resolver output, and confirm ownership at one block.
- Bridge recovery uses a known burn transaction and the Circle V2 `messages`
  response. Bind Circle entries to that burn before treating `error` status.
  Mint only the returned attested message after matching immutable burn terms.
  Recovery never creates a second burn. A retained destination mint hash is
  reconciled before another `receiveMessage` submission.

## Work Guidance

- Treat bridge, swap, escrow, token transfer, and transaction-submitting paths
  as funds-sensitive code.
- Keep network and deployment claims traceable to implementation or tests.

## Verification

- Run `npm run build` and `npm test`.
- Run `npm run lint` when source files change.

## Child DOX Index

- No child contracts are currently defined.
