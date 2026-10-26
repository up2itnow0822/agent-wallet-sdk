# Security remediation and migration

## October 25, 2026 assessment (8.0.0)

The 8.0.0 branch repairs all 29 findings (11 high, 18 medium) of the
whole-repository scan of frozen revision
`8a8b3a4a62b384d618b58a894fdec0640480ad50` (published as 7.0.0). Each finding
has a regression test that reproduces the reported input against mocked
signing and network boundaries.

| # | Finding | Repair |
| --- | --- | --- |
| 1 | Solana SPL scale chosen by RPC | Pinned mint decimals (or caller `expectedDecimals`), RPC value compared only, `TransferChecked`, genesis-hash cluster binding (`cluster`/`expectedGenesisHash`). |
| 2 | Accessor-backed `PaymentIntent` TOCTOU | `snapshotPaymentIntent()` reads each field once into a frozen, validated object used for every check, record and result. |
| 3 | Unverified smart-wallet address | `verifyAgentWallet()` before every write: chain agreement, nonempty non-7702 code, AgentAccountV2 views, optional `expectedCodeHash` and factory `deployment` identity. Execution requires a matching `TransactionExecuted`/`TransactionQueued` event. |
| 4 | EVM decimals from RPC | Registry or `expectedDecimals` pins the scale; RPC decimals must match; signer/public/requested chains must agree. |
| 5 | Lost EVM→Solana burn on post-hash failure | Every post-hash error carries frozen `recovery`; `resumeEVMToSolana()` never burns again. |
| 6 | Broker assertion treated as verified identity | Strict broker schema bound to the canonical UAID; `brokerAttested` reported separately; `verify()` reads trusted ERC-8004 registry owner and wallet at one block. |
| 7 | Substring Stellar chain match | Exact chain-id token required. |
| 8 | Unbound locked-reservation release | `release({ reconciled })` removed; `lock()` records submission identity; `reconcileLocked()` checks the recorded hashes on the recorded chain. |
| 9 | Unverified Solana mint recipient | Canonical base58 + on-chain check that the recipient is an initialized mainnet USDC token account (optionally owned by `solanaRecipientOwner`) before approve/burn. |
| 10 | Stellar auto-pay without policy | `stellarX402Pay` requires `StellarSpendPolicy` (cap, allowlist, approval, `StellarSpendBudget`) enforced before signing. |
| 11 | Swap minimum from RPC quote | `minAmountOut` (independent floor) required; optional `referenceAmountOut` deviation bound; chain-bound clients. |
| 12 | Unbounded attestation polling | `bounded-fetch` deadline over body, 256 KiB cap, strict message/field limits, overall deadline. |
| 13 | `agentTransferToken` hash as payment | Returns `{ status: 'executed' \| 'queued' }` after receipt + matching ERC-20 `Transfer`; `submitAgentTransferToken` is the submit-only primitive. |
| 14 | Unrelated single attested message | Attestations must match a known source message; `waitForAttestation` decodes the burn receipt (transmitter-emitted log only). |
| 15 | Unknown chain falls back to Base | Explicit unknown/malformed chains throw; conflicting `CHAIN_NAME`/`CHAIN_ID` throw. |
| 16 | Mutable action tags with `checks:write` | All actions pinned to commit SHAs; Dependabot proposes pin updates. |
| 17 | Ignored Horizon override | Configured Horizon used everywhere and must report the configured network passphrase; https only. |
| 18 | Unbounded UAID bodies | Broker requests use one deadline over the body and a size cap; error bodies truncated. |
| 19 | review-gate not bound to base SHA | Resolved by removal: the `review-gate` workflow is deleted at the maintainer's direction. Codex reviews every PR automatically, and no merge gate consumes Codex evidence. |
| 20 | Examples spend real funds | Examples default to Base Sepolia, need `AGENT_EXAMPLE_LIVE_ACK` for mainnet, verify the installed policy, and never auto-run on import. |
| 21 | Unbounded Horizon I/O | Deadlines and size caps; ambiguous submission ⇒ `StellarSubmissionUnknownError` with the expected hash. |
| 22 | Unchecked Solana→EVM recipient | Source domain, message hash, destination, burn token, remote sender and mint recipient validated; returned values derived from attested bytes. |
| 23 | Query ignored in resource binding | Origin, path and query must match. |
| 24 | Ambiguous mint reported as failure | `MINT_SUBMISSION_UNKNOWN`, `MINT_UNCONFIRMED`, `MINT_ALREADY_RECEIVED` (`usedNonces` checked first) with retained recovery state. |
| 25 | Unbounded 402 JSON body | 64 KiB / 10 s bounded read; ≤16 options and bounded fields; nesting deeper than `X402_MAX_CHALLENGE_DEPTH` (32) is refused before payment, on every JS engine. |
| 26 | Unverified Stellar 2xx | Expected hash from the signed XDR, strict `successful === true`, ledger confirmation read. |
| 27 | Explicit intent replay across requests | Explicit intents bind the full request fingerprint; mismatch ⇒ `X402IntentTermsConflictError`. |
| 28 | Late `wrapWithX402` snapshot | Snapshot taken before the first hop and reused for settlement and retry. |
| 29 | Unbounded UAID cache | Bounded LRU (`cacheMaxEntries`), expired entries deleted, malformed keys never cached. |

### 8.0.0 caller migrations

- `agentTransferToken()` now resolves to `{ status, txHash, pendingTxId? }` and
  throws `AgentExecutionError` for reverted/unknown receipts. Use
  `submitAgentTransferToken()` only when you confirm receipts yourself.
- Agent writes call `verifyAgentWallet()` and REQUIRE a deployment identity:
  pass `deployment` (`factoryAddress`, `tokenContract`, `tokenId`) or
  `expectedCodeHash` to `createWallet()` (env/Eliza settings:
  `AGENT_WALLET_FACTORY` + `AGENT_WALLET_TOKEN_CONTRACT` + `AGENT_WALLET_TOKEN_ID`,
  or `AGENT_WALLET_CODE_HASH`). `allowUnverifiedDeployment: true`
  (`AGENT_WALLET_ALLOW_UNVERIFIED=true`) is an explicit unsafe opt-out.
  `createWallet()` returns a frozen handle. `agentExecute()` throws `unknown`
  when the receipt has neither a matching executed nor queued event.
- `batchAgentTransfer()` returns `AgentTransferResult[]` (confirmed and
  classified); on failure `error.completed` lists the transfers already done.
- `SpendingPolicy.release()` no longer accepts `{ reconciled }`. Record every
  submitted phase and the call binding once, at lock time —
  `lock(reservation, { chainId, txHashes, from, to, data, value })` or
  `applyOutcome(reservation, outcome, { from, to, data, value })` — then call
  `reconcileLocked(reservation, publicClient)`. Phases with different
  calldata (e.g. protocol fee and payee) each go in `calls: [{ hash, from, to,
  data, value }]`. Identity cannot be attached later; a hash without a binding
  keeps the lock until committed. If a phase may have broadcast without a
  usable hash, pass `incomplete: true` (malformed or empty entries and
  `SpendOutcome.incompleteEvidence` set it automatically): such a lock commits
  on success evidence but is never released.
- `sendToken()`/`sendNative()` require a chain-bound wallet client; string
  amounts for tokens outside the registry need `expectedDecimals`;
  over-precision amounts throw instead of truncating.
- `SolanaWallet` verifies the RPC cluster (default `mainnet-beta`). Set
  `cluster: 'devnet'` (or `expectedGenesisHash`) for other clusters.
  `sendSplToken()` needs `expectedDecimals` for unlisted mints.
- An unknown `stellarX402Pay()` reservation is freed or committed only by
  `budget.reconcile(id, adapter)`, from ledger evidence for the recorded hash
  and network. No Horizon rejection or result code frees a reservation by
  itself: a non-2xx submit is decided from the ledger, so a genuine rejection
  stays held (as unknown) until the envelope's `maxTime` passes and
  `reconcile()` proves it was never applied. The Stellar API
  (`StellarSpendBudget`, `stellarX402Pay`, …) is exported from the package
  root; install the optional peer `@stellar/stellar-sdk` (>= 14) to use it.
- `SwapModule.swap()` requires `minAmountOut` from an independent source, and
  its read client must answer `getChainId()` with the configured chain.
- The runnable examples need the wallet's deployment identity env
  (`AGENT_WALLET_CODE_HASH`, or `AGENT_WALLET_FACTORY` +
  `AGENT_WALLET_TOKEN_CONTRACT` + `AGENT_WALLET_TOKEN_ID`).
- `UAIDResolver.verify()` returns `verified: true` only after on-chain ERC-8004
  verification; configure `rpcUrls`/`onChainLookup`. Broker claims are in
  `brokerAttested`.
- `stellarX402Pay()` requires `policy` with a `StellarSpendBudget`. The signed
  envelope must hash to the policy-checked transaction; both Horizons are
  verified before broadcast; submissions are confirmed in a ledger.
- `UAIDResolver.buildERC8004UAID()` / `erc8004ToUniversal()` now put the
  identity registry (not the owner) in the `aid`, matching `verify()`. A
  verified identity carries only on-chain values (owner, wallet, `agentURI`);
  `registrationFile` is null — resolve it through `ERC8004Client`.
- x402 explicit intents bind the request's headers too. A retry of the same
  intent with different headers (e.g. a fresh `traceparent` or rotated
  `Authorization`) is a terms conflict, never a second payment; resend the
  original headers, or use `reconcileSubmission` for a lost response.
- `walletFromEnv()` / `resolveWalletChain()` throw on unknown chains.
- x402 challenges must name the full resource URL including the query.
- `BridgeModule.waitForAttestation(burnTxHash)` reads the burn receipt from the
  module's source-chain RPC. `bridgeEVMToSolana` verifies the Solana recipient
  token account first; on failure after the burn, call
  `resumeEVMToSolana(error.recovery)`. A Solana→EVM `MINT_UNCONFIRMED` /
  `MINT_SUBMISSION_UNKNOWN` error is resumed with
  `resumeSolanaToEVM(walletClient, error.mintRecovery)`, which never mints
  while the retained transaction is unresolved; a recovery without a
  `mintTxHash` mints again only with `{ originalSubmissionReconciled: true }`.
- Custom wallet/ERC-8004 read clients must implement `getChainId()`; the RPC
  endpoint must serve the configured chain.

### Version note

npm `7.0.0` contains the vulnerable code. After 8.0.0 is published, deprecate
7.0.0 (`npm deprecate agentwallet-sdk@7.0.0 "Security issues fixed in 8.0.0"`)
— a maintainer action outside this repository.

## October 13, 2026 assessment

This branch repairs the October 2026 assessment of source commit
`8f6ef0236625df64f7a9ac327eee7ac17db8f3b5`. These changes do not update an
installed npm package or establish the safety of external contracts.

## High-risk findings

| Assessment ID | Repair |
| --- | --- |
| 1 | The required `build` job runs build, tests, lint and dependency audit; the live ruleset now also requires `verify` (see below). |
| 2 | The security scanner reads NUL-delimited filenames through filesystem APIs, never interpolates them into shell source, and uses read-only PR permissions. |
| 4 | Environment x402 budgets accept only the configured wallet chain's exact USDC address. |
| 5 | Generic or malformed spend outcomes retain the hold. Confirmed payments remain charged after HTTP delivery errors. |
| 6 | Eliza provider refresh retains the original x402 client, daily spend and unknown holds. |
| 7 | Eliza wallets and clients are isolated by runtime/config object; changed settings fail closed. |
| 8 | A human-approved draft binds atomically to one reservation. Replays do not authorize another execution. |
| 9 | `existing` reservations cannot be executed through `check()`; locks persist until explicit reconciliation. Returned authorization records resist mutation. |
| 10 | Solana transfers reject negative and nonpositive inputs before instructions or signatures. |
| 11 | x402 uses UTF-8 wire encoding and validates/serializes payment fields before submitting a fee or payee transfer. |
| 12 | CCTP V2 polls by burn transaction, submits the returned attested message, and exposes recovery without another burn. |
| 13 | `SPEND_ALLOWLIST` validates and enforces merchant recipients before x402 payment. It is a client restriction, not an on-chain recipient policy. |
| 14 | Registry-controlled metadata no longer makes a default external fetch; HTTPS resolution requires a trusted caller resolver with resource limits. |
| 16 | Ambiguous RPC submission retains the intent and capacity even without a returned hash. Reconciliation verifies transaction terms and confirmation. |

## Required caller changes

### Reserve before executing

Only `result.status === "reserved"` grants a new execution claim. `existing`
returns the original reservation for observation or reconciliation. Do not
submit another transfer for held, locked or committed attempts. A draft can
be retried only after the original attempt was definitely released.

Do not mutate returned reservations or draft objects to change authorization.
Use the policy methods. `check()` cannot confirm an earlier unknown execution.
No timer, no-hash error, or later budget rejection clears that unknown hold.
The success status of a queued transaction's outer receipt does not settle it.
Supply a separate verified execution receipt after the queued transfer actually
executes; do not reuse its queued error as execution evidence.

### x402 retries and lost submission responses

A repeated identical unkeyed request reuses its protected settlement while
the transfer is in flight or proof delivery has not succeeded. After the
proof is delivered, a later identical request is a new purchase. A confirmed
payment whose HTTP delivery fails remains protected until successful
delivery. A distinct intended purchase with an explicit payment intent still
replays during its retry window. Unknown submissions never expire into
permission to pay again; protected cache limits reject new intents instead
of evicting unresolved payments.
Reissued challenges can extend that window; a later shorter challenge never
reduces the protection of an existing payment.

`X402PaidRequestError` carries confirmation and payment hashes when a paid
HTTP request throws. Classify this error instead of treating the HTTP failure
as proof that payment was not made. Confirmed protocol fees remain charged
when the payee fails; conservative local policy may hold the full reservation
until the host reconciles the partial charge.

`X402SettlementUnknownError.txHash` is optional. Use its `intentKey` and
`phase` when recovering a lost-response transaction with
`client.reconcileSubmission({ intentKey, phase, txHash })`. The operator must
first correlate that hash to the original signer attempt. The SDK additionally
checks the wallet, sender when known, network, exact calldata, value and receipt;
a successful unrelated transaction cannot clear the hold. Do not fabricate a
hash or create another payment to obtain one.
The returned functions from `createX402Fetch`, `wrapWithX402`, and
`createAgentFetch`, and `runtime.x402Fetch`, expose the same
`reconcileSubmission` method on their original retained client. Eliza recovery
uses the same configuration guards as payment.

Automatic payment requires HTTPS. `allowInsecureHttpForDevelopment: true`
permits only local loopback HTTP for development. Payment proof delivery fails
closed on redirects. Keep this exception out of remote deployment settings.

### Environment and Eliza settings

USDC settings cannot fund WBTC, WETH, symbols or other tokens using the same
integer budget. Unknown USDC deployments fail closed. Configure testnet
networks explicitly. `SPEND_ALLOWLIST` is a comma-separated list of merchant
recipient addresses. The fixed SDK protocol fee is a separate permitted debit
only after the merchant passes the allowlist and is included in the budget.
Environment x402 and spend-limit caps (`X402_GLOBAL_DAILY_LIMIT`,
`X402_PER_REQUEST_MAX`, `SPEND_LIMIT_PER_TX`, `SPEND_LIMIT_DAILY`) must be
non-negative decimal USDC strings with at most six fractional digits.
Eliza `X402_DAILY_LIMIT` is a non-negative integer in USDC base units parsed
with `BigInt` (for example `50000000` is 50 USDC). A decimal such as `1.50`
throws; `50` is 50 base units, not 50 USDC. Invalid nonempty values throw
before client creation or policy writes; they cannot silently remove a limit.
Blank optional settings retain their documented defaults (omitted or empty
Eliza `X402_DAILY_LIMIT` keeps 50 USDC = `50000000`), and explicit zero
remains zero.

Reuse one config object for public Eliza helpers or one runtime object for the
provider. The retained client preserves spend and unknown holds on refresh.
Changing its key, wallet, chain, RPC or daily limit rejects the change and old
fetch references. Restoring the original settings resumes the retained state.
Do not replace the runtime merely to bypass an unresolved hold.

All these controls are in-memory. Production hosts must persist payment intent
state and reconcile it before replacing a client or restarting a service.
They do not constrain direct signer use or independent processes.

### Metadata and identity ownership

`resolveAgentURI(uri, options)` and
`ERC8004ClientConfig.uriResolution` accept an explicit `AgentURIResolver`.
Inline data is bounded locally. The resolver returns JSON text; accepted text
and wait time are bounded by the SDK. The default limits are 256 KiB and five
seconds.

The resolver is trusted code: it owns destination allowlisting, DNS/private
address rejection, connection pinning, redirects, streaming bounds, and actual
cancellation. An ignored abort does not terminate caller work. The SDK does
not run an unrestricted default transport. Owner lookup considers registration
and incoming transfer events, verifies current ownership and reads one block
snapshot; its `fromBlock` still controls discovery coverage.

### Bridges and other funds modules

`waitForAttestation` now takes a burn transaction hash and returns the attested
message together with its attestation. Submit that returned message, not the
provisional bytes from the source receipt. Recovery must reuse the known burn.
Inspect `BridgeError.recovery` and use the resume API rather than invoking a
new burn. Fast finality is `1000`; finalized standard transfers use `2000`.
For EVM-to-Solana transfers, `solanaRecipient` must be an existing initialized
USDC SPL token account, not its wallet owner. `solanaRpcUrl` selects the endpoint
used to verify that account before any burn.

`agentExecute()` rejects reverted or unconfirmed receipts with an
`AgentExecutionError` carrying the submitted hash. Queued calls return their
pending transaction ID. An unknown error is not permission to resubmit.

Fee-bearing swaps are disabled until a reviewed atomic fee/swap route exists.
Fee-free swaps require `feeBps: 0` and a direct signer/account match; a token-bound
account needs its own reviewed execution route. Swap calldata enforces the
deadline and approval confirmation precedes execution. Escrow creation uses
the confirmed factory event instead of a second simulated deployment.

The settlement test server is a read-only Base Sepolia demo. It does not
forward fees or accept an untrusted receipt as settlement authorization.
A production endpoint needs durable, atomic challenge and transfer consumption.

## Live GitHub ruleset

Verified through the API on 2026-10-26: active ruleset `23222371` on `main`
requires a pull request with every review thread resolved, blocks deletion and
force-pushes, and requires the `build` and `verify` checks from GitHub Actions
(integration ID `15368`) with branches up to date. Workflow files cannot change
these settings; re-check them after any ruleset edit.

## Verification and limits

Regressions reproduce the assessed failures with harmless fixtures and mocked
signing/network boundaries. Three independent fresh-context reviews were run
over the repairs; every follow-up they raised was fixed or dispositioned in
the commit history. Verification of the 8.0.0 repairs passed 833 tests
across 34 files (baseline at the assessed revision: 676 tests across 28 files),
the TypeScript build and lint with zero errors. Run:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run lint
npm audit --audit-level=high
```

The repository still does not include audited Solidity sources, a deployment
manifest, persistent host payment storage or a production settlement service.
The SDK repairs do not constitute an audit of any deployed wallet, escrow,
router or facilitator. No real funds or production credentials were used.
