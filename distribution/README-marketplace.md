# 🔐 AgentWallet SDK — Non-Custodial Wallets for AI Agents

[![npm version](https://img.shields.io/npm/v/agentwallet-sdk.svg)](https://www.npmjs.com/package/agentwallet-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Base Mainnet](https://img.shields.io/badge/Chain-Base%20Mainnet-0052FF.svg)](https://base.org)
[![x402 Compatible](https://img.shields.io/badge/Protocol-x402-blueviolet.svg)](https://x402.org)
[![ERC-6551](https://img.shields.io/badge/Standard-ERC--6551-orange.svg)](https://eips.ethereum.org/EIPS/eip-6551)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

**Give your AI agent a crypto wallet with hard on-chain spending limits. No custodian. No API keys to leak. No prompt injection draining funds.**

> Coinbase CDP is custodial. Stripe Agent Toolkit is merchant-side. AgentWallet is the **non-custodial, agent-side** alternative — open source and on-chain.

---

## 🎯 What It Does

AgentWallet lets AI agents spend crypto **autonomously** within owner-defined limits:

- ✅ **Under limit** → Transaction executes instantly, no human needed
- ⏳ **Over limit** → Queued for owner approval
- 🛑 **Daily cap hit** → All spending paused until reset

All limits enforced **on-chain** via smart contracts. Not API rate limits. Not off-chain configs. Immutable, auditable, trustless.

## 🔑 Key Features

| Feature | Description |
|---------|-------------|
| **Non-Custodial** | Agent holds its own keys. No third party controls funds. |
| **On-Chain Spend Limits** | Per-transaction and daily caps enforced by smart contract |
| **x402 Protocol** | Drop-in `fetch()` replacement for HTTP 402 machine payments |
| **ERC-6551 Accounts** | Wallet tied to NFT — portable, auditable, composable |
| **Multi-Chain** | Base (primary), Ethereum, Arbitrum, Polygon |
| **Budget Forecasting** | Know remaining budget + when it resets |
| **Activity History** | On-chain audit trail, no external indexer needed |
| **Batch Transfers** | Multi-recipient payments in one call |
| **TypeScript** | Full type safety, viem-native |

## ⚡ Quick Start

```bash
npm install agentwallet-sdk viem
```text

```typescript
import { createWallet, agentExecute, setSpendPolicy, NATIVE_TOKEN } from 'agentwallet-sdk';

// Connect to agent's wallet
const wallet = createWallet({
  accountAddress: '0xYOUR_AGENT_ACCOUNT',
  chain: 'base',
  walletClient, // viem WalletClient
});

// Owner sets limits: 0.025 ETH/tx, 0.5 ETH/day
await setSpendPolicy(wallet, {
  token: NATIVE_TOKEN,
  perTxLimit: 25_000000000000000n,
  periodLimit: 500_000000000000000n,
  periodLength: 86400,
});

// Agent spends autonomously within limits
await agentExecute(wallet, {
  to: '0xSERVICE',
  value: 10_000000000000000n, // 0.01 ETH — auto-approved
});
```text

## 🌐 x402 Machine Payments

Pay any x402-enabled API automatically — like `fetch()` but with built-in crypto payments:

```typescript
import { createX402Fetch } from 'agentwallet-sdk';

const x402Fetch = createX402Fetch(wallet, { globalDailyLimit: 100_000_000n });
const response = await x402Fetch('https://api.weather.com/forecast');
// 402 → auto-pay USDC on Base → retry → get data
```text

## 🆚 Why AgentWallet vs. Alternatives

| | AgentWallet | Coinbase CDP | Stripe Agent Toolkit |
|---|---|---|---|
| **Custody** | Non-custodial ✅ | Custodial ❌ | Merchant-side ❌ |
| **Limit Enforcement** | On-chain smart contract | API rate limits | Confirmation prompts |
| **Protocol** | x402 + ERC-6551 (open) | Proprietary | Proprietary |
| **Who holds keys** | Your agent | Coinbase | N/A (fiat) |
| **Open Source** | MIT ✅ | No | No |
| **Base Native** | Yes | Yes | No |

## 🏗️ Architecture

```text
Owner (you)                    Agent (AI)
    │                              │
    ├─ setSpendPolicy()            │
    ├─ approveTransaction()        │
    │                              ├─ agentExecute()     → auto if under limit
    │                              ├─ agentTransferToken() → auto if under limit
    │                              ├─ x402Fetch()        → pay APIs automatically
    │                              └─ checkBudget()      → self-monitor
    │                              │
    └──────── AgentAccountV2 (on-chain) ────────┘
              ERC-6551 Token-Bound Account
              All limits enforced in Solidity
```text

## 📦 Installation

```bash
# npm
npm install agentwallet-sdk viem

# yarn
yarn add agentwallet-sdk viem

# pnpm
pnpm add agentwallet-sdk viem
```text

## 🔗 Links

- **npm:** [agentwallet-sdk](https://www.npmjs.com/package/agentwallet-sdk)
- **GitHub:** [agent-wallet-sdk](https://github.com/up2itnow5280/agent-wallet-sdk) *(update with actual URL)*
- **x402 Protocol:** [x402.org](https://x402.org)
- **Base:** [base.org](https://base.org)

## 📄 License

MIT — use it, fork it, ship it.

---

**Keywords:** ai agent wallet, non-custodial agent wallet, x402 payments, erc-6551 token bound account, base mainnet sdk, ai agent crypto, autonomous agent spending, on-chain spend limits, machine payments, agent wallet sdk, web3 ai agents, typescript wallet sdk
