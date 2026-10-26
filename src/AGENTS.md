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

- Untrusted endpoints (RPC, Circle, UAID brokers, Horizon, quoters, x402
  merchants) never choose a signed scale, chain, recipient or settlement
  status. Read their HTTP bodies only through `src/net/bounded-fetch.ts`
  (one deadline over request + body, byte cap); never await a tee'd clone's
  `cancel()`.
- Token transfers pin decimals (registry or caller `expectedDecimals`) and
  bind signer/read/requested chains; Solana signs only after the genesis-hash
  cluster check and uses `TransferChecked`. Amounts never truncate.
- Every AgentAccountV2 write first passes `verifyAgentWallet`, which requires
  a deployment identity (`deployment` or `expectedCodeHash`) unless the caller
  explicitly sets `allowUnverifiedDeployment`. Execution is
  classified only from matching wallet events (`TransactionExecuted` /
  `TransactionQueued`) or, for `agentTransferToken`, a matching ERC-20
  `Transfer`; anything else is `unknown`.
- `SpendingPolicy` snapshots intents once (`snapshotPaymentIntent`). A locked
  reservation is released only by `reconcileLocked` against the submission
  identity and call binding recorded once at lock time; there is no caller
  override and no later hash attachment.
- CCTP: attestations are always bound to a known source message; burn terms
  are checked from the transmitter-emitted `MessageSent`; post-hash failures
  carry frozen recovery; `usedNonces` is checked before `receiveMessage`;
  reported recipients/amounts come from attested bytes.
- UAID `verify()` returns `verified` only after on-chain ERC-8004 checks;
  broker claims are `brokerAttested`. The resolution cache is a bounded LRU.
- Stellar auto-pay requires a spend policy reserved before signing; Horizon
  must report the configured network; success needs the signed-XDR hash,
  `successful === true` and a ledger confirmation.
- Swaps require a caller `minAmountOut`. Explicit unknown chains throw.
- x402 binds origin+path+query, bounds the 402 body, binds explicit intents to
  the request fingerprint, and wrappers snapshot before the first hop.

## Work Guidance

- Treat bridge, swap, escrow, token transfer, and transaction-submitting paths
  as funds-sensitive code.
- Keep network and deployment claims traceable to implementation or tests.

## Verification

- Run `npm run build` and `npm test`.
- Run `npm run lint` when source files change.

## Child DOX Index

- No child contracts are currently defined. `src/net/` (bounded HTTP helper)
  is governed by this file.
