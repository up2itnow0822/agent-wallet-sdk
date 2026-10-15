# Security remediation and migration

This branch repairs the October 2026 assessment of source commit
`8f6ef0236625df64f7a9ac327eee7ac17db8f3b5`. These changes do not update an
installed npm package or establish the safety of external contracts.

## High-risk findings

| Assessment ID | Repair |
| --- | --- |
| 1 | The existing required `build` job now runs build, tests, lint and dependency audit. Requiring `verify` and `review-gate` remains a live GitHub ruleset action; see below. |
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

A repeated identical unkeyed request reuses its protected settlement during
its retry window. A confirmed payment whose HTTP delivery fails remains
protected until successful delivery. A distinct intended purchase needs its
own explicit payment intent. Unknown submissions never expire into permission
to pay again; protected cache limits reject new intents instead of evicting
unresolved payments.
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

## Live GitHub ruleset action

The inspected active ruleset `23222371` requires only `build`. Workflow files
cannot change that administrative setting, and the connected GitHub tools do
not expose a ruleset update operation.

Preserve its PR-only, no-bypass, no-deletion, no-force-push and resolved-thread
rules. Require these contexts from GitHub Actions (integration ID `15368`):

- `build`
- `verify`
- `review-gate`

Require branches to be up to date before merging. Confirm that a PR with
missing verification or review evidence remains blocked. Do not waive the
review gate simply to publish these repairs. This setting remains outstanding
until an administrator applies and verifies it.

## Verification and limits

Regressions reproduce the assessed failures with harmless fixtures and mocked
signing/network boundaries. Verification on October 13, 2026 passed 690 tests
across 27 files, the TypeScript build and lint (zero errors, 148 warnings).
The dependency audit reported zero advisories at every severity. The baseline
had 334 passing tests. Run:

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
