# AgentWallet SDK

> **v6.0.0** · MIT · **Patent Pending**
>
> USPTO Provisional filed March 2026: "Non-Custodial Multi-Chain Financial Infrastructure System for Autonomous AI Agents"

**Your AI agent needs to pay for things. Giving it your credit card is insane.**

The actual problem: your agent is in a loop, it hits a paid API, and it needs to pay. The naive solution (raw wallet + private key) means one prompt injection or runaway loop drains everything. AgentWallet SDK gives your agent a wallet with hard on-chain spending limits, human approval by default, and no custody of your keys.

```
Agent wants to spend $0.50  → ✅ Auto-approved (under your $1/tx threshold)
Agent wants to spend $50    → ⏳ Queued — you get notified to approve or reject
Agent spent $9.50 today     → 🛑 Next tx blocked ($10/day cap hit)
```

The caps are enforced by smart contract. Application code — including the agent itself — cannot override them.

## Why Not Just Give the Agent a Wallet?

| Approach | Problem |
|----------|---------|
| Raw EOA wallet | One prompt injection or loop bug = everything drained |
| Multisig (Safe) | Every transaction needs manual signatures — kills the point of automation |
| Custodial API | Centralized, KYC friction, not crypto-native |
| **AgentWallet SDK** | **On-chain limits + human approval threshold + non-custodial. Agent spends within bounds; everything else queues.** |

## Quick Start

```bash
npm install agentwallet-sdk viem
```

### Set Up a Wallet with Spend Caps

```typescript
import { createWallet, setSpendPolicy, NATIVE_TOKEN } from 'agentwallet-sdk';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({ account, chain: base, transport: http() });

const wallet = createWallet({
  accountAddress: process.env.AGENT_WALLET_ADDRESS as `0x${string}`,
  chain: 'base',
  walletClient,
});

// Spend policy — lives on-chain, not in your app code
// Agent cannot spend more than this even if instructed to
await setSpendPolicy(wallet, {
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
  perTxLimit: 5_000_000n,    // $5 max per transaction
  periodLimit: 50_000_000n,  // $50/day hard cap
  periodLength: 86400,       // resets every 24 hours
});
```

### Pay for an API (the 402 Flow)

```typescript
import { createX402Client } from 'agentwallet-sdk';

const x402 = createX402Client(wallet, {
  supportedNetworks: ['base:8453'],
  globalDailyLimit: 50_000_000n,    // matches spend policy
  globalPerRequestMax: 5_000_000n,  // $5 max per request
  requireApproval: true,            // human-in-the-loop (default)
});

// Agent hits a premium API and gets 402 — SDK handles it
const response = await x402.fetch('https://api.example.com/premium-report');
const data = await response.json();
// Cost: $0.50 USDC, auto-approved (under $5 threshold)
// Every payment: tx hash on Base, auditable on basescan.org
```

## The Trust Layer

This is what makes supervised payments different from autonomous payments.

### Simulation Mode

Before any real payment, run in simulation to see exactly what would happen:

```typescript
const x402 = createX402Client(wallet, {
  supportedNetworks: ['base:8453'],
  globalDailyLimit: 50_000_000n,
  globalPerRequestMax: 5_000_000n,
  dryRun: true,  // no funds move
});

const response = await x402.fetch('https://api.example.com/premium-report');
// Response: { simulated: true, wouldHavePaid: '0.50 USDC', withinLimits: true, dailyTotal: '2.00 USDC' }
```

### Human Approval for High-Value Payments

```typescript
import { createWallet, agentExecute } from 'agentwallet-sdk';

// Transactions above your per-tx limit queue for approval
const result = await agentExecute(wallet, {
  to: '0xRecipient',
  value: 50_000_000_000_000_000n, // 0.05 ETH (~$130)
});

if (result.executed) {
  console.log('Sent:', result.txHash);
} else {
  console.log('Queued for approval — tx ID:', result.queueId);
  // Your approval system gets notified; agent waits or continues other work
}
```

### Explainability — Agent Must Show Its Work

Before any payment above your threshold, the agent surfaces:
- What it's paying for
- What the expected outcome is
- What it will do if the payment fails

```typescript
const paymentIntent = {
  url: 'https://api.example.com/market-data',
  amount: '2.00 USDC',
  reason: 'Fetching historical price data for AAPL 2023-2024',
  expectedOutcome: 'CSV with daily OHLCV data, ~500 rows',
  fallback: 'Use cached data from 2024-01-15 (3 months old)',
};

// Human sees this before approving anything above threshold
const approved = await requestHumanApproval(paymentIntent);
if (!approved) {
  return useFallback(paymentIntent.fallback);
}
```

### Safe Abort

When a payment fails or is rejected, the agent handles it gracefully — not by retrying indefinitely:

```typescript
const result = await x402.fetch('https://api.example.com/premium-data');

if (!result.ok) {
  switch (result.status) {
    case 402:
      // Payment rejected or limit hit — fall back to free alternative
      return await fetchFreeAlternative();
    case 'limit-exceeded':
      // Daily cap hit — log it, stop trying today
      console.log('Daily spend cap reached. Resuming tomorrow.');
      return null;
    case 'approval-rejected':
      // Human said no — respect that
      console.log('Payment rejected by human. Using cached data.');
      return getCachedResult();
  }
}
```

## Production-Ready: Failure Handling, Retries, Fallbacks

Real agent deployments fail. Here's how to handle it.

### Retry with Backoff

```typescript
import { createX402Client } from 'agentwallet-sdk';

async function fetchWithRetry(
  x402: ReturnType<typeof createX402Client>,
  url: string,
  maxAttempts = 3,
): Promise<Response> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await x402.fetch(url);
      if (response.ok) return response;

      // Don't retry on rejected payments or limit hits
      if (['limit-exceeded', 'approval-rejected'].includes(response.status as string)) {
        throw new Error(`Payment stopped: ${response.status}`);
      }
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      // Exponential backoff: 1s, 2s, 4s
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw new Error('Max retries exceeded');
}
```

### Fallback to Free Data Sources

```typescript
async function getMarketData(symbol: string): Promise<MarketData> {
  // Try paid source first (better data quality)
  try {
    const response = await fetchWithRetry(x402, `https://paid-api.com/data/${symbol}`);
    return await response.json();
  } catch (err) {
    console.warn(`Paid API unavailable: ${err.message}. Falling back to free source.`);
    // Fall back to free source (rate-limited, less complete)
    const fallback = await fetch(`https://free-api.com/data/${symbol}`);
    return await fallback.json();
  }
}
```

### Budget Guard — Stop Before You Hit the Cap

```typescript
import { getRemainingBudget } from 'agentwallet-sdk';

async function checkBudgetBeforeLoop(wallet: Wallet, estimatedCostPerCall: bigint, callCount: number) {
  const remaining = await getRemainingBudget(wallet, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  const estimatedTotal = estimatedCostPerCall * BigInt(callCount);

  if (estimatedTotal > remaining) {
    const maxCalls = Number(remaining / estimatedCostPerCall);
    console.warn(`Budget allows ${maxCalls} of ${callCount} planned calls. Adjusting.`);
    return maxCalls;
  }
  return callCount;
}
```

## Non-Custodial Architecture

Your private key never leaves your infrastructure. The SDK interacts with on-chain contracts; no third party holds or validates your keys.

```
Your Infrastructure          On-Chain
─────────────────────        ────────────────────────────────────
  Agent process              AgentAccountV2 contract
  ├── private key (local)    ├── SpendingPolicy (your limits)
  ├── agentwallet-sdk        ├── Tx queue (over-limit txs)
  └── signs transactions     └── Audit log (immutable)
        │                          ▲
        └──── broadcasts ──────────┘
```

**What this means:** If you stop using AgentWallet SDK tomorrow, your wallets, keys, and on-chain limits continue to work with any Ethereum-compatible tool. No vendor lock-in.

## Token Registry

80+ verified token addresses across 11 EVM chains + Solana. No hard-coded contract addresses.

```typescript
import { getGlobalRegistry } from 'agentwallet-sdk';

const registry = getGlobalRegistry();

const usdc = registry.getToken('USDC', 8453); // Base chain ID
console.log(usdc?.address); // 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

const baseTokens = registry.listTokens(8453);
// ['USDC', 'USDT', 'DAI', 'WETH', 'WBTC', 'LINK', 'UNI', 'AAVE', ...]
```

## Multi-Token Transfers

```typescript
import { sendToken, sendNative, getTokenBalance, getBalances } from 'agentwallet-sdk';

// Send 100 USDC — no manual decimal math
const txHash = await sendToken(wallet, {
  symbol: 'USDC',
  to: '0xRecipient',
  amount: '100',  // → internally 100_000_000 (6 decimals)
});

// Check balances
const usdcBalance = await getTokenBalance(wallet, 'USDC');
console.log(usdcBalance); // "250.00"

const allBalances = await getBalances(wallet);
// [{ symbol: 'USDC', balance: '250.00', raw: 250000000n }, ...]
```

## Multi-Chain Support

```typescript
// Same API across chains — just change 'chain'
const wallet = createWallet({
  accountAddress: '0x...',
  chain: 'arbitrum',  // or 'base', 'polygon', 'optimism', etc.
  walletClient,
});
```

| Chain | x402 | Bridge | Swap |
|-------|:----:|:------:|:----:|
| Base (recommended) | ✅ | ✅ | ✅ |
| Arbitrum | ✅ | ✅ | ✅ |
| Optimism | ✅ | ✅ | ✅ |
| Polygon | ✅ | ✅ | ✅ |
| Ethereum | ✅ | ✅ | — |
| Avalanche | ✅ | ✅ | — |
| Unichain, Linea, Sonic, Worldchain | ✅ | ✅ | — |
| Base Sepolia (testnet) | ✅ | — | — |

## Uniswap V3 Swaps

```typescript
import { attachSwap } from 'agentwallet-sdk/swap';
import { BASE_TOKENS } from 'agentwallet-sdk';

const swap = attachSwap(wallet, { chain: 'base' });

const result = await swap.swap(BASE_TOKENS.USDC, BASE_TOKENS.WETH, 100_000_000n, {
  slippageBps: 50, // 0.5% slippage
});
console.log('Swap tx:', result.txHash);
```

## CCTP V2 Bridging

```typescript
import { createBridge } from 'agentwallet-sdk';

const bridge = createBridge(walletClient, 'base');

// Bridge 100 USDC Base → Arbitrum (~12 seconds)
const result = await bridge.bridge(100_000_000n, 'arbitrum', {
  minFinalityThreshold: 0, // FAST attestation
});
console.log('Completed in', result.elapsedMs, 'ms');
// Verified mainnet: Base → Arbitrum 0.50 USDC
// Burn: 0xfedbfaa4b3a9fbadd36668c50c2ee7fc7e32072e2bd409e00c46020a35329129
```

## Solana SPL Support

```bash
npm install @solana/web3.js @solana/spl-token
```

```typescript
import { SolanaWallet } from 'agentwallet-sdk/tokens/solana';

const solWallet = new SolanaWallet({
  privateKeyBase58: process.env.SOLANA_PRIVATE_KEY!,
});

const { sol } = await solWallet.getSolBalance();
const sig = await solWallet.sendSol('RecipientBase58Address', 0.1);

// USDC on Solana
const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const { amount, decimals } = await solWallet.getSplTokenBalance(usdcMint);
```

## On-Chain Identity (ERC-8004)

```typescript
import { ERC8004Client, ReputationClient } from 'agentwallet-sdk';

const identity = new ERC8004Client({ chain: 'base' });
const { txHash, agentId } = await identity.registerAgent(walletClient, {
  name: 'MyAgent',
  description: 'Autonomous research agent',
});

const reputation = new ReputationClient({ chain: 'base' });
const rep = await reputation.getAgentReputation(agentId!);
console.log(`Score: ${rep.totalScore} from ${rep.count} reviews`);
```

## Decimal Helpers

```typescript
import { toRaw, toHuman, formatBalance } from 'agentwallet-sdk';

const raw = toRaw('100.50', 6);        // → 100_500_000n
const human = toHuman(100_500_000n, 6); // → "100.5"
const display = formatBalance(100_500_000n, 6, 'USDC', 2); // → "100.50 USDC"
```

## Security Model

**What the on-chain spend policy enforces:**

Even if an agent is compromised (prompt injection, jailbreak, runaway loop), it cannot:
1. Spend more than the per-transaction limit you set
2. Exceed the daily/weekly cap you configured
3. Access funds outside its ERC-6551 token-bound account
4. Modify its own spend policy (only the owner wallet can do that)

**Recommendation:** Start with $1/tx, $10/day. Raise caps only after you've watched the agent run for a week and it behaves exactly as expected.

Key management: your private key stays in your infrastructure. Compatible with Vault, AWS Secrets Manager, Azure Key Vault, GCP Secret Manager, or local encrypted storage.

## Enterprise Deployment

The SDK runs in your infrastructure — no third-party custody, no shared key management, no data leaving your network.

```bash
# Docker deployment
docker run \
  -e WALLET_PRIVATE_KEY_FILE=/secrets/key \
  -e RPC_URL=https://mainnet.base.org \
  -v /path/to/secrets:/secrets:ro \
  agentwallet-sdk:latest
```

Stateless design — wallet state lives on-chain, not in application memory. Multiple SDK instances can safely share a wallet address. Nonce management handled.

### Key compliance properties
- All private keys generated and stored locally — no external key management service
- No telemetry, analytics, or usage data transmitted to any third party
- Every transaction on-chain with block number, timestamp, and gas cost — immutable audit log
- SpendingPolicy changes are on-chain events — tamper-proof
- NFT transfer = instant revocation of all agent permissions — no "forgot to deprovision" risk

## Links

- [GitHub](https://github.com/up2itnow0822/agent-wallet-sdk)
- [npm](https://www.npmjs.com/package/agentwallet-sdk)
- [ERC-8004 Spec](https://eips.ethereum.org/EIPS/eip-8004)
- [agentpay-mcp](https://github.com/up2itnow0822/agentpay-mcp) — MCP server wrapping this SDK

## Patent Notice

**Patent Pending** — USPTO provisional patent application filed March 2026: "Non-Custodial Multi-Chain Financial Infrastructure System for Autonomous AI Agents."

Our provisional filing is defensive — intended to prevent hostile monopolization of open payment rails and protect builders' ability to use open standards.

## Disclaimer

Non-custodial developer tooling. You control your own keys and set your own spending limits. You are responsible for compliance with applicable laws in your jurisdiction. Provided as-is under the MIT license. Nothing here constitutes financial advice, custody services, or money transmission.

## License

MIT
