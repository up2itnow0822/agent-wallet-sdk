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
