# KYA (Know Your Agent) Protocol Specification

**Version:** 0.1.0-draft
**Date:** March 17, 2026
**Status:** Draft — Reference Architecture

## Abstract

Know Your Agent (KYA) defines a protocol for verifying the identity, authorization, and behavioral reputation of AI agents participating in economic transactions. KYA combines human identity attestation, on-chain agent identity, and programmable spending constraints into a unified verification framework.

This spec uses World ID + x402 + agent-wallet-sdk as the reference implementation, but the protocol is designed to be identity-provider-agnostic and chain-neutral.

## 1. Problem Statement

AI agents are increasingly acting as economic participants — making purchases, paying for API access, and transacting with other agents. The existing identity and authorization stack was built for humans and breaks in three ways for agents:

1. **Human verification fails.** CAPTCHAs, device fingerprinting, behavioral biometrics — all designed to detect humans — fail or produce false negatives when the "user" is a legitimate AI agent.

2. **Authorization is binary.** Current systems authorize or deny. Agents need graduated authorization: spend up to $X per transaction, access these APIs but not those, transact on these chains but not those.

3. **Reputation is non-portable.** An agent's track record on one platform doesn't transfer to another. Each new platform starts from zero trust.

## 2. KYA Layers

KYA operates across three layers:

### Layer 1: Human Backing (Who authorized this agent?)

The agent must be traceable to a verified human or organization. KYA supports multiple attestation methods:

| Method | Provider | Trust Level | Privacy Model |
|--------|----------|-------------|---------------|
| World ID | World (Tools for Humanity) | High (biometric) | ZKP — platform verifies human uniqueness without seeing identity |
| ERC-8004 | On-chain | Medium (on-chain) | Pseudonymous — identity linked to wallet, not real-world ID |
| OAuth delegation | Any IdP | Variable | Depends on provider |
| X.509 enterprise cert | Enterprise CA | High (organizational) | Certificate reveals organization, not individual |

**Reference implementation:** World AgentKit provides World ID attestation via x402. agent-wallet-sdk provides ERC-8004 attestation. Both can coexist on the same agent.

### Layer 2: Agent Identity (What is this agent?)

Each agent has a unique, verifiable identity that includes:

- **Agent ID:** Unique identifier (ERC-8004 token ID or equivalent)
- **Operator:** Reference to Layer 1 human/org backing
- **Capabilities:** Declared set of actions the agent can perform
- **Chain scope:** Which chains the agent operates on
- **Creation timestamp:** When the agent identity was minted

**Reference implementation:** agent-wallet-sdk mints an ERC-8004 identity token for each agent. The token is bound to an ERC-6551 Token Bound Account that holds the agent's wallet.

### Layer 3: Behavioral Reputation (How has this agent behaved?)

On-chain transaction history provides verifiable behavioral signals:

- **Transaction count:** Total transactions completed
- **Success rate:** Percentage of transactions that completed without dispute
- **Volume:** Total value transacted
- **Age:** Time since first transaction
- **Policy compliance:** Whether the agent has ever violated its SpendingPolicy constraints

**Reference implementation:** agent-wallet-sdk's SpendingPolicy contract logs constraint checks on-chain. Platforms can query the agent's TBA for transaction history and policy compliance.

## 3. Verification Flow

```
Merchant/Platform                    Agent                     Identity Layer
      |                               |                              |
      |-- Request KYA attestation --> |                              |
      |                               |-- Present Layer 1 proof --> |
      |                               |<-- ZKP verification ------  |
      |                               |-- Present Layer 2 ID ----> |
      |                               |<-- Identity confirmed ----  |
      |<-- KYA bundle (L1+L2+L3) --- |                              |
      |                               |                              |
      |-- Evaluate trust score -----> |                              |
      |-- Authorize transaction ----> |                              |
      |                               |-- Execute via x402 -------> |
```

## 4. Trust Scoring

Platforms compute a trust score from the three KYA layers:

```
trust_score = w1 * human_backing_score + w2 * identity_score + w3 * reputation_score
```

Where:
- `human_backing_score`: 0-1 based on attestation method (World ID biometric = 1.0, ERC-8004 = 0.7, OAuth = 0.5)
- `identity_score`: 0-1 based on identity completeness and age
- `reputation_score`: 0-1 based on transaction history and policy compliance
- Weights (w1, w2, w3) are platform-configurable

**Minimum thresholds** are platform-defined. A high-value merchant might require trust_score > 0.8. A micropayment API might accept trust_score > 0.3.

## 5. Integration with x402

KYA attestations are included in x402 payment headers:

```
X-402-KYA-Layer1: world-id:zkp:<proof_hash>
X-402-KYA-Layer2: erc8004:<token_id>@<chain_id>
X-402-KYA-Layer3: reputation:<tx_count>:<success_rate>:<volume>
```

The receiving endpoint validates the KYA bundle before processing the x402 payment. This allows platforms to accept agent payments only from agents that meet their trust threshold.

## 6. Privacy Guarantees

- **Layer 1:** ZKP-based. The platform learns "a unique human backs this agent" without learning which human.
- **Layer 2:** Pseudonymous. The platform sees the agent's on-chain identity but not the operator's real-world identity.
- **Layer 3:** Public. Transaction history is on-chain and queryable by any platform.

The privacy gradient is intentional: maximum privacy for human identity, moderate privacy for agent identity, minimum privacy for behavioral reputation. Agents earn trust through transparent behavior, not through identity disclosure.

## 7. Non-Custodial Requirement

KYA implementations MUST NOT require custodial control of the agent's wallet or identity. Specifically:

- No third party may hold the agent's private keys
- No third party may freeze the agent's wallet without the operator's consent
- Identity attestations are bearer proofs, not permissions granted by a central authority
- SpendingPolicy constraints are enforced by smart contracts, not by platform policy

## 8. Reference Implementations

| Component | Implementation | Status |
|-----------|---------------|--------|
| Layer 1 (World ID) | World AgentKit | Beta (March 2026) |
| Layer 1 (ERC-8004) | agent-wallet-sdk | Production (v5.0.3) |
| Layer 2 (Agent ID) | agent-wallet-sdk ERC-8004 | Production |
| Layer 3 (Reputation) | agent-wallet-sdk SpendingPolicy | Production |
| Payment rail | x402 + agentpay-mcp | Production (v1.2.0) |

## 9. Open Questions

- Should KYA attestations be cached or re-verified per transaction?
- How do cross-chain agents maintain a unified reputation score?
- What's the dispute resolution mechanism when a KYA-verified agent misbehaves?
- How does KYA interact with GDPR's right to be forgotten for on-chain reputation data?

## References

- [World AgentKit launch (CoinDesk)](https://www.coindesk.com/tech/2026/03/17/sam-altman-s-world-teams-up-with-coinbase-to-prove-there-is-a-real-person-behind-every-ai-transaction)
- [x402 Protocol](https://blog.cloudflare.com/x402/)
- [ERC-8004 Standard](https://eips.ethereum.org/EIPS/eip-8004)
- [ERC-6551 Token Bound Accounts](https://eips.ethereum.org/EIPS/eip-6551)
- [agent-wallet-sdk](https://github.com/up2itnow0822/agent-wallet-sdk)
- [agentpay-mcp](https://github.com/up2itnow0822/agentpay-mcp)
