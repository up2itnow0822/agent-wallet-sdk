# Changelog

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
