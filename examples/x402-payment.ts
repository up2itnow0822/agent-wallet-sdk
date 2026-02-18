/**
 * x402 Payment Example — Automatic HTTP 402 Payment Handling
 *
 * Demonstrates how an agent automatically pays for API access
 * using the x402 protocol (HTTP 402 Payment Required).
 *
 * When a server returns 402, the client:
 *   1. Parses payment requirements from the response
 *   2. Validates against budget limits
 *   3. Pays via AgentWallet (USDC on Base)
 *   4. Retries the request with the payment receipt
 *   5. Returns the successful response
 */

import { createWalletClient, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import {
  createWallet,
  createX402Client,
  createX402Fetch,
  type X402TransactionLog,
} from '../src/index.js';

// ─── Config ───

const AGENT_KEY = process.env.AGENT_PRIVATE_KEY as `0x${string}`;
const AGENT_ACCOUNT = process.env.AGENT_ACCOUNT_ADDRESS as Address;
const RPC_URL = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';

// ─── Setup ───

const walletClient = createWalletClient({
  account: privateKeyToAccount(AGENT_KEY),
  chain: base,
  transport: http(RPC_URL),
});

const wallet = createWallet({
  accountAddress: AGENT_ACCOUNT,
  chain: 'base',
  rpcUrl: RPC_URL,
  walletClient,
});

// ─── Example 1: Basic x402 Client ───

async function basicUsage() {
  // Agent automatically pays for API access
  const client = createX402Client(wallet, {
    globalPerRequestMax: 1_000_000n,   // Max $1 USDC per request
    globalDailyLimit: 10_000_000n,     // Max $10 USDC per day
    onPaymentComplete: (log: X402TransactionLog) => {
      console.log(`Paid ${log.amount} to ${log.recipient} for ${log.url}`);
      console.log(`Tx: ${log.txHash}`);
    },
  });

  // If 402 returned, payment handled automatically
  const response = await client.fetch('https://api.example.com/data');
  const data = await response.json();
  console.log('Got data:', data);

  // Check spending
  const summary = client.getDailySpendSummary();
  console.log(`Today's spend: ${summary.global} (resets at ${new Date(summary.resetsAt * 1000)})`);
}

// ─── Example 2: Drop-in Fetch Replacement ───

async function fetchReplacement() {
  // Works as a drop-in replacement for fetch()
  const x402Fetch = createX402Fetch(wallet, {
    globalPerRequestMax: 5_000_000n, // Max $5 per request
  });

  const response = await x402Fetch('https://api.example.com/premium-data');
  console.log('Status:', response.status);
}

// ─── Example 3: Service-Level Budgets ───

async function serviceBudgets() {
  const client = createX402Client(wallet, {
    globalDailyLimit: 50_000_000n, // $50/day total
    serviceBudgets: [
      {
        service: 'api.openai.com',
        maxPerRequest: 500_000n,     // $0.50 per request
        dailyLimit: 20_000_000n,     // $20/day for OpenAI
      },
      {
        service: 'data-feed.example.com',
        maxPerRequest: 100_000n,     // $0.10 per request
        dailyLimit: 5_000_000n,      // $5/day for data
      },
      {
        service: '*',                // Wildcard for all other services
        maxPerRequest: 1_000_000n,   // $1 per request
        dailyLimit: 10_000_000n,     // $10/day
      },
    ],
    onBeforePayment: async (req, url) => {
      console.log(`About to pay ${req.amount} for ${url}`);
      return true; // Return false to reject
    },
  });

  const response = await client.fetch('https://api.openai.com/v1/chat');
  console.log('Response:', response.status);
}

// ─── Run ───

async function main() {
  console.log('=== x402 Payment Examples ===\n');

  try {
    await basicUsage();
  } catch (e: any) {
    console.log('Basic usage example:', e.message);
  }

  try {
    await fetchReplacement();
  } catch (e: any) {
    console.log('Fetch replacement example:', e.message);
  }

  try {
    await serviceBudgets();
  } catch (e: any) {
    console.log('Service budgets example:', e.message);
  }
}

main().catch(console.error);
