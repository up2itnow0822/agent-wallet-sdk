# agent-wallet-sdk

Non-custodial wallet SDK for AI agents. x402 micropayments, CCTP cross-chain transfers, token swaps.

[![npm version](https://img.shields.io/npm/v/agent-wallet-sdk.svg)](https://www.npmjs.com/package/agent-wallet-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Install

```bash
npm install agent-wallet-sdk
```

---

## Quick Start

```typescript
import { AgentWallet } from 'agent-wallet-sdk';

// Generate a non-custodial wallet. Keys stay local.
const wallet = await AgentWallet.create();

// Pay via x402 -- no custodian, no approval gate
await wallet.payX402('https://api.dataservice.com/endpoint', {
  amount: '0.001',
  currency: 'USDC'
});

// Cross-chain USDC transfer via CCTP
await wallet.cctpTransfer({
  amount: '10.00',
  fromChain: 'ethereum',
  toChain: 'base',
  recipient: '0xRecipientAddress'
});
```

---

## Why Non-Custodial? The Security Case

Coinbase launched custodial agent wallets February 11, 2026. OKX followed with OnchainOS March 3rd. Circle Arc and Stripe Tempo both offer agent payment infrastructure with the same model: the platform holds the private keys.

That works for humans. It's the wrong architecture for autonomous agents.

### The Custodial Problem

When a platform holds your agent's keys, you're exposed to:

| Risk | What It Means |
|------|---------------|
| Platform outage | Your agent can't transact during downtime |
| Compliance freeze | A single regulatory flag blocks execution instantly |
| Jurisdiction blocks | US-based custodians (Circle, Coinbase) are subject to OFAC, FinCEN |
| Centralized failure | If Coinbase has issues, every agent using Coinbase Agentic Wallets goes down simultaneously |
| Auth compromise | If the custody platform's auth layer is breached, your agent's funds are exposed |

An agent can't call support at 2 AM when a compliance flag fires mid-task. There's no recovery path.

### The Non-Custodial Advantage

agent-wallet-sdk generates and manages private keys locally. The agent owns the wallet. The keys never leave the agent's environment.

- No API controls the wallet
- No platform can freeze funds
- No single point of failure across the agent economy
- Regulatory exposure is limited to on-chain activity, not custodian relationships

The attack surface is fundamentally smaller. Failure modes are local, not systemic.

### Custodial vs Non-Custodial: Direct Comparison

| Feature | Coinbase Agentic Wallets | Circle Arc | agent-wallet-sdk |
|---------|--------------------------|------------|-----------------|
| Key custody | Coinbase | Circle | Agent (local) |
| Can be frozen | Yes | Yes | No |
| API dependency | Required | Required | None |
| Regulatory exposure | High (US-based) | High (US-based) | On-chain only |
| Failure blast radius | All users | All users | Local only |
| x402 native support | No | No | Yes |
| CCTP cross-chain | Via API | No | Native |

### When Custodial Is Fine

Low-frequency agent tasks where a human can intervene. If your agent makes 5 transactions a day and a freeze is recoverable, custodial UX is simpler.

When you need guaranteed execution, autonomous operation across jurisdictions, or high-frequency micropayments -- non-custodial is the only architecture that works.

---

## Why Not OKX OnchainOS?

OKX launched its AI layer on OnchainOS on March 3, 2026 -- wallet infrastructure, liquidity routing, and data feeds packaged for AI agents. It's a capable stack if you're already inside the OKX ecosystem.

But it's the wrong choice for most builders:

- **Closed ecosystem.** OnchainOS is exchange-native. Your agent's wallet infrastructure is tied to OKX's platform, policies, and availability.
- **Custodial by design.** OKX holds the keys. That means OKX can freeze, restrict, or shut down your agent's ability to transact.
- **Exchange-dependent liquidity.** Swaps and transfers route through OKX's own liquidity layer. You're not chain-agnostic -- you're OKX-dependent.

agent-wallet-sdk is open-source, non-custodial, and chain-agnostic. No vendor lock-in. No platform that can pull the rug. Your agent owns its wallet.

| Feature | OKX OnchainOS | agent-wallet-sdk |
|---------|--------------|-----------------|
| Open source | No | Yes (MIT) |
| Custody model | OKX-custodial | Non-custodial (local keys) |
| Exchange dependency | Required (OKX) | None |
| Chain support | OKX-native chains | Any EVM chain |
| Can be frozen | Yes | No |
| x402 native | No | Yes |

If you want to build agents that operate freely -- across chains, without a platform intermediary -- agent-wallet-sdk is the right tool.

---

## x402 Integration

x402 is the HTTP-native micropayment protocol for machine-to-machine payments. It has processed 115M+ micropayments between machines as of early 2026.

```typescript
// Pay for API access per-request
const response = await wallet.payX402(endpoint, {
  amount: '0.0001',
  currency: 'USDC',
  chain: 'base'
});
```

No gas overhead. No pre-authorization. The agent pays for what it uses.

---

## Cross-Chain Transfers (CCTP)

```typescript
// Move USDC from Ethereum to Base via Coinbase CCTP
await wallet.cctpTransfer({
  amount: '100.00',
  fromChain: 'ethereum',
  toChain: 'base',
  recipient: recipientAddress
});
```

Native CCTP integration means no bridge risk. USDC moves between chains as a native burn/mint operation.

---

## Architecture Overview

```
Agent Environment (local)
├── AgentWallet
│   ├── Private Key (never leaves this environment)
│   ├── x402 Payment Handler
│   └── CCTP Bridge Client
└── On-chain Activity Only
    ├── Base (USDC)
    ├── Ethereum (USDC)
    └── Other EVM chains
```

---

## Full Documentation

- [npm package](https://www.npmjs.com/package/agent-wallet-sdk) -- v0.4.1
- [Hashnode article: Non-Custodial vs Custodial](https://ai-agent-economy.hashnode.dev/circle-vs-stripe-vs-agent-wallet-sdk-non-custodial-advantage)

---

## Contributing

PRs welcome. Open an issue first for significant changes.

---

## License

MIT
