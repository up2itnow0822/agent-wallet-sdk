# 🤖 Agent Wallet SDK

**Let your AI agent spend crypto. Stay in control.**

Agent Wallet gives AI agents autonomous spending power with hard on-chain limits. No more choosing between "agent can drain everything" and "every transaction needs manual approval."

```text
Agent wants to spend $15 → ✅ Auto-approved (under $25 limit)
Agent wants to spend $500 → ⏳ Queued for your approval
Agent spent $490 today → 🛑 Next tx queued ($500/day limit hit)
```text

## Why Agent Wallet?

| Approach | Problem |
|----------|---------|
| Raw EOA wallet | Agent can drain everything. One prompt injection = rugged. |
| Multisig (Safe) | Every tx needs human sigs. Kills agent autonomy. |
| Custodial API (Stripe) | Centralized, KYC friction, not crypto-native. |
| **Agent Wallet** | **Agents spend freely within limits. Everything else queues for approval.** |

Built on **ERC-6551** (token-bound accounts). Your agent's wallet is tied to an NFT — portable, auditable, fully on-chain.

## Quick Start

```bash
npm install @agentwallet/sdk viem
```text

```typescript
import {
  createWallet,
  setSpendPolicy,
  agentExecute,
  checkBudget,
  getPendingApprovals,
  approveTransaction,
  NATIVE_TOKEN,
} from '@agentwallet/sdk';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// 1. Connect to your agent's wallet
const walletClient = createWalletClient({
  account: privateKeyToAccount('0xAGENT_PRIVATE_KEY'),
  transport: http('https://mainnet.base.org'),
});

const wallet = createWallet({
  accountAddress: '0xYOUR_AGENT_ACCOUNT',
  chain: 'base',
  walletClient,
});

// 2. Owner sets spending limits (one-time setup)
await setSpendPolicy(wallet, {
  token: NATIVE_TOKEN,  // ETH
  perTxLimit: 25_000000000000000n,   // 0.025 ETH per tx
  periodLimit: 500_000000000000000n, // 0.5 ETH per day
  periodLength: 86400,               // 24 hours
});

// 3. Agent spends autonomously
await agentExecute(wallet, {
  to: '0xSOME_SERVICE',
  value: 10_000000000000000n, // 0.01 ETH — under limit, executes immediately
});

// 4. Check remaining budget
const budget = await checkBudget(wallet, NATIVE_TOKEN);
console.log(`Remaining today: ${budget.remainingInPeriod}`);

// 5. Owner reviews queued transactions
const pending = await getPendingApprovals(wallet);
for (const tx of pending) {
  console.log(`Pending #${tx.txId}: ${tx.amount} to ${tx.to}`);
  await approveTransaction(wallet, tx.txId);
}
```text

## API Reference

### `createWallet(config)`

Connect to an existing AgentAccountV2 contract.

| Param | Type | Description |
|-------|------|-------------|
| `accountAddress` | `Address` | Deployed AgentAccountV2 address |
| `chain` | `string` | `'base'` \| `'base-sepolia'` \| `'ethereum'` \| `'arbitrum'` \| `'polygon'` |
| `walletClient` | `WalletClient` | viem wallet client (agent or owner key) |
| `rpcUrl?` | `string` | Custom RPC URL |

### `setSpendPolicy(wallet, policy)` — Owner only

Set per-token spending limits.

| Field | Type | Description |
|-------|------|-------------|
| `token` | `Address` | Token address (`NATIVE_TOKEN` for ETH) |
| `perTxLimit` | `bigint` | Max single tx (0 = all txs need approval) |
| `periodLimit` | `bigint` | Max per rolling window (0 = no autonomous spending) |
| `periodLength` | `number` | Window in seconds (default: 86400 = 24h) |

### `agentExecute(wallet, { to, value?, data? })`

Execute a native ETH transaction. Auto-approves if within limits, queues if over.

**Returns:** `{ executed: boolean, txHash: Hash, pendingTxId?: bigint }`

### `agentTransferToken(wallet, { token, to, amount })`

Transfer ERC20 tokens, respecting spend limits.

### `checkBudget(wallet, token?)`

Check remaining autonomous spending budget.

**Returns:** `{ token, perTxLimit, remainingInPeriod }`

### `getPendingApprovals(wallet, fromId?, toId?)`

List all pending (unexecuted, uncancelled) transactions awaiting owner approval.

### `approveTransaction(wallet, txId)` — Owner only

Approve and execute a queued transaction.

### `cancelTransaction(wallet, txId)` — Owner only

Cancel a queued transaction.

### `setOperator(wallet, operator, authorized)` — Owner only

Add or remove an agent operator address.

### `getBudgetForecast(wallet, token?, now?)`

**[MAX-ADDED]** Time-aware budget forecast — know not just what's left, but when it refills.

**Returns:** `BudgetForecast` — includes `remainingInPeriod`, `secondsUntilReset`, `utilizationPercent`, full period metadata.

```typescript
const forecast = await getBudgetForecast(wallet, NATIVE_TOKEN);
console.log(`${forecast.utilizationPercent}% used, resets in ${forecast.secondsUntilReset}s`);
```text

### `getWalletHealth(wallet, operators?, tokens?, now?)`

**[MAX-ADDED]** Single-call diagnostic snapshot for agent self-monitoring.

**Returns:** `WalletHealth` — address, NFT binding, operator epoch, active operator statuses, pending queue depth, budget forecasts.

```typescript
const health = await getWalletHealth(wallet, [agentHotWallet], [NATIVE_TOKEN, usdcAddress]);
if (health.pendingQueueDepth > 5) console.warn('Queue backing up!');
if (!health.activeOperators[0].active) console.error('Agent operator deactivated!');
```text

### `batchAgentTransfer(wallet, transfers)`

**[MAX-ADDED]** Execute multiple token transfers sequentially — reduces boilerplate for multi-recipient payments.

```typescript
const hashes = await batchAgentTransfer(wallet, [
  { token: USDC, to: serviceA, amount: 100n },
  { token: USDC, to: serviceB, amount: 200n },
]);
```text

### `getActivityHistory(wallet, { fromBlock?, toBlock? })`

**[MAX-ADDED]** Query on-chain event history for self-auditing — no external indexer needed.

**Returns:** `ActivityEntry[]` — sorted by block number, covers executions, queued txs, approvals, cancellations, policy updates, operator changes.

```typescript
const history = await getActivityHistory(wallet, { fromBlock: 10000n });
for (const entry of history) {
  console.log(`[${entry.type}] block ${entry.blockNumber}: ${JSON.stringify(entry.args)}`);
}
```text

## Supported Chains

| Chain | Status | Best For |
|-------|--------|----------|
| **Base** | ✅ Primary | Low gas, USDC native |
| **Base Sepolia** | ✅ Testnet | Development |
| **Ethereum** | ✅ | High-value operations |
| **Arbitrum** | ✅ | DeFi agents |
| **Polygon** | ✅ | Micropayments |

## x402 Protocol Support

Agent Wallet natively supports the [x402 protocol](https://x402.org) — the open standard for HTTP 402 machine payments. Your agent can automatically pay any x402-enabled API (Stripe, Coinbase, etc.) using USDC on Base, while respecting on-chain spend limits.

### Quick Start

```typescript
import { createWallet, createX402Client } from 'agentwallet-sdk';

// 1. Create your wallet
const wallet = createWallet({ accountAddress, chain: 'base', walletClient });

// 2. Create an x402-aware client
const client = createX402Client(wallet, {
  globalDailyLimit: 50_000_000n,  // 50 USDC/day
  globalPerRequestMax: 5_000_000n, // 5 USDC max per request
  serviceBudgets: [
    { service: 'api.weather.com', maxPerRequest: 1_000_000n, dailyLimit: 10_000_000n },
  ],
});

// 3. Use it like fetch — 402 responses are handled automatically
const response = await client.fetch('https://api.weather.com/forecast');
const data = await response.json();
// If the API returned 402, the client:
//   - Parsed payment requirements from the PAYMENT-REQUIRED header
//   - Checked your budget (client-side + on-chain)
//   - Paid USDC via your AgentWallet contract
//   - Retried the request with payment proof
```text

### Drop-in Fetch Replacement

```typescript
import { createX402Fetch } from 'agentwallet-sdk';

const x402Fetch = createX402Fetch(wallet, { globalDailyLimit: 100_000_000n });

// Use exactly like fetch()
const res = await x402Fetch('https://any-x402-api.com/endpoint');
```text

### Budget Controls

```typescript
// Check spending
const summary = client.getDailySpendSummary();
console.log(`Today's spend: ${summary.global} (resets at ${summary.resetsAt})`);

// View transaction log
const logs = client.getTransactionLog({ service: 'api.weather.com' });

// Add budget at runtime
client.budgetTracker.setServiceBudget({
  service: 'new-api.com',
  maxPerRequest: 2_000_000n,
  dailyLimit: 20_000_000n,
});
```text

### Payment Approval Callback

```typescript
const client = createX402Client(wallet, {
  onBeforePayment: async (req, url) => {
    console.log(`About to pay ${req.amount} to ${req.payTo} for ${url}`);
    return true; // return false to reject
  },
  onPaymentComplete: (log) => {
    console.log(`Paid ${log.amount} via tx ${log.txHash}`);
  },
});
```text

### How x402 Works

```text
Agent → GET /api/data → Server returns 402 + PAYMENT-REQUIRED header
  ↓
Client parses payment requirements (amount, token, recipient, network)
  ↓
Budget check (client-side caps + on-chain spend limits)
  ↓
AgentWallet executes USDC transfer on Base
  ↓
Client retries request with X-PAYMENT header (payment proof)
  ↓
Server verifies payment → returns 200 + data
```text

Your agent's keys never leave the non-custodial wallet. All payments respect on-chain spend limits set by the wallet owner.

## Why Non-Custodial Beats Exchange Wallets

OKX OnchainOS supports 60+ chains. Coinbase Agentic Wallets are backed by a trillion-dollar exchange. Both look impressive on paper. Here's the problem: **they hold your agent's keys.**

That's not a minor implementation detail. It's the entire trust model.

### What custody actually means

When you use an exchange-based agent wallet, your agent's private key lives on their servers. Every transaction your agent signs goes through their infrastructure. They can:
- Freeze your agent's wallet for any reason (KYC, compliance, a bad week)
- Be subpoenaed for your agent's transaction history
- Get hacked — and your agent's keys go with it
- Change their API, deprecate their SDK, sunset the product

This isn't theoretical. Exchange platforms shut down products, freeze accounts, and go dark. It's happened before. It'll happen again.

### The non-custodial difference

With `agentwallet-sdk`:
- Your agent's private key is generated locally and **never transmitted anywhere**
- The wallet contract lives on-chain — no server to shut down
- Spend limits are enforced by EVM bytecode, not an API policy
- You can self-host, self-audit, and self-custody everything

```typescript
// Your keys stay in your environment
const wallet = createWallet({
  accountAddress: '0xYOUR_CONTRACT',
  walletClient: createWalletClient({
    account: privateKeyToAccount(process.env.AGENT_KEY), // lives here, not on OKX
    transport: http('https://mainnet.base.org'),
  }),
  chain: 'base',
});
```

The spend limits (`$25/tx`, `$500/day`) are enforced by the contract itself — not by an exchange API that can change its terms. An agent running over-limit? The contract queues it. No custodian involved.

### When exchange wallets make sense

If you're building a quick demo, need zero infrastructure setup, or are already deep in the Coinbase or OKX ecosystem — their hosted products are fast to integrate. No judgment.

But if you're building production agents that handle real funds, run autonomously, or need to survive beyond a single platform's product lifecycle, you want the keys under your own control.

That's what this SDK is for.

### x402 without custody

The x402 protocol is becoming the standard for AI agent payments. Stripe validated it in February 2026. Coinbase built it into Base. Abstract launched their delegated facilitator model this week.

Every x402 implementation in `agentwallet-sdk` is non-custodial by design:
- Solana x402: direct signing from your local keypair
- Base x402: USDC transfer via your on-chain contract
- Abstract x402: EIP-712 delegated permit, signed locally — the facilitator executes it, but your key authorizes it

OKX OnchainOS supports x402 too — through their custody layer. Your call which model you trust.

---

## How It Works

1. **Deploy** an AgentAccountV2 (ERC-6551 token-bound account tied to an NFT)
2. **Configure** spend policies per token — set per-tx and daily limits
3. **Register** your agent's hot wallet as an operator
4. **Agent operates autonomously** — transactions within limits execute instantly
5. **Over-limit transactions queue** — owner gets notified, approves or cancels

All limits enforced on-chain. No off-chain dependencies. Fully auditable.

## License

MIT
