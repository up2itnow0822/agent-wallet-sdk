/**
 * Trading Agent Example — spend-limited USDC transfers
 *
 * Demonstrates an autonomous agent operating under an on-chain policy:
 *   - $100/tx limit, $2000/day budget (must already be installed by the owner)
 *   - Over-limit trades are queued for owner approval and reported as such
 *
 * Safety: runs on Base Sepolia by default. Base mainnet requires
 * AGENT_EXAMPLE_NETWORK=base and AGENT_EXAMPLE_LIVE_ACK (see _example-safety.ts).
 * Nothing runs on import; execute this file directly to run it.
 *
 * Env: AGENT_PRIVATE_KEY, AGENT_WALLET, TRADE_COUNTERPARTY, RPC_URL (optional).
 */

import { createWalletClient, http, parseUnits, isAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createWallet,
  agentTransferToken,
  checkBudget,
  onTransactionQueued,
  AgentExecutionError,
} from '../src/index.js';
import {
  assertInstalledSpendPolicy,
  isDirectRun,
  requireEnv,
  resolveExampleNetwork,
} from './_example-safety.js';

export const LIMITS = {
  perTx: parseUnits('100', 6),       // $100 max per trade
  perDay: parseUnits('2000', 6),     // $2,000 daily budget
};

export async function main(): Promise<void> {
  const network = resolveExampleNetwork();
  const counterparty = requireEnv('TRADE_COUNTERPARTY');
  if (!isAddress(counterparty)) throw new Error('TRADE_COUNTERPARTY must be an address');

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
  });

  console.log(`🤖 Trading agent on ${network.chainKey}${network.live ? ' (LIVE FUNDS)' : ''}: ${wallet.address}`);
  await assertInstalledSpendPolicy(wallet, network.usdc, LIMITS);

  const budget = await checkBudget(wallet, network.usdc);
  console.log(`💰 Budget remaining: ${budget.remainingInPeriod} / per-tx ${budget.perTxLimit} (base units)`);

  const unwatch = onTransactionQueued(wallet, (event) => {
    console.log(`⚠️  Trade queued for owner approval (txId ${event.txId}, amount ${event.amount})`);
  });

  const trades = [
    { name: 'Position A', size: parseUnits('50', 6) },
    { name: 'Position B', size: parseUnits('75', 6) },
    { name: 'Over-limit attempt', size: parseUnits('500', 6) }, // expected to queue
  ];

  try {
    for (const trade of trades) {
      console.log(`\n📊 ${trade.name}: ${trade.size} base units`);
      try {
        const result = await agentTransferToken(wallet, {
          token: network.usdc,
          to: counterparty,
          amount: trade.size,
        });
        if (result.status === 'executed') console.log(`   ✅ Executed: ${result.txHash}`);
        else console.log(`   ⏸️  Queued (txId ${result.pendingTxId}); no tokens moved`);
      } catch (err) {
        if (err instanceof AgentExecutionError && err.executionStatus === 'unknown') {
          // Never resubmit an unknown transfer; reconcile its hash first.
          console.log(`   ❓ Outcome unknown for ${err.txHash}; stopping until reconciled`);
          break;
        }
        console.log(`   ❌ ${(err as Error).message}`);
      }
    }
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
