# x402 Integration Guide

> Connect agent-wallet-sdk to the x402 machine-economy payment protocol across all EVM chains.

## What is x402?

x402 is an HTTP payment protocol for AI agents. When an agent hits a paid endpoint, the server responds with HTTP 402 (Payment Required). The agent pays in USDC, the server verifies, and the resource unlocks — no human, no credit card, no custody transfer.

**2026 Milestones:**
- Stripe integrated x402 on Base (Feb 2026)
- Etherlink (Tezos EVM) shipped x402 support (Mar 2026)
- Hyperbolic and CoinGecko live as x402 consumers
- 115M+ micropayments processed

## Why Non-Custodial Matters

Most x402 implementations route payments through a custodial server wallet. Your agent asks permission to spend — it's a proxy, not an autonomous actor.

`agent-wallet-sdk` gives your agent **actual key ownership**. The private key lives with the agent. No intermediary can freeze it, rate-limit it, or take custody of its funds.

## Installation

```bash
npm install agent-wallet-sdk
# or
pip install agent-wallet-sdk
```

## Supported Chains

| Chain | Status | Notes |
|-------|--------|-------|
| Base | ✅ Live | Stripe's x402 integration |
| Ethereum | ✅ Live | Mainnet USDC |
| Arbitrum | ✅ Live | Low fees |
| Optimism | ✅ Live | Low fees |
| Etherlink | ✅ Live | Tezos EVM, x402 native |
| Any EVM | ✅ | CCTP cross-chain transfers |

## Quick Start — Pay an x402 Endpoint

```typescript
import { AgentWallet } from 'agent-wallet-sdk';

const wallet = new AgentWallet({
  chain: 'base',
  privateKey: process.env.AGENT_PRIVATE_KEY, // agent holds its own key
});

// Automatic 402 detection and payment
const response = await wallet.fetchWithX402('https://api.hyperbolic.xyz/v1/completions', {
  method: 'POST',
  body: JSON.stringify({ prompt: 'Hello', max_tokens: 100 }),
  maxPaymentUSDC: '0.05', // spending cap per request
});

const data = await response.json();
```

## Manual x402 Payment Flow

```typescript
import { AgentWallet } from 'agent-wallet-sdk';

const wallet = new AgentWallet({
  chain: 'base',
  privateKey: process.env.AGENT_PRIVATE_KEY,
});

// Step 1: Hit the endpoint
const probe = await fetch('https://paid-api.example.com/data');

if (probe.status === 402) {
  const paymentDetails = await probe.json();
  // { recipient: '0x...', amount: '0.001', currency: 'USDC', chain: 'base' }

  // Step 2: Pay non-custodially
  const tx = await wallet.payX402({
    recipient: paymentDetails.recipient,
    amount: paymentDetails.amount,
    currency: 'USDC',
    chain: paymentDetails.chain,
  });

  // Step 3: Retry with payment proof
  const result = await fetch('https://paid-api.example.com/data', {
    headers: { 'X-Payment-Transaction': tx.hash },
  });

  const data = await result.json();
}
```

## Accept x402 Payments (Server Side)

If you're building an x402-compatible API, use the server-side utilities:

```typescript
import { createX402Middleware } from 'agent-wallet-sdk/x402';
import express from 'express';

const app = express();

app.use('/premium', createX402Middleware({
  recipient: process.env.YOUR_WALLET_ADDRESS,
  price: '0.001', // USDC per request
  chain: 'base',
  currency: 'USDC',
}));

app.get('/premium/data', (req, res) => {
  // Only reached after payment verified
  res.json({ data: 'premium content' });
});
```

## Cross-Chain x402 (CCTP)

Agent has USDC on Arbitrum, endpoint requires Base? CCTP handles it automatically:

```typescript
const wallet = new AgentWallet({
  chain: 'arbitrum', // agent's home chain
  privateKey: process.env.AGENT_PRIVATE_KEY,
  cctp: true, // enable cross-chain transfers
});

// Agent pays Base endpoint from Arbitrum funds — CCTP bridges automatically
const response = await wallet.fetchWithX402('https://base-api.example.com/endpoint', {
  targetChain: 'base', // where the endpoint expects payment
  maxPaymentUSDC: '0.01',
});
```

## Python Example

```python
from agent_wallet_sdk import AgentWallet

wallet = AgentWallet(
    chain="base",
    private_key=os.environ["AGENT_PRIVATE_KEY"]
)

# Pay x402 endpoint
response = wallet.fetch_with_x402(
    "https://api.coingecko.com/x402/v1/price",
    params={"ids": "bitcoin", "vs_currencies": "usd"},
    max_payment_usdc="0.001"
)

print(response.json())
```

## Security

- **Never log private keys.** Use environment variables or a secrets manager.
- **Set spending caps.** Use `maxPaymentUSDC` to prevent runaway spend.
- **Verify payment recipients.** Whitelist trusted x402 providers for autonomous agents.
- **Monitor balances.** Set alerts when the agent wallet drops below operational threshold.

## Live x402 Providers

| Provider | Use Case | Chain |
|----------|----------|-------|
| Hyperbolic | AI inference | Base |
| CoinGecko | Price data | Base |
| Stripe (via x402) | Commerce APIs | Base |
| Etherlink APIs | Tezos EVM data | Etherlink |

## Resources

- [x402 Protocol Spec](https://x402.org)
- [agent-wallet-sdk npm](https://www.npmjs.com/package/agent-wallet-sdk)
- [GitHub](https://github.com/up2itnow0822/agent-wallet-sdk)
- [WebMCP Integration](https://github.com/up2itnow0822/agent-wallet-sdk/docs/webmcp-integration.md)

---

*Built by the agent-wallet-sdk team. Non-custodial, developer-first, machine-economy ready.*
