# AgentWallet SDK

> **📦 CANONICAL PACKAGE:** This is the actively maintained source for the `agentwallet-sdk` npm package (v5+). The old `agentwallet-sdk` GitHub repo is deprecated — use this repo.


Non-custodial AI agent wallet with ERC-8004 on-chain identity, ERC-6551 token-bound accounts, x402 payments, mutual stake escrow, and programmable spending guardrails.

Agent Wallet gives AI agents autonomous spending power with hard on-chain limits. No more choosing between "agent can drain everything" and "every transaction needs manual approval."

> **ERC-8004 Ready:** Maps directly to [ERC-8004 (Trustless Agents)](https://eips.ethereum.org/EIPS/eip-8004) — your agent's ERC-6551 wallet NFT doubles as its on-chain identity handle, with built-in Identity Registry, Reputation Registry, and Validation Registry clients.

```
Agent wants to spend $15 → ✅ Auto-approved (under $25 limit)
Agent wants to spend $500 → ⏳ Queued for your approval
Agent spent $490 today → 🛑 Next tx queued ($500/day limit hit)
```

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
npm install agentwallet-sdk viem
```

### Create a Wallet

```typescript
import { createWallet, setSpendPolicy, agentExecute, NATIVE_TOKEN } from 'agentwallet-sdk';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const account = privateKeyToAccount('0x...');
const walletClient = createWalletClient({ account, chain: base, transport: http() });

const wallet = createWallet({
  accountAddress: '0xYourAgentWallet',
  chain: 'base',
  walletClient,
});

// Set a $25/tx, $500/day spend policy for ETH
await setSpendPolicy(wallet, {
  token: NATIVE_TOKEN,
  perTxLimit: 25000000000000000n,  // 0.025 ETH
  periodLimit: 500000000000000000n, // 0.5 ETH
  periodLength: 86400,
});

// Agent executes — auto-approved if within limits, queued if over
const result = await agentExecute(wallet, {
  to: '0xRecipient',
  value: 10000000000000000n, // 0.01 ETH
});
console.log(result.executed ? 'Sent!' : 'Queued for approval');
```

## ERC-8004 On-Chain Identity

Register your agent on the ERC-8004 Identity Registry — a portable, censorship-resistant on-chain identity using ERC-721.

```typescript
import { ERC8004Client } from 'agentwallet-sdk';

const identity = new ERC8004Client({ chain: 'base' });

// Register agent
const { txHash, agentId } = await identity.registerAgent(walletClient, {
  name: 'MyAgent',
  description: 'Autonomous trading agent',
});

// Look up any agent
const agent = await identity.lookupAgentIdentity(agentId!);
console.log(agent.owner, agent.agentURI);
```

## ERC-8004 Reputation Registry

On-chain reputation signals — scored feedback from clients, aggregated summaries, revocable.

```typescript
import { ReputationClient } from 'agentwallet-sdk';

const reputation = new ReputationClient({ chain: 'base' });

// Leave feedback for an agent
await reputation.giveFeedback(walletClient, {
  agentId: 42n,
  score: 95n,
  category: 1,
  comment: 'Fast execution, accurate results',
  taskRef: 'task-abc-123',
  verifierRef: '',
  clientRef: '',
  contentHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
});

// Read aggregated reputation
const rep = await reputation.getAgentReputation(42n);
console.log(`Score: ${rep.totalScore} from ${rep.count} reviews`);
```

## ERC-8004 Validation Registry

Request and receive on-chain validation from validator contracts (TEE attestations, capability proofs, compliance checks).

```typescript
import { ValidationClient } from 'agentwallet-sdk';
import { keccak256, toBytes } from 'viem';

const validation = new ValidationClient({
  chain: 'base',
  validationAddress: '0xYourValidationRegistry', // address required until official deployment
});

// Request validation from a validator
const requestHash = keccak256(toBytes('my-validation-request-v1'));
await validation.requestValidation(walletClient, {
  validator: '0xValidatorContract',
  agentId: 42n,
  requestURI: 'https://example.com/validation-spec.json',
  requestHash,
});

// Check validation status
const status = await validation.getValidationStatus(requestHash);
console.log(status.responded ? `Result: ${status.response}` : 'Pending');

// Get summary for an agent
const summary = await validation.getSummary(42n);
console.log(`${summary.passCount} passed, ${summary.failCount} failed`);
```

## Mutual Stake Escrow

Reciprocal collateral for agent-to-agent task settlement. Both parties stake, both lose if the task fails.

```typescript
import { MutualStakeEscrow } from 'agentwallet-sdk';

const escrow = new MutualStakeEscrow({
  chain: 'base',
  walletClient,
});

// Create escrow — both agent and client stake
const { escrowId, txHash } = await escrow.create({
  counterparty: '0xOtherAgent',
  token: '0xUSDC',
  stakeAmount: 100000000n, // 100 USDC
  taskHash: '0x...',
  deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
});

// Counterparty funds their side
await escrow.fund(escrowId);

// After task completion, fulfill
await escrow.fulfill(escrowId, proofHash);

// Verify and release stakes
await escrow.verify(escrowId);
```

## Feature Tiers

### Base (Free)

| Feature | Description |
|---------|-------------|
| Agent Identity | ERC-8004 Identity Registry — on-chain ERC-721 agent IDs |
| Agent Reputation | ERC-8004 Reputation Registry — scored feedback and summaries |
| Agent Validation | ERC-8004 Validation Registry — validator request/response |
| ERC-6551 TBA | NFT-bound wallets with autonomous spending |
| Mutual Stake Escrow | Reciprocal collateral task settlement |
| Optimistic Escrow | Time-locked optimistic verification |
| x402 Payments | HTTP 402 auto-pay for agent-to-service payments |
| CCTP Bridge | Circle CCTP V2 across 17 chains + Solana |
| Spend Policies | Per-token, per-period on-chain spending limits |
| Swap | Uniswap V3 on Base/Arbitrum/Optimism |
| Fiat Onramp | Opt-in fiat-to-crypto |
| AP2 Protocol | Agent-to-Agent task delegation and payment |
| Settlement | On-chain settlement finalization |
| Gas Sponsorship | ERC-4337 paymaster-based gas sponsorship |
| Solana Support | Cross-chain Solana bridging via CCTP |

### Premium

| Feature | Description |
|---------|-------------|
| CowSwap Solver | Batch auction solutions, earn COW tokens |
| Flash Executor | Atomic flash loan execution |
| MEV Protection | Private mempool via Flashbots/MEV Blocker |
| Yield Staking | Aave V3, Compound V3, Morpho Blue strategies |
| Tax Reporting | Cost basis and gain/loss reporting |

Premium access: [github.com/up2itnow/AgentNexus2](https://github.com/up2itnow/AgentNexus2)

## Atomic Settlement — Verified On-Chain

Live x402 settlement endpoint on Base Sepolia with on-chain attestation verification:

```
https://dexter-settlement-test-production.up.railway.app
```

| Proof | Transaction |
|---|---|
| USDC Payment | [`0xbba6c34a...`](https://sepolia.basescan.org/tx/0xbba6c34ad6b11cc4e511317ca38553df903dcbe989ee47e45b5c48f3af7e4334) |
| Fee Routing (0.77%) | [`0x9a5e450c...`](https://sepolia.basescan.org/tx/0x9a5e450c1080a2478ea22792b6ab034974d8f99072808f83354c98451441733a) |

See [`examples/settlement-test/`](examples/settlement-test/) for the full settlement server, self-test script, and integration guide.

## Supported Chains

Mainnet: Ethereum, Base, Arbitrum, Polygon, Optimism, Avalanche, BSC, Celo, Gnosis, Linea, Mantle, Scroll, and more.

Testnet: Base Sepolia, Arbitrum Sepolia, and corresponding testnets.

## Links

- [ERC-8004 Spec](https://eips.ethereum.org/EIPS/eip-8004)
- [GitHub](https://github.com/agentnexus/agent-wallet-sdk)
- [npm](https://www.npmjs.com/package/agentwallet-sdk)


## Why agent-wallet-sdk vs. Polygon Agent CLI

| Feature | agent-wallet-sdk | Polygon Agent CLI |
|---|---|---|
| Wallet model | Non-custodial, agent holds keys | CLI-based, operator-managed |
| x402 support | Native, automatic negotiation | Not supported |
| Spend limits | Programmable (daily, per-tx, per-agent) | Manual configuration |
| Multi-chain | Ethereum, Base, Etherlink, Polygon, 10+ chains | Polygon-only |
| Integration | npm package, works in any JS/TS runtime | CLI tool, requires shell access |
| Agent frameworks | Any (LangChain, CrewAI, Cursor, NemoClaw) | Polygon ecosystem only |
| Audit trail | Built-in transaction logging | External tooling required |
| Use case | Autonomous agent payments at scale | Polygon-specific agent ops |

agent-wallet-sdk is chain-agnostic, framework-agnostic, and built for autonomous agents that need to pay for things without human approval. Polygon Agent CLI is a solid tool if you are all-in on Polygon infrastructure - but if your agents need to operate across chains or use x402 payment headers, agent-wallet-sdk is the better fit.

## Exchange Integrations

Agent Wallet SDK is compatible with exchange-native AI agent trading protocols. These integrations let your trading agent manage its own wallet, execute position sizing within on-chain spend limits, and settle proceeds without a custodial intermediary.

### HTX AI Skills Protocol

HTX (one of the world's largest crypto exchanges) launched the AI Skills Protocol for agent-native trading in March 2026. Agent Wallet SDK is listed as compatible in their official documentation alongside Claude Code and Cursor.

**What the integration enables:**
- Natural language trading commands from your agent
- Position monitoring and P&L queries via agent runtime
- On-chain spend limits enforce position sizing independent of exchange controls
- Non-custodial settlement - agent holds its own keys, no exchange custody of proceeds

**Setup:**

```typescript
import { createWallet, setSpendPolicy } from 'agentwallet-sdk';

// Set trading spend limits before connecting to HTX
const agentWallet = createWallet({
  accountAddress: '0xYOUR_AGENT_ACCOUNT',
  chain: 'base',
  walletClient,
});

// Hard limits at the wallet layer - independent of exchange risk controls
await setSpendPolicy(agentWallet, {
  token: NATIVE_TOKEN,
  perTxLimit: 100_000000000000000n,    // 0.1 ETH max per trade
  periodLimit: 1_000_000000000000000n, // 1.0 ETH max per day
  periodLength: 86400,
});
```

From OpenClaw terminal: `openclaw skills install htx-trading` and configure your HTX API credentials. The agent wallet handles settlement; HTX AI Skills handles order execution.

**More integrations:** OKX, Bybit, and Binance exchange AI SDKs are expected Q2 2026. This section will be updated as compatible protocols launch.

---

## License

MIT
