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
  bind signer/read/requested chains; Solana signs only over a blockhash
  fetched BEFORE a fresh genesis-hash cluster check (never cached), signs
  locally and submits raw bytes, and uses `TransferChecked`. A confirmation
  without an explicit `{ err: null }` result is `unknown`, never success.
  Amounts never truncate.
- Every AgentAccountV2 write first passes `verifyAgentWallet`, which requires
  a deployment identity (`deployment` or `expectedCodeHash`) unless the caller
  explicitly sets `allowUnverifiedDeployment`, and requires the read RPC's
  `getChainId()` to equal the wallet chain before and after the deployment
  reads (nothing is cached otherwise). Every verification failure
  (RPC errors included) is an `AgentWalletVerificationError`
  (`src/wallet-verification-error.ts`): a definite pre-broadcast failure, so
  x402 releases its reservation. Execution is classified only from wallet
  events matching the requested call (`TransactionExecuted` with matching
  target/value/calldata, or `TransactionQueued` matching recipient/value and
  token — `NATIVE_TOKEN` for `agentExecute`, the token and amount for token
  transfers) or a matching ERC-20 `Transfer`;
  anything else is `unknown`. x402 classifies every settlement receipt
  against its phase's prepared transfer (`classifyX402SettlementReceipt`): a
  successful outer receipt alone is never payment proof.
- `SpendingPolicy` snapshots intents once (`snapshotPaymentIntent`). A locked
  reservation is released only by `reconcileLocked` against the submission
  identity and call binding recorded once at lock time; the receipt and the
  transaction body must both name the requested hash, and the RPC must serve
  the recorded chain before and after those reads. Multi-phase
  submissions bind each hash to its own call (`calls`). Evidence that dropped
  a phase (a malformed or empty hash or call, or
  `SpendOutcome.incompleteEvidence`) marks the lock `incomplete`: it can
  commit on success but never release. There is no caller override and no
  later hash attachment.
- CCTP: attestations are always bound to a known source message; burn terms
  (domains, token, recipient, amount, maxFee, minFinalityThreshold) are
  checked from the transmitter-emitted `MessageSent`; the Solana recipient
  check brackets its account read with mainnet genesis checks; post-hash failures
  carry frozen recovery; `usedNonces` is checked before `receiveMessage`;
  reported recipients/amounts come from attested bytes. Resume paths
  (`resumeEVMToSolana`, `resumeSolanaToEVM`) re-validate the recovery and
  resolve any retained transaction (receipt and body bound to the retained
  hash and to this message's `receiveMessage` call) before another burn or
  mint; a hashless ambiguous mint stays held until the caller passes
  `originalSubmissionReconciled`.
- The package has one entry point (`dist/index.js`): every value and type
  exported by a submodule index that the root re-exports is also exported from
  `src/index.ts` (`test/root-exports.test.ts` checks this with the compiler).
- UAID registration and UAID builders default to the chain's own
  `KNOWN_REGISTRY_ADDRESSES` identity registry (the one `verify()` trusts).
- UAID `verify()` returns `verified` only after on-chain ERC-8004 checks
  (`readAgentBinding` proves the RPC serves the UAID chain before and after
  its reads);
  broker claims are `brokerAttested`. The resolution cache is a bounded LRU.
- Stellar auto-pay requires a spend policy reserved before signing; Horizon
  must report the configured network, re-checked (never cached) before every
  build, submission and lookup, and after every reconciliation read; success
  needs the signed-XDR hash, `successful === true` and a ledger confirmation.
  No submit response or result code releases a reservation: every non-2xx is
  decided from the ledger (applied → paid, included-but-failed → rejected and
  released, absent → unknown). Reconciliation requires the recorded network.
  An unknown reservation is freed only by `StellarSpendBudget.reconcile()`
  evidence for its recorded hash: included-but-failed, or not found after its
  `maxTime` on a Horizon whose history covers the validity window.
  `@stellar/stellar-sdk` is an optional peer (>= 14, smoke-tested on 14, 16
  and 17 against a fake Horizon).
- Swaps require a caller `minAmountOut`, a chain-bound wallet client and a
  read client whose RPC `getChainId()` equals the configured chain, checked
  before the reads and again after them, before every approve or swap write.
  Explicit unknown chains throw.
- Shipped code is runtime-neutral: no Node-only globals such as `Buffer`
  (browsers and workers load the Stellar and x402 APIs).
- Broker UAIDs match the requested UAID component-wise (protocol, uid,
  nativeId exact; EVM registry address case-insensitive).
- x402 binds origin+path+query, bounds the 402 body and its nesting
  (`X402_MAX_CHALLENGE_DEPTH`, checked iteratively; never rely on an engine
  stack overflow to refuse a challenge), binds explicit intents to
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
