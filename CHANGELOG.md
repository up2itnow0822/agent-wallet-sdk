## [8.0.0] — Unreleased

Security release for the October 25, 2026 assessment of 7.0.0 (29 findings,
all repaired with regression tests). See `docs/security-remediation.md`.

### Breaking
- `agentTransferToken()` confirms and returns `{ status: 'executed' | 'queued', txHash, pendingTxId? }`; new `submitAgentTransferToken()` returns the bare submission hash.
- Agent/owner writes require a verified AgentAccountV2 deployment (`verifyAgentWallet`); `agentExecute()` needs a matching wallet event to report executed.
- `SpendingPolicy.release()` no longer accepts `{ reconciled }`; use `lock(reservation, submission)` + `reconcileLocked()`.
- `sendToken()` requires `expectedDecimals` for string amounts of unlisted tokens; amounts never truncate.
- `SolanaWallet` binds to a cluster by genesis hash (default `mainnet-beta`); `sendSplToken()` uses `TransferChecked` and pinned decimals.
- `SwapModule.swap()` requires `minAmountOut`.
- `UAIDResolver.verify()` verifies ERC-8004 identities on-chain; broker claims move to `brokerAttested`.
- `stellarX402Pay()` requires a `policy`.
- Unknown `CHAIN_NAME`/`CHAIN_ID` values throw instead of using Base mainnet.
- x402 challenges must bind the exact resource including its query.

### Fixed
- Bridge: bounded Circle polling, receipt-bound attestations, burn-term checks, Solana recipient verification, frozen recovery and `resumeEVMToSolana()`, mint ambiguity codes and `usedNonces` reconciliation, recipient/amount derived from attested bytes.
- x402: bounded 402 body parsing, explicit intents bound to the request fingerprint, `wrapWithX402` snapshots before the first hop.
- Stellar: exact chain matching, configured Horizon with network check, bounded I/O, verified settlement, spend budget.
- UAID: strict broker schema, bounded broker I/O, bounded LRU cache.
- Examples default to Base Sepolia and never auto-run.
- CI: actions pinned to commit SHAs; review-gate evidence bound to the base SHA.

---

## [7.0.0] — 2026-10-23

Security release. Lifts the security-maintenance pause.

### Breaking
- `BridgeModule.waitForAttestation` now takes the **burn transaction hash** (Circle CCTP V2 looks up by transaction) and returns a `CctpAttestedMessage` (`{ message, attestation, ... }`) instead of taking a message hash and returning the attestation `Hex`. Update recovery code before upgrading from 6.x.
- A `depositForBurn` write that fails for any reason other than a wallet/user rejection now throws `BURN_SUBMISSION_UNKNOWN` (not `BURN_FAILED`). Treat it as not retry-safe.

### Fixed
- **Bridge (#44, #93):** CCTP V2 attestation lookup by burn transaction. Attested messages are matched to the caller's burn, multi-message transactions are handled, and recovery data (`BridgeError.recovery`, `mintTxHash`, `eventNonce`) is kept once a burn tx hash is known, so the transfer can be resumed instead of re-sent. If the RPC call fails before a tx hash comes back, the burn may still have been broadcast: the SDK throws `BURN_SUBMISSION_UNKNOWN`, and callers must check the sender's nonce and recent transactions before retrying. New error codes `BURN_UNCONFIRMED` and `MINT_UNCONFIRMED`.
- **x402 (#94, supersedes #26, #27, #30, #31, #32, #55):** fails closed on queued transfers, waits for the settlement receipt before retrying, counts the protocol fee in budget checks, refuses payment after a cross-origin redirect, binds payment to the exact resource, rejects zero amounts, and transfers the resolved token address.
- **Escrow (#94, supersedes #49):** `MutualStakeEscrow` returns the vault from the factory `VaultCreated` event.
- Hardened SpendingPolicy, SwapModule, ERC-8004 identity, outcomes and the ElizaOS plugin. CI hardened; `npm audit` reports 0 issues.

### Security
- Removed `smithery.yaml`. Its start command ran `npx -y @agentwallet/sdk mcp` and passed the user's agent key as `AGENT_PRIVATE_KEY`. `@agentwallet/sdk` is a third-party npm package, not this project's `agentwallet-sdk`. MCP belongs in [agentpay-mcp](https://github.com/up2itnow0822/agentpay-mcp). Rotate any wallet key ever entered through that Smithery listing.
- Abstract x402 mainnet approved-facilitator list is now empty and fail-closed. The previous entry was the public Anvil/Hardhat first-deployment address, not a verified mainnet contract. Testnet still accepts that local-dev address. Do not treat it as an official Abstract mainnet facilitator.

---

## [6.3.0] — 2026-10-11

### Added
- **Spend outcomes API** (`classifySpendAttempt`, `classifySpendError`, `isEvmTxHash`) for the payment flow `reserve → execute → settle | release | hold-unknown`. Settled requires a successful receipt and valid EVM tx hash(es) (`0x` + 64 hex). Definite pre-broadcast failures and confirmed reverts are `released` + `retrySafe`. Post-broadcast timeouts, queued settlements, and unclear receipts are `hold-unknown` and never auto-retry.
- **`SpendingPolicy.reserve` / `commit` / `release` / `lock` / `applyOutcome`**. Reserve holds rolling-cap capacity all-or-nothing (optional 0.77% protocol fee in exact base units). Commit keeps capacity consumed after a settled outcome. Release restores capacity after a definite not-charged outcome. `hold-unknown` locks the reservation; a timer never unlocks it.
- `reserveApprovedDraft()` so over-cap or threshold drafts can approve and execute the stored intent (no dead-end drafts).
- Shared `x402ProtocolFeeAmount` / `x402DebitAmount` helpers exported from the package entry.

### Security
- Bump `viem` 2.46.0 → 2.57.4 (exact), which drops the vulnerable `ws` 8.x range (GHSA-58qx-3vcg-4xpx, GHSA-96hv-2xvq-fx4p). `npm audit --omit=dev` reports 0 vulnerabilities.

### Fixed
- Solana balance formatting preserves precision (#29), now shipped in a release.
- Explicit `PublicClient` / contract types in `createWallet` so declarations build against viem 2.57.

### Changed
- `SpendingPolicy.check()` is now a backward-compatible reserve-then-commit wrapper. New callers should reserve, execute, then `applyOutcome()`.

---

## [6.2.0] — 2026-04-13

### Added
- `UptoBillingPolicy` for x402 usage-based billing, with max authorization tracking, actual settlement recording, unused-capacity release, and wallet ledger deltas
- Test coverage for partial settlement, finalization, over-cap rejection, and multi-settlement flows

### Changed
- Exported `UptoBillingPolicy` from the main SDK entrypoint
- Updated README examples and package metadata to position `agentwallet-sdk` as an x402 usage-based billing reference implementation
- Simplified `PaymentRouter.isRailLive()` boolean handling

---

## [6.0.0] — 2026-03-21

### Added
- **`TokenRegistry` class** — 80+ verified token addresses across 11 EVM chains + Solana
  - Pre-populated registries: USDC, USDT, DAI, WETH, WBTC, LINK, UNI, AAVE, CRV, MKR, SNX, COMP, LDO, ARB, OP, and more
  - Native gas token support (ETH, POL, AVAX, S) with `isNative` flag
  - `addToken()` for custom token imports
  - Per-chain registry exports: `BASE_REGISTRY`, `ETHEREUM_REGISTRY`, `ARBITRUM_REGISTRY`, etc.
- **Multi-token EVM transfers**: `sendToken()`, `sendNative()`, `getTokenBalance()`, `getNativeBalance()`, `getBalances()`
- **Human-readable amount handling**: `toRaw()`, `toHuman()`, `formatBalance()`
- **Solana SPL token support** (optional peer dependency `@solana/web3.js`):
  - `SolanaWallet` class with `getSolBalance()`, `sendSol()`, `sendSplToken()`, `getSplTokenBalance()`
- **x402 multi-asset resolution** — payments now accept any token the server requests, not just USDC

### Changed
- x402 client updated to resolve assets via `TokenRegistry` (multi-asset support)
- Bumped version to 6.0.0

### Backward Compatible
- All v5.x imports continue to work unchanged

---

## [5.2.0] — 2026-03-16

### Added
- **Multi-chain x402 payments:** Expanded from 1 chain (Base) to 10 mainnet chains — Ethereum, Arbitrum, Polygon, Optimism, Avalanche, Unichain, Linea, Sonic, World Chain
- **Solana CCTP bridge:** EVM↔Solana USDC bridging via Circle CCTP V2 (domain 5). Self-contained base58 encoder, no hard @solana/web3.js dependency
- **Multi-chain swap:** Uniswap V3 support expanded to Arbitrum, Optimism, and Polygon (was Base-only)
- **Chain config expansion:** `SupportedChain` type and `CHAIN_IDS` map for all 11 chains
- **Mainnet bridge proof:** Verified Base→Arbitrum CCTP V2 transfer (0.50 USDC, tx `0xfedb...9129`)

### Fixed
- **Critical: Solana CCTP V2 addresses** — TokenMessenger and MessageTransmitter were using V1 program IDs. Updated to V2 (`CCTPV2vPZJS2u2BB...` and `CCTPV2Sm4AdWt52...`). Verified against Circle docs + `circlefin/solana-cctp-contracts`
- **CCTP V2 depositForBurn signature** — Updated from 4-param V1 to 7-param V2 (added `destinationCaller`, `maxFee`, `minFinalityThreshold`)

### Documentation
- JSDoc module comments added to all 10 modified source files
- README: Complete chain support matrix, Solana bridge examples, multi-chain x402 examples
- All "coming soon" language removed from README

# Changelog

## 5.0.4 (2026-03-15)

### Critical Bug Fix
- **Fixed Solana CCTP program addresses** — corrected CCTP V1 addresses to V2:
  - `SOLANA_TOKEN_MESSENGER`: `CCTPiPYP...` → `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` (TokenMessengerMinterV2)
  - `SOLANA_MESSAGE_TRANSMITTER`: `CCTPmbSD...` → `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC` (MessageTransmitterV2)
  - The old addresses were CCTP V1 Solana programs; this SDK targets CCTP V2. Any transactions sent to V1 programs would fail silently or route incorrectly.
  - Verified against: https://developers.circle.com/cctp/references/solana-programs and https://github.com/circlefin/solana-cctp-contracts

### Documentation
- Added module-level JSDoc comments to all source files (`src/types.ts`, `src/x402/types.ts`, `src/x402/client.ts`, `src/bridge/types.ts`, `src/bridge/client.ts`, `src/bridge/solana.ts`, `src/swap/types.ts`, `src/swap/SwapModule.ts`, `src/bridge/index.ts`, `src/swap/index.ts`)
- README: Added complete code examples for multi-chain x402, multi-chain swaps, EVM↔EVM bridge, EVM→Solana bridge, Solana→EVM receive
- README: Documented `chain` parameter in wallet config with all supported values
- README: Full chain support matrix showing x402, bridge, and swap support per chain

## 5.0.0 (2026-03-10)

### Breaking Changes
- `KNOWN_REGISTRY_ADDRESSES` type changed from `Partial<Record<chain, Address>>` to `Record<string, { identity: Address; reputation: Address; validation?: Address }>`. All references must use `.identity`, `.reputation`, or `.validation` property.
- `ERC8004ClientConfig.registryAddress` is now optional — auto-resolves from `KNOWN_REGISTRY_ADDRESSES` when not provided.
- ABI function names `registerWithMetadata` and `registerEmpty` removed. All three register overloads are now named `register` matching the on-chain contract (Solidity function overloading).
- Added `SupportedChain` type including `'arbitrum-sepolia'`.

### New Features
- **Validation Registry Client** (`ValidationClient`) — on-chain validation for AI agents
  - `requestValidation()` — submit a validation request to a validator contract
  - `respondToValidation()` — validator responds with pass/fail and attestation data
  - `getValidationStatus()` — check status of a validation request by hash
  - `getAgentValidations()` — list all validation requests for an agent
  - `getValidatorRequests()` — list all requests assigned to a validator
  - `getSummary()` — aggregated pass/fail counts with optional filters
- **Reputation Registry Client** (`ReputationClient`) — full on-chain reputation system for AI agents
  - `giveFeedback()` — submit scored feedback for an agent
  - `readFeedback()` — read specific feedback entry
  - `getAgentReputation()` — aggregated summary + client list
  - `getAllFeedback()` — bulk read with filters
  - `respondToFeedback()` — append response to feedback
  - `revokeFeedback()` — revoke own feedback
- Official registry addresses for ethereum, base, arbitrum, polygon (mainnet + sepolia testnets)
- `TIERS.md` documenting Base (free) vs Premium feature tiers

### Fixes
- **Fixed `agentExecute` return value** — now correctly detects whether a transaction was executed immediately or queued for approval by checking `TransactionExecuted` vs `TransactionQueued` event topics in the receipt
- Fixed `REGISTERED_TOPIC` — corrected keccak256 hash of `Registered(uint256,string,address)` to `0xca52e62c...`
- Fixed zero address in `KNOWN_REGISTRY_ADDRESSES` — replaced with official deployed addresses

## 4.0.5

- Previous release
