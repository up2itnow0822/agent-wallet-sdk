/**
 * Dexter Settlement Test Server — Base Sepolia
 *
 * Exposes x402-protected settlement endpoint for testing atomic settlement
 * with Dexter Agent's facilitator. Uses agentwallet-sdk for:
 * - x402 payment verification
 * - On-chain attestation verification
 * - Atomic settlement logging
 */

import express from 'express';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import * as dotenv from 'dotenv';

dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3402', 10);
const PRIVATE_KEY = process.env.PRIVATE_KEY as Hex;
const RPC_URL = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const FEE_COLLECTOR = (process.env.FEE_COLLECTOR || '0xff86829393C6C26A4EC122bE0Cc3E466Ef876AdD') as Address;
const USDC_ADDRESS = (process.env.USDC_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e') as Address;

// Settlement fee: 0.77% (matching our production swap fee)
const SETTLEMENT_FEE_BPS = 77;

if (!PRIVATE_KEY) {
  console.error('PRIVATE_KEY required in .env');
  process.exit(1);
}

// ─── Viem Clients ────────────────────────────────────────────────────────────

const account = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL),
});

const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(RPC_URL),
});

// ─── ERC20 ABI (minimal) ────────────────────────────────────────────────────

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'Transfer',
    type: 'event',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

// ─── Settlement Log ──────────────────────────────────────────────────────────

interface SettlementRecord {
  id: string;
  timestamp: string;
  from: Address;
  amount: string;
  fee: string;
  netAmount: string;
  paymentTxHash: Hash | null;
  status: 'pending_payment' | 'payment_received' | 'settled' | 'failed';
  attestationVerified: boolean;
}

const settlements: Map<string, SettlementRecord> = new Map();

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Rate limiting (simple in-memory)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10; // requests per window
const RATE_WINDOW_MS = 60_000; // 1 minute

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!rateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. 10 requests per minute.' });
  }
  next();
});

// API Documentation
app.get('/docs', (_req, res) => {
  res.json({
    name: 'AgentWallet Settlement Test Server',
    description: 'x402-protected atomic settlement endpoint on Base Sepolia. Test cross-chain agent payments with on-chain attestation verification.',
    chain: 'Base Sepolia (84532)',
    usdc: USDC_ADDRESS,
    settlementFee: '0.77%',
    faucet: 'https://faucet.circle.com/ (Base Sepolia USDC)',
    endpoints: {
      'GET /health': 'Server health check + USDC balance',
      'GET /docs': 'This documentation',
      'POST /settle': {
        description: 'Initiate atomic settlement via x402 flow',
        body: { amount: 'string (USDC amount)', from: 'address (sender)', paymentTxHash: 'optional hash (include after payment)' },
        flow: [
          '1. POST /settle with {amount, from} → returns 402 with payment requirements',
          '2. Send USDC to the recipient address on Base Sepolia',
          '3. POST /settle with {amount, from, paymentTxHash} → verifies on-chain → returns settlement confirmation',
        ],
      },
      'GET /attestation/:txHash': 'Verify on-chain attestation for any Base Sepolia tx',
      'GET /settlements': 'List recent settlements (last 20)',
    },
    links: {
      sdk: 'https://www.npmjs.com/package/agentwallet-sdk',
      github: 'https://github.com/up2itnow0822/agent-wallet-sdk',
      docs: 'https://ai-agent-economy.hashnode.dev',
    },
  });
});

// Health check
app.get('/health', async (_req, res) => {
  const balance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });

  res.json({
    status: 'healthy',
    chain: 'base-sepolia',
    chainId: 84532,
    address: account.address,
    feeCollector: FEE_COLLECTOR,
    usdcBalance: formatUnits(balance as bigint, 6),
    settlementFeeBps: SETTLEMENT_FEE_BPS,
    timestamp: new Date().toISOString(),
  });
});

// x402 Settlement endpoint
app.post('/settle', async (req, res) => {
  const { amount, from, paymentTxHash } = req.body;

  if (!amount || !from) {
    return res.status(400).json({ error: 'Missing required fields: amount, from' });
  }

  const amountWei = parseUnits(String(amount), 6);
  const feeAmount = (amountWei * BigInt(SETTLEMENT_FEE_BPS)) / 10000n;
  const netAmount = amountWei - feeAmount;

  const settlementId = `stl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // If no payment tx provided, return 402 with payment requirements
  if (!paymentTxHash) {
    const settlement: SettlementRecord = {
      id: settlementId,
      timestamp: new Date().toISOString(),
      from: from as Address,
      amount: formatUnits(amountWei, 6),
      fee: formatUnits(feeAmount, 6),
      netAmount: formatUnits(netAmount, 6),
      paymentTxHash: null,
      status: 'pending_payment',
      attestationVerified: false,
    };
    settlements.set(settlementId, settlement);

    return res.status(402).json({
      settlementId,
      paymentRequired: {
        network: 'base-sepolia:84532',
        token: USDC_ADDRESS,
        amount: formatUnits(amountWei, 6),
        recipient: account.address,
        fee: formatUnits(feeAmount, 6),
        netAmount: formatUnits(netAmount, 6),
        memo: `settlement:${settlementId}`,
      },
      message: 'Send USDC to the recipient address with the settlement ID in the memo. Then retry with paymentTxHash.',
    });
  }

  // Payment tx provided — verify it on-chain
  try {
    console.log(`Verifying payment tx: ${paymentTxHash}`);

    const receipt = await publicClient.getTransactionReceipt({
      hash: paymentTxHash as Hash,
    });

    if (!receipt || receipt.status !== 'success') {
      return res.status(400).json({
        error: 'Transaction failed or not found',
        txHash: paymentTxHash,
      });
    }

    // Parse Transfer events to verify payment
    const transferLogs = receipt.logs.filter(
      (log) =>
        log.address.toLowerCase() === USDC_ADDRESS.toLowerCase() &&
        log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', // Transfer event
    );

    if (transferLogs.length === 0) {
      return res.status(400).json({
        error: 'No USDC transfer found in transaction',
        txHash: paymentTxHash,
      });
    }

    // Verify transfer was to our address
    const ourTransfer = transferLogs.find((log) => {
      const to = `0x${log.topics[2]?.slice(26)}`.toLowerCase();
      return to === account.address.toLowerCase();
    });

    if (!ourTransfer) {
      return res.status(400).json({
        error: 'USDC transfer recipient does not match settlement address',
        expected: account.address,
        txHash: paymentTxHash,
      });
    }

    // Verify amount
    const transferAmount = BigInt(ourTransfer.data);
    if (transferAmount < amountWei) {
      return res.status(400).json({
        error: 'Insufficient payment amount',
        expected: formatUnits(amountWei, 6),
        received: formatUnits(transferAmount, 6),
      });
    }

    // Forward fee to fee collector
    let feeTxHash: Hash | null = null;
    if (feeAmount > 0n) {
      try {
        feeTxHash = await walletClient.writeContract({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [FEE_COLLECTOR, feeAmount],
        });
        console.log(`Fee forwarded: ${formatUnits(feeAmount, 6)} USDC → ${FEE_COLLECTOR} (tx: ${feeTxHash})`);
      } catch (err) {
        console.error('Fee forwarding failed (non-fatal):', err);
      }
    }

    // Update settlement record
    const settlement: SettlementRecord = {
      id: settlementId,
      timestamp: new Date().toISOString(),
      from: from as Address,
      amount: formatUnits(amountWei, 6),
      fee: formatUnits(feeAmount, 6),
      netAmount: formatUnits(netAmount, 6),
      paymentTxHash: paymentTxHash as Hash,
      status: 'settled',
      attestationVerified: true,
    };
    settlements.set(settlementId, settlement);

    console.log(`✅ Settlement ${settlementId} completed: ${formatUnits(amountWei, 6)} USDC from ${from}`);

    return res.json({
      settlementId,
      status: 'settled',
      attestationVerified: true,
      paymentTxHash,
      feeTxHash,
      amount: formatUnits(amountWei, 6),
      fee: formatUnits(feeAmount, 6),
      netAmount: formatUnits(netAmount, 6),
      chain: 'base-sepolia:84532',
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error(`Settlement verification failed:`, err.message);
    return res.status(500).json({
      error: 'Settlement verification failed',
      details: err.message,
    });
  }
});

// Attestation verification endpoint
app.get('/attestation/:txHash', async (req, res) => {
  const { txHash } = req.params;

  try {
    const receipt = await publicClient.getTransactionReceipt({
      hash: txHash as Hash,
    });

    if (!receipt) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const transferLogs = receipt.logs.filter(
      (log) =>
        log.address.toLowerCase() === USDC_ADDRESS.toLowerCase() &&
        log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    );

    return res.json({
      txHash,
      status: receipt.status,
      blockNumber: Number(receipt.blockNumber),
      blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed.toString(),
      transferCount: transferLogs.length,
      transfers: transferLogs.map((log) => ({
        from: `0x${log.topics[1]?.slice(26)}`,
        to: `0x${log.topics[2]?.slice(26)}`,
        amount: formatUnits(BigInt(log.data), 6),
      })),
      verified: receipt.status === 'success' && transferLogs.length > 0,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// List settlements
app.get('/settlements', (_req, res) => {
  const records = Array.from(settlements.values()).slice(-20);
  res.json({ settlements: records, total: settlements.size });
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
🔧 Dexter Settlement Test Server
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Chain:       Base Sepolia (84532)
Address:     ${account.address}
Fee:         ${SETTLEMENT_FEE_BPS / 100}%
Collector:   ${FEE_COLLECTOR}
USDC:        ${USDC_ADDRESS}

Endpoints:
  GET  /health              — Server health + USDC balance
  POST /settle              — Initiate settlement (x402 flow)
  GET  /attestation/:txHash — Verify on-chain attestation
  GET  /settlements         — List recent settlements

Listening on port ${PORT}...
  `);
});
