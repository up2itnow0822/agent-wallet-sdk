# Security Policy - agent-wallet-sdk

## Supported Versions

| Surface | Supported |
| --- | --- |
| TypeScript SDK `6.x` | Yes |
| Unity x402 SDK `1.x` beta | Yes |
| TypeScript SDK `5.x` | Security patches only |
| Older releases and pre-release snapshots | No |

## Reporting a Vulnerability

Report security vulnerabilities to:
<security@ai-agent-economy.com>

We will acknowledge receipt within 48 hours and provide a detailed response
within 7 days.

Do not open a public GitHub issue for security vulnerabilities.

## Security Model

`agent-wallet-sdk` is non-custodial developer tooling. The SDK does not run a
hosted custody service or take possession of your funds.

What the SDK does provide:

1. On-chain policy and payment primitives such as x402 flows and spend-policy
   integrations where the underlying chain/contracts support them.
2. Auditable transaction execution through your wallet client or signer.
3. Integration points so you can keep signing in your own infrastructure.

What the SDK does not guarantee by itself:

1. Host-process isolation for raw private keys.
2. Protection from a compromised application process if you load secrets
   directly into that process.
3. A managed approval, HSM, or vault service.

## Recommended Hardening

- Keep signing keys in a hardware wallet, HSM, vault, or dedicated signer
  service whenever your stack allows it.
- Prefer signer injection or file-based secret mounts over passing secrets on
  CLI arguments.
- Set low per-transaction and period caps before allowing autonomous payment
  flows.
- Run automation and MCP-adjacent tooling in isolated containers or dedicated
  service accounts.
- Pin dependencies and review changes before production rollout.

## Dependency Security

We run dependency audits as part of release preparation. Critical or high
severity dependency vulnerabilities block a release until resolved or formally
waived with a documented mitigation.

## Disclosure Timeline

We follow coordinated disclosure with a 90-day window. If we discover a
vulnerability in a dependency or related project, we notify the maintainers and
allow up to 90 days before public disclosure unless active exploitation
requires a faster response.
