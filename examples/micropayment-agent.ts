/**
 * Micropayment Agent Example — Agent-to-Agent API Payments
 *
 * Demonstrates an agent paying other agents for API calls:
 *   - $5/tx limit, $50/day budget (must already be installed on-chain by the owner)
 *   - Pay-per-call for AI inference, data feeds, compute
 *   - Queued (over-limit) payments are reported as NOT paid
 *
 * Safety: runs on Base Sepolia by default. Base mainnet requires
 * AGENT_EXAMPLE_NETWORK=base and AGENT_EXAMPLE_LIVE_ACK (see _example-safety.ts).
 * Nothing runs on import; execute this file directly to run it.
 *
 * Env: AGENT_PRIVATE_KEY, AGENT_WALLET, RPC_URL (optional),
 *      AGENT_EXAMPLE_PAYEES (optional JSON {serviceId: address}),
 *      deployment identity: AGENT_WALLET_CODE_HASH, or AGENT_WALLET_FACTORY +
 *      AGENT_WALLET_TOKEN_CONTRACT + AGENT_WALLET_TOKEN_ID (required).
 */

import { createWalletClient, http, parseUnits, isAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createWallet,
  agentTransferToken,
  checkBudget,
  onTransactionQueued,
  type AgentWalletHandle,
} from '../src/index.js';
import {
  assertInstalledSpendPolicy,
  isDirectRun,
  requireEnv,
  resolveExampleNetwork,
  exampleDeploymentIdentity,
} from './_example-safety.js';

export const LIMITS = {
  perTx: parseUnits('5', 6),    // $5 max per API call
  perDay: parseUnits('50', 6),  // $50 daily budget
};

// Placeholder service registry (testnet payees). Override with AGENT_EXAMPLE_PAYEES.
const DEFAULT_SERVICES: Record<string, { wallet: Address; priceUsd: string; name: string }> = {
  'sentiment-v2': { wallet: '0x1111111111111111111111111111111111111111', priceUsd: '0.50', name: 'Sentiment Analysis Agent' },
  'price-oracle': { wallet: '0x2222222222222222222222222222222222222222', priceUsd: '0.10', name: 'Price Oracle Agent' },
  'research-deep': { wallet: '0x3333333333333333333333333333333333333333', priceUsd: '2.00', name: 'Deep Research Agent' },
};

function loadServices(): typeof DEFAULT_SERVICES {
  const raw = process.env.AGENT_EXAMPLE_PAYEES;
  if (!raw) return DEFAULT_SERVICES;
  const overrides = JSON.parse(raw) as Record<string, string>;
  const services = { ...DEFAULT_SERVICES };
  for (const [id, address] of Object.entries(overrides)) {
    if (!services[id] || !isAddress(address)) throw new Error(`Invalid payee override for ${id}`);
    services[id] = { ...services[id], wallet: address };
  }
  return services;
}

/**
 * Pay an agent for an API call. Returns paid=true only when the transfer
 * executed on-chain; a queued transfer moved no tokens.
 */
export async function payForAgentAPI(
  wallet: AgentWalletHandle,
  usdc: Address,
  serviceId: string,
  services = loadServices(),
): Promise<{ paid: boolean; txHash: `0x${string}`; pendingTxId?: bigint }> {
  const service = services[serviceId];
  if (!service) throw new Error(`Unknown service: ${serviceId}`);

  const amount = parseUnits(service.priceUsd, 6);
  console.log(`  💸 Paying ${service.name}: $${service.priceUsd}`);

  const result = await agentTransferToken(wallet, { token: usdc, to: service.wallet, amount });
  if (result.status === 'queued') {
    console.log(`  ⏸️  Queued for owner approval (txId ${result.pendingTxId}); NOT paid`);
    return { paid: false, txHash: result.txHash, pendingTxId: result.pendingTxId };
  }
  console.log(`  📝 Payment executed: ${result.txHash}`);
  // In production: call the service with the executed tx hash as proof-of-payment.
  return { paid: true, txHash: result.txHash };
}

export async function main(): Promise<void> {
  const network = resolveExampleNetwork();
  const agentAccount = privateKeyToAccount(requireEnv('AGENT_PRIVATE_KEY') as `0x${string}`);
  const walletClient = createWalletClient({
    account: agentAccount,
    chain: network.chain,
    transport: http(process.env.RPC_URL),
  });

  const wallet = createWallet({
    accountAddress: requireEnv('AGENT_WALLET') as Address,
    chain: network.chainKey,
    rpcUrl: process.env.RPC_URL,
    walletClient,
    ...exampleDeploymentIdentity(),
  });

  console.log(`🤖 Micropayment agent on ${network.chainKey}${network.live ? ' (LIVE FUNDS)' : ''}: ${wallet.address}`);
  await assertInstalledSpendPolicy(wallet, network.usdc, LIMITS);

  const unwatch = onTransactionQueued(wallet, (event) => {
    console.log(`\n🚨 Transaction queued (ID: ${event.txId}) — awaiting owner approval`);
  });

  try {
    for (const serviceId of ['sentiment-v2', 'price-oracle', 'research-deep']) {
      const outcome = await payForAgentAPI(wallet, network.usdc, serviceId);
      if (!outcome.paid) break; // stop the workflow; do not retry a queued payment
    }
    const budget = await checkBudget(wallet, network.usdc);
    console.log(`💰 Remaining on-chain budget: ${budget.remainingInPeriod} base units`);
  } finally {
    unwatch();
  }
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
