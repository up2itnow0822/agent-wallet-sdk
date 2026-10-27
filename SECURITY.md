# Security policy — agentwallet-sdk

## Review scope

Security fixes in this repository target the current 8.x source. Published
7.0.0 and earlier do not include the October 25, 2026 repairs; an installed
package does not acquire fixes until a patched release is published and
installed. See `docs/security-remediation.md` for migration requirements and
the remaining external deployment boundaries.

## Reporting a vulnerability

Report vulnerabilities to **security@ai-agent-economy.com**. Do not include
private keys or production credentials. Do not open public issues containing
unremediated exploit details. The maintainers' stated response targets are an
acknowledgment within 48 hours and a detailed response within seven days.

## Keys and authorization

The SDK is non-custodial: the caller supplies a wallet client or signer.
Non-custodial does not mean process isolation. `walletFromEnv()` and the ElizaOS
integration derive a local account from a private key in the calling process.
A compromised host or plugin with access to that process can obtain the key
or request signatures. The SDK does not implement a separate key vault, an
isolated signing service, or immunity to orchestration-layer vulnerabilities.
For isolation, supply a signer backed by a separately secured service or
hardware wallet and enforce its authorization outside the compromised host.

Before any agent or owner write, the SDK verifies that the configured account
has non-delegated contract code that answers the AgentAccountV2 views on the
signer's chain; supply `deployment` (trusted factory + token binding) or
`expectedCodeHash` to `createWallet()` for a strong deployment identity.
On-chain restrictions depend on the actual deployed wallet contract and its
configuration. This repository supplies ABIs, not audited Solidity sources or
a deployment manifest. The local `SpendingPolicy` and x402 budgets are in-memory
client controls. They cannot constrain direct signer use, independent SDK
instances, or other processes. Persist and reconcile pending payment intents
before creating a replacement client or retrying after a restart.

## Payment failure handling

Unknown submission outcomes retain capacity and prohibit automatic retry,
including cases where an RPC did not return a transaction hash. A successful
merchant HTTP response is not proof of an on-chain payment, and a failed HTTP
response is not proof that a confirmed payment failed. Reconcile the original
transaction; do not create a second payment to clear an uncertain result.

Environment bootstrap helpers apply USDC-denominated limits only to the wallet
chain's USDC. `SPEND_ALLOWLIST` restricts merchant recipients in the x402 client;
it is not a recipient restriction installed in the wallet contract. The fixed
protocol fee recipient is a separate explicit debit included in the budget.

ERC-8004 external metadata resolution is disabled by default. A caller-supplied
resolver is trusted network code and must enforce allowed destinations,
redirect policy, DNS and private-address restrictions, connection pinning,
and response limits. The SDK does not make that network transport safe by
accepting an arbitrary fetch callback.

## External data is untrusted

RPC endpoints, Circle attestation endpoints, UAID brokers, Stellar Horizon,
quoters and x402 merchants are treated as adversarial. The SDK never lets
their responses choose a signed token scale, chain, recipient or settlement
status: token decimals are pinned, chains are bound, swap minimums require a
caller floor, attestations are bound to the known burn message, broker
identity claims are reported as `brokerAttested` and verified on-chain
separately, and every untrusted HTTP read has a deadline and a size cap.

## Dependency and release checks

The verification workflows run the build, tests, lint and dependency audit.
All workflow actions are pinned to full commit SHAs.
High and critical advisory results fail verification. GitHub ruleset settings
must independently require the intended verification and review checks;
workflow definitions alone do not enforce merge policy.

Automated tests use fixtures and mocked signing/network boundaries. They do
not move real funds or establish the safety of external deployed contracts.
