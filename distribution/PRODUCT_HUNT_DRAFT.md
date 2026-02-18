# Product Hunt Launch Draft — AgentWallet SDK

## Tagline (60 chars max)
**Non-custodial crypto wallet for AI agents with on-chain limits**

## One-liner
Give your AI agent autonomous spending power — with hard on-chain caps it can't override.

## Description

Coinbase just shipped custodial agent wallets. Stripe launched merchant-side agent payments. Both require trusting a third party with your agent's funds.

**AgentWallet is the non-custodial alternative.**

Your AI agent gets its own crypto wallet on Base with spending limits enforced by smart contracts — not API configs, not confirmation prompts, not rate limits. On-chain. Immutable. Auditable.

**How it works:**
- 🔑 Agent holds its own keys (non-custodial)
- 📏 Owner sets per-tx and daily spending caps on-chain
- ✅ Under-limit transactions execute instantly — no human needed
- ⏳ Over-limit transactions queue for owner approval
- 🌐 x402 protocol support — your agent pays APIs with `fetch()`

**Built on:**
- ERC-6551 token-bound accounts (wallet = NFT, portable & composable)
- Base Mainnet (low gas, Coinbase ecosystem)
- TypeScript SDK with full type safety

**Why not custodial?** One prompt injection + custodial API = drained funds. With AgentWallet, even a compromised agent can only spend within its on-chain limits.

```bash
npm install agentwallet-sdk viem
```

Open source. MIT licensed. Ship it today.

## Topics
- Artificial Intelligence
- Developer Tools
- Web3
- Crypto
- Open Source

## Makers
@up2itnow5280 *(update with PH handle)*

## Gallery Images Needed
1. Hero: "Agent Wallet — Autonomous spending, on-chain limits" with flow diagram
2. Comparison table: AgentWallet vs Coinbase CDP vs Stripe
3. Code snippet: Quick start (3 lines)
4. x402 fetch() demo
5. Architecture diagram

## First Comment (from maker)

Hey Product Hunt! 👋

I built AgentWallet because I kept running into the same problem: every agent wallet solution either gives the agent full access (terrifying) or requires human approval for everything (defeats the purpose).

The big players just shipped their versions — Coinbase CDP (custodial) and Stripe Agent Toolkit (merchant-side). Both work, but both require trusting a centralized party.

AgentWallet takes a different approach: **non-custodial, on-chain enforced limits.** Your agent's spending caps are in a smart contract. No API key leak can override them. No prompt injection can drain more than the daily limit.

It's live on Base Mainnet, supports x402 machine payments, and is fully open source (MIT).

Would love feedback from anyone building AI agents that need to spend money. What limits would you want to set? What's missing?

## Launch Timing
- **Best days:** Tuesday–Thursday
- **Optimal:** Schedule for a week when no major PH launches conflict
- **Prep:** Have 5+ upvotes ready at launch, respond to every comment within 1 hour
