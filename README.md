# AgentWallet SDK

> **⭐ Star us during GTC Week (Mar 15-20) — NVIDIA's NemoClaw launches Monday with no payment primitive. agent-wallet-sdk is the open-source answer. Help us reach record stars during the biggest AI week of 2026.**

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

The `chain` parameter selects which network the wallet operates on. Supported values:
`'base'` | `'ethereum'` | `'arbitrum'` | `'polygon'` | `'optimism'` | `'avalanche'` |
`'unichain'` | `'linea'` | `'sonic'` | `'worldchain'` | `'base-sepolia'`

```typescript
import { createWallet, setSpendPolicy, agentExecute, NATIVE_TOKEN } from 'agentwallet-sdk';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const account = privateKeyToAccount('0x...');
const walletClient = createWalletClient({ account, chain: base, transport: http() });

const wallet = createWallet({
  accountAddress: '0xYourAgentWallet',
  chain: 'base',  // or 'arbitrum', 'polygon', 'optimism', etc.
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

## Multi-Chain x402 Payments

Pay any x402-gated API from any supported chain. The client automatically selects
the correct USDC address for the network the server requests.

```typescript
import { createWallet, createX402Client } from 'agentwallet-sdk';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({ account, chain: arbitrum, transport: http() });

// Wallet on Arbitrum — pays with Arbitrum USDC
const wallet = createWallet({
  accountAddress: '0xYourAgentWallet',
  chain: 'arbitrum',
  walletClient,
});

const x402 = createX402Client(wallet, {
  // Accept payment requests on any supported mainnet chain
  supportedNetworks: ['arbitrum:42161', 'base:8453', 'optimism:10', 'polygon:137'],
  globalDailyLimit: 10_000_000n, // 10 USDC/day cap
  globalPerRequestMax: 1_000_000n, // 1 USDC max per request
});

// Automatically pays 402 responses with the chain's native USDC
const response = await x402.fetch('https://api.example.com/premium-data');
const data = await response.json();
```

## Multi-Chain Swaps (Uniswap V3)

Swap tokens on Base, Arbitrum, Optimism, or Polygon using the best Uniswap V3 pool.

```typescript
import { createWallet } from 'agentwallet-sdk';
import { attachSwap } from 'agentwallet-sdk/swap';
import { BASE_TOKENS, ARBITRUM_TOKENS } from 'agentwallet-sdk';

// Swap on Base
const baseWallet = createWallet({ accountAddress: '0x...', chain: 'base', walletClient });
const baseSwap = attachSwap(baseWallet, { chain: 'base' });

const result = await baseSwap.swap(BASE_TOKENS.WETH, BASE_TOKENS.USDC, 1_000_000_000_000_000n, {
  slippageBps: 50, // 0.5% slippage
});
console.log('Swap tx:', result.txHash);

// Swap on Arbitrum
const arbWallet = createWallet({ accountAddress: '0x...', chain: 'arbitrum', walletClient });
const arbSwap = attachSwap(arbWallet, { chain: 'arbitrum' });

const arbResult = await arbSwap.swap(ARBITRUM_TOKENS.USDC, ARBITRUM_TOKENS.WETH, 5_000_000n, {
  slippageBps: 30,
});
console.log('Arbitrum swap tx:', arbResult.txHash);
```

## CCTP V2 Bridge — EVM to EVM

Bridge USDC between any of the 10 supported EVM chains using Circle's CCTP V2.

```typescript
import { createBridge } from 'agentwallet-sdk';
import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';

const walletClient = createWalletClient({
  account: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`),
  chain: base,
  transport: http(),
});

const bridge = createBridge(walletClient, 'base');

// Bridge 100 USDC from Base to Arbitrum (~12 seconds with FAST finality)
const result = await bridge.bridge(100_000_000n, 'arbitrum', {
  minFinalityThreshold: 0, // FAST attestation
});
console.log('Burn tx:', result.burnTxHash);
console.log('Mint tx:', result.mintTxHash);
console.log(`Completed in ${result.elapsedMs}ms`);
```

## CCTP V2 Bridge — EVM to Solana

Bridge USDC from any EVM chain to Solana using CCTP V2 domain 5.
The EVM burn side is handled automatically; the Solana receive is returned
as `messageBytes` + `attestation` for submission to Solana's CCTP program.

```typescript
import { bridgeEVMToSolana } from 'agentwallet-sdk';
import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';

const walletClient = createWalletClient({
  account: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`),
  chain: base,
  transport: http(),
});

// Bridge 50 USDC from Base to Solana
const result = await bridgeEVMToSolana(walletClient, 50_000_000n, {
  fromChain: 'base',
  solanaRecipient: 'YourSolanaWalletAddressInBase58',
  minFinalityThreshold: 0, // FAST (~12s)
});

console.log('EVM burn tx:', result.burnTxHash);
console.log('Attestation ready — submit to Solana TokenMessengerMinterV2');
console.log('Message bytes:', result.messageBytes);
console.log('Attestation:', result.attestation);
// Submit result.messageBytes + result.attestation to the Solana CCTP V2 program:
// CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC (MessageTransmitterV2)
```

## CCTP V2 Bridge — Solana to EVM

Receive USDC on an EVM chain from a Solana burn transaction.

```typescript
import { receiveFromSolanaOnEVM } from 'agentwallet-sdk';

// After initiating a burn on Solana, receive on EVM:
const result = await receiveFromSolanaOnEVM(walletClient, {
  messageBytes: '0x...', // from Solana burn transaction
  messageHash: '0x...',  // keccak256 of messageBytes
  sourceDomain: 5,       // Solana CCTP domain
}, {
  toChain: 'arbitrum',
  evmRecipient: '0xYourEVMAddress',
});

console.log('Mint tx:', result.mintTxHash);
console.log('Received:', result.amount, 'USDC base units on', result.toChain);
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

| Feature | Status | Description |
|---------|--------|-------------|
| Agent Identity | ✅ Live | ERC-8004 Identity Registry — on-chain ERC-721 agent IDs |
| Agent Reputation | ✅ Live | ERC-8004 Reputation Registry — scored feedback and summaries |
| Agent Validation | ✅ Live | ERC-8004 Validation Registry — validator request/response |
| ERC-6551 TBA | ✅ Live | NFT-bound wallets with autonomous spending |
| Mutual Stake Escrow | ✅ Live | Reciprocal collateral task settlement |
| Optimistic Escrow | ✅ Live | Time-locked optimistic verification |
| x402 Payments | ✅ Live | HTTP 402 auto-pay — Base, Ethereum, Arbitrum, Polygon, Optimism, Avalanche, Unichain, Linea, Sonic, Worldchain |
| CCTP Bridge (EVM) | ✅ Live | Circle CCTP V2 across 10 EVM chains |
| CCTP Bridge (Solana) | ✅ Live | EVM↔Solana USDC bridging via CCTP V2 domain 5 |
| Spend Policies | ✅ Live | Per-token, per-period on-chain spending limits |
| Swap | ✅ Live | Uniswap V3 on Base, Arbitrum, Optimism, Polygon |
| Fiat Onramp | ✅ Live | Opt-in fiat-to-crypto |
| AP2 Protocol | ✅ Live | Agent-to-Agent task delegation and payment |
| Settlement | ✅ Live | On-chain settlement finalization |
| Gas Sponsorship | ✅ Live | ERC-4337 paymaster-based gas sponsorship |

### Premium

| Feature | Description |
|---------|-------------|
| CowSwap Solver | Batch auction solutions, earn COW tokens |
| Flash Executor | Atomic flash loan execution |
| MEV Protection | Private mempool via Flashbots/MEV Blocker |
| Yield Staking | Aave V3, Compound V3, Morpho Blue strategies |
| Tax Reporting | Cost basis and gain/loss reporting |

Premium access: [github.com/up2itnow/AgentNexus2](https://github.com/up2itnow/AgentNexus2)

## x402 Protocol: Supported Chains and Payment Rails

x402 (HTTP 402 Payment Required) is the native payment protocol for agent-to-service transactions. The agent encounters a 402 response, signs a payment proof, and re-sends the request. One round trip. No accounts, no API keys, no invoices.

As of March 2026, x402 is live on 3 chains/rails:

| Chain / Rail | Status | Settlement Token | Gas Cost | Notes |
|---|---|---|---|---|
| **Base** (Coinbase L2) | Live | USDC | Sub-cent | Primary x402 chain. 15M+ transactions in Jan 2026. |
| **Etherlink** (Tezos L2) | Live (Mar 2026) | USDC | Sub-cent | EVM-compatible. Same x402 integration, different RPC + chain ID. |
| **Stripe** (Fiat offramp) | Live (Feb 2026) | USDC -> USD | N/A | Vendors receive USD in Stripe dashboard. Agents pay USDC. |

### x402 + Etherlink Quick Start

```typescript
import { createWallet, agentExecute } from 'agentwallet-sdk';

const wallet = createWallet({
  accountAddress: '0xYourAgent',
  chain: 'etherlink',  // new: Tezos L2 support
  walletClient,
});

// x402 payment flow is identical across chains
const response = await fetch('https://api.vendor.com/data');
if (response.status === 402) {
  const details = await response.json();
  const proof = await wallet.createX402Proof(details);
  const paid = await fetch('https://api.vendor.com/data', {
    headers: { 'X-Payment': proof }
  });
}
```

The SDK handles chain-specific RPC endpoints, gas estimation, and USDC contract addresses automatically. Swap `chain: 'base'` to `chain: 'etherlink'` and the x402 flow works identically.

## Cross-Chain Bridge — Verified on Mainnet

Live CCTP V2 bridge transfers verified on mainnet (March 15, 2026):

| Route | Amount | Burn Tx (Base) | Status |
|-------|--------|---------------|--------|
| Base → Arbitrum | 0.50 USDC | [`0xfedb...9129`](https://basescan.org/tx/0xfedbfaa4b3a9fbadd36668c50c2ee7fc7e32072e2bd409e00c46020a35329129) | ✅ Confirmed — [0.50 USDC received on Arbitrum](https://arbiscan.io/address/0xff86829393C6C26A4EC122bE0Cc3E466Ef876AdD) |

Bridge uses Circle CCTP V2 `depositForBurn` with fast finality (minFinalityThreshold=0). USDC is burned on the source chain and minted natively on the destination — no wrapped tokens, no liquidity pools.

```typescript
import { CctpBridgeClient } from 'agentwallet-sdk';

const bridge = new CctpBridgeClient({
  sourceChain: 'base',
  walletClient,
});

// Bridge USDC from Base to Arbitrum
const { txHash } = await bridge.bridge({
  destinationChain: 'arbitrum',
  recipient: '0xff86829393C6C26A4EC122bE0Cc3E466Ef876AdD',
  amount: 500000n, // 0.50 USDC
});
```

## Supported Chains

### x402 Payments & Swap (USDC)
| Chain | Network ID | x402 | Bridge | Swap |
|-------|-----------|------|--------|------|
| Base | 8453 | ✅ | ✅ | ✅ |
| Ethereum | 1 | ✅ | ✅ | — |
| Arbitrum | 42161 | ✅ | ✅ | ✅ |
| Polygon | 137 | ✅ | ✅ | ✅ |
| Optimism | 10 | ✅ | ✅ | ✅ |
| Avalanche | 43114 | ✅ | ✅ | — |
| Unichain | 130 | ✅ | ✅ | — |
| Linea | 59144 | ✅ | ✅ | — |
| Sonic | 146 | ✅ | ✅ | — |
| World Chain | 480 | ✅ | ✅ | — |
| Solana | — | — | ✅ (CCTP) | — |
| Base Sepolia | 84532 | ✅ (testnet) | — | — |

All USDC addresses are native Circle USDC (not bridged variants).

## Complete Agent Identity Stack (v5.1.0)

One npm install now gives any AI agent a wallet, email address, on-chain ID, reputation, and signed payment intents.

| Component | What It Does |
|-----------|-------------|
| **EmailResolver** *(NEW)* | AgentMail integration — agents get `email@agentmail.to` linked to wallet. Resolve email→wallet, send/receive with embedded x402 payment requests. |
| **AgentIdentity** | ERC-8004 + ERC-6551: on-chain NFT identity + Token Bound Account |
| **ReputationClient** | On-chain reputation scoring — give/read feedback, aggregate scores |
| **VerifiableIntentClient** | Mastercard-spec signed payment intents with scope enforcement |
| **ValidationClient** | Request/respond validation workflow (TEE attestations, compliance) |

### EmailResolver Quick Start

```typescript
import { EmailResolver } from 'agentwallet-sdk';

const resolver = new EmailResolver();

// Resolve an agent email to its wallet address
const wallet = await resolver.resolveEmail('myagent@agentmail.to');
console.log(wallet.address); // 0x...

// Send a payment request embedded in an email
await resolver.sendWithPayment({
  to: 'vendor@agentmail.to',
  subject: 'Payment for API access',
  amount: 5_000_000n, // 5 USDC
  token: 'USDC',
  chain: 'base',
});
```

## Links

- [ERC-8004 Spec](https://eips.ethereum.org/EIPS/eip-8004)
- [GitHub](https://github.com/up2itnow0822/agent-wallet-sdk)
- [npm](https://www.npmjs.com/package/agentwallet-sdk)

## License

MIT

