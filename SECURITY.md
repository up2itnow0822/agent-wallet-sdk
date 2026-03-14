# Security Policy - agent-wallet-sdk

## Supported Versions

| Version | Supported |
|---------|-----------|
| 5.x     | Yes       |
| 4.x     | Security patches only |
| < 4.0   | No        |

## Reporting a Vulnerability

Report security vulnerabilities to: **security@ai-agent-economy.com**

We will acknowledge receipt within 48 hours and provide a detailed response within 7 days.

Do NOT open a public GitHub issue for security vulnerabilities.

## Key Isolation Architecture

agent-wallet-sdk is designed with the assumption that the host orchestration layer (OpenClaw or any agent framework) will eventually be compromised. Our key management architecture reflects this threat model.

### Architectural Principles

1. **Private keys never enter the orchestration process space.** Keys are managed in an isolated key vault with its own memory space. The orchestration layer communicates through a structured API boundary - it can request signatures but never accesses raw key material.

2. **On-chain spending guardrails.** SpendingPolicy contracts enforce per-transaction limits, daily caps, and recipient allowlists at the smart contract level. These limits are enforced on-chain regardless of how the transaction request originated - a compromised orchestration layer cannot bypass them.

3. **ERC-6551 token-bound accounts.** Each agent wallet is bound to an NFT, providing auditable on-chain identity. All wallet activity is traceable and anomalous patterns are detectable independently of the orchestration layer.

4. **No shared secrets.** Orchestration auth tokens (like those targeted by CVE-2026-25253) are completely separate from agent-wallet-sdk's key hierarchy. Compromising an OpenClaw session does not grant access to wallet keys.

### CVE-2026-25253 Impact Assessment

**CVE-2026-25253** (CVSS 8.8) affects OpenClaw's authentication token handling, allowing malicious MCP plugins to intercept and replay auth tokens from the host process.

**agent-wallet-sdk is NOT affected by this CVE.** The vulnerability targets OpenClaw's session tokens, which are architecturally separate from agent-wallet-sdk's cryptographic key management. Specifically:

- agent-wallet-sdk private keys are stored in an isolated process, not in OpenClaw's memory space
- SpendingPolicy guardrails are enforced on-chain and cannot be bypassed by replaying OpenClaw auth tokens
- ERC-6551 wallet operations require cryptographic signatures from the isolated key vault, not OpenClaw session tokens

### Recommended Deployment Hardening

Even though agent-wallet-sdk keys are isolated from orchestration-layer vulnerabilities, we recommend:

- Run MCP tools in Docker containers with `read_only: true` and `no-new-privileges`
- Rotate orchestration auth tokens every 24 hours
- Network-segment the wallet service from the orchestration host
- Monitor for token reuse from unexpected IP addresses
- Keep agent-wallet-sdk updated to the latest 5.x release

## Dependency Security

We run `npm audit` on every release. Critical or high severity dependency vulnerabilities block releases until resolved.

## Disclosure Timeline

We follow coordinated disclosure with a 90-day window. If we discover a vulnerability in a dependency or related project, we will notify the maintainers and allow 90 days before public disclosure.
