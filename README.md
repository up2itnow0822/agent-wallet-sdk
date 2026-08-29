# AgentWallet SDK

[![npm](https://img.shields.io/npm/v/agentwallet-sdk?style=flat-square)](https://www.npmjs.com/package/agentwallet-sdk)
[![CI](https://github.com/up2itnow0822/agent-wallet-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/up2itnow0822/agent-wallet-sdk/actions/workflows/ci.yml)

AgentWallet SDK is a TypeScript library for policy-aware agent payments. It
accepts a caller-supplied viem `WalletClient`; it does not store keys or provide
a custodial service.

The current npm package is `agentwallet-sdk` v6.2.1.

## What ships

| Area | Public surface | Source |
| --- | --- | --- |
| Smart-wallet client | `createWallet`, policy writes, budget reads | [`src/index.ts`](src/index.ts) |
| x402 | Client, middleware, budget tracking, multi-asset helpers | [`src/x402/`](src/x402/) |
| Local policy | `SpendingPolicy`, `UptoBillingPolicy` | [`src/policy/`](src/policy/) |
| Tokens | Registry, decimals, transfers, optional Solana helpers | [`src/tokens/`](src/tokens/) |
| Receipts | Portable provider-receipt normalization | [`src/receipts/`](src/receipts/) |
| Identity | ERC-8004, reputation, validation, and UAID clients | [`src/identity/`](src/identity/) |
| Payment modules | Bridge, swap, router, and mutual-stake escrow | [`src/`](src/) |

These are exported code surfaces. Their presence does not claim an official
deployment, production use, regulatory status, or support for every network.

## Install

```bash
npm install agentwallet-sdk viem
```

Solana helpers use an optional peer dependency:

```bash
npm install @solana/web3.js
```

## Connect to an existing smart wallet

The SDK requires an existing or predicted `AgentAccountV2` address and a viem
wallet client. Start on a test network or a deployment you control.

```typescript
import {
  NATIVE_TOKEN,
  checkBudget,
  createWallet,
} from "agentwallet-sdk";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const privateKey = process.env.AGENT_PRIVATE_KEY;
const accountAddress = process.env.AGENT_WALLET_ADDRESS;

if (!privateKey || !accountAddress) {
  throw new Error("Set AGENT_PRIVATE_KEY and AGENT_WALLET_ADDRESS");
}

const account = privateKeyToAccount(privateKey as `0x${string}`);
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(),
});

const wallet = createWallet({
  accountAddress: accountAddress as `0x${string}`,
  chain: "base-sepolia",
  walletClient,
});

const budget = await checkBudget(wallet, NATIVE_TOKEN);
console.log({
  perTxLimit: budget.perTxLimit.toString(),
  remainingInPeriod: budget.remainingInPeriod.toString(),
});
```

This example reads policy state. Functions such as `setSpendPolicy()`,
`agentExecute()`, bridge, swap, and escrow methods can submit transactions and
consume gas.

## Contract and network boundaries

- The package ships `AgentAccountV2Abi` and `AgentAccountFactoryV2Abi`.
- The repository does not ship Solidity sources or an official deployment
  manifest.
- `deployWallet()` requires a factory address, token contract, token ID, RPC,
  and caller-controlled wallet client.
- `createWallet()` currently maps Base, Base Sepolia, Ethereum, Arbitrum, and
  Polygon runtime clients in [`src/index.ts`](src/index.ts).
- Spending policy only governs transactions routed through the matching smart
  wallet contract. It cannot protect funds held outside that boundary.
- Network support differs by module. Read the module source and tests before
  moving funds.

## Verify a clean checkout

```bash
npm ci
npm run build
npm test
npm run lint
```

The test suite covers the core SDK plus x402, policy, receipt, token, identity,
and bridge behavior. Tests are not evidence that a third-party deployment or
external payment endpoint is available.

## Related repositories

- [AgentPay MCP](https://github.com/up2itnow0822/agentpay-mcp) exposes payment
  tools through MCP.
- [AgentPay Wallet Starter](https://github.com/up2itnow0822/agentpay-wallet-starter)
  provides a no-funds combined verification path.

## Security and contributions

- Report vulnerabilities through the process in
  [`SECURITY.md`](SECURITY.md).
- Contribution setup and review rules live in
  [`CONTRIBUTING.md`](CONTRIBUTING.md).
- Public issues are tracked in the
  [GitHub issue queue](https://github.com/up2itnow0822/agent-wallet-sdk/issues).

## License

MIT. See [`LICENSE`](LICENSE).
