# Enterprise agent-payment compatibility note

_Last verified: 2026-05-12 CT_

Agent-payment infrastructure is converging on two complementary modes:

1. **User-delegated checkout credentials** — Stripe Link for agents can grant a one-time-use card or Shared Payment Token without exposing raw payment credentials. Sellers should treat the token as a bounded mandate with usage limits, currency, max amount, and expiry.
2. **Autonomous machine micropayments** — Amazon Bedrock AgentCore Payments (preview), built with Coinbase and Stripe, handles x402 negotiation, wallet authentication, stablecoin payment execution, session spending limits, governance, and observability for agents paying APIs, MCP servers, web content, and other agents.

## Portable mandate / receipt fields

Use these fields when mapping Stripe Link/SPT, AWS AgentCore/x402, Google AP2-style, or mobile-wallet delegation flows into agentwallet policy and audit logs.

| Field | Why it matters | Maps to |
| --- | --- | --- |
| `mandate_id` | Stable reference for the delegated permission or x402 payment session | SPT/granted token id, AgentCore session/payment id, AP2 mandate id |
| `payment_mode` | Distinguishes user-approved checkout from autonomous resource micropayments | `delegated_checkout`, `machine_micropayment` |
| `wallet_provider` | Identifies who holds/authenticates the payment credential | Link, Stripe Privy, Coinbase CDP, on-chain wallet |
| `agent_id` | Binds the permission to the acting agent | agent identity / tool runner / wallet account |
| `resource` | Describes the paid API, MCP server, web content, product, or counterparty | URL, MCP server id, merchant, x402 endpoint |
| `currency` | Prevents cross-currency ambiguity | USD, USDC, seller/token currency |
| `max_amount` | Enforces deterministic spend limits | SPT usage limit, AgentCore session spending limit, agentwallet policy |
| `expires_at` | Makes delegation time-bounded | SPT expiry, session expiry, mandate expiry |
| `raw_credential_access` | Should be deny-by-default | `false` for Link/SPT-style credentials; agentwallet should log any exception as high risk |
| `proof` | Verifies authorization/payment completion | x402 proof, SPT grant, signed mandate, transaction hash |
| `receipt_id` | Auditable post-action evidence | x402 settlement/proof id, provider receipt, on-chain tx hash |
| `trace_id` | Correlates payment with agent execution logs | AgentCore trace/log id, app request id, agentwallet audit correlation id |

## Implementation guidance

- **Deny raw credential handling by default.** Accept bounded tokens/proofs/receipts; do not store card, bank, or private-key material in app logs.
- **Normalize every provider into the mandate table above.** This keeps Link/SPT, x402, AP2-style, and mobile-wallet flows comparable for enterprise audits.
- **Attach `trace_id` to each payment attempt.** AgentCore highlights observability; agentwallet integrations should expose equivalent audit correlation for non-AgentCore deployments.
- **Prefer policy enforcement before payment execution.** Validate amount, currency, expiry, resource, and agent identity before invoking x402 fetch or checkout-token flow.

## Sources verified

- AWS AgentCore Payments preview, 2026-05-07: https://aws.amazon.com/about-aws/whats-new/2026/04/amazon-bedrock-agentcore-payments-preview/
- AWS AgentCore Payments blog, 2026-05-07: https://aws.amazon.com/blogs/machine-learning/agents-that-transact-introducing-amazon-bedrock-agentcore-payments-built-with-coinbase-and-stripe/
- Stripe Link wallet for agents, 2026-04-29: https://stripe.com/blog/giving-agents-the-ability-to-pay
- Stripe Shared Payment Tokens docs: https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens
- Coinbase AgentCore/x402 integration, 2026-05-07: https://www.coinbase.com/blog/introducing-amazon-bedrock-agentcore-payments-powered-by-x402-and-coinbase
