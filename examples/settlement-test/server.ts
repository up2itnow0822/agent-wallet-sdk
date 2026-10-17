/**
 * Local, read-only Base Sepolia receipt inspector.
 *
 * Settlement submission stays disabled until durable challenge binding and
 * atomic transfer consumption are implemented. This example has no signer.
 */
import express from 'express';
import { createPublicClient, decodeEventLog, formatUnits, http, parseAbi, type Hash } from 'viem';
import { baseSepolia } from 'viem/chains';
import * as dotenv from 'dotenv';

dotenv.config();

const PORT = Number(process.env.PORT || '3402');
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
const RPC_URL = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });

const app = express();
app.use(express.json({ limit: '16kb' }));

const settlementUnavailable = {
  error: 'Settlement submission is disabled',
  settlementEnabled: false,
  paymentAuthorized: false,
  reason: 'A durable challenge store and atomic consumption of transfer identity are required before settlement can be enabled.',
};

app.get('/docs', (_req, res) => res.json({
  name: 'Base Sepolia Receipt Inspector',
  description: 'Local testnet receipt inspection. Public receipts do not authorize settlement or outgoing transfers.',
  chainId: baseSepolia.id,
  usdc: USDC_ADDRESS,
  settlementEnabled: false,
  endpoints: {
    'GET /health': 'Read-only status and testnet RPC chain check',
    'POST /settle': 'Always returns 503; does not issue payment instructions or accept payment proof',
    'GET /attestation/:txHash': 'Inspect USDC Transfer logs; this is not payment authorization',
    'GET /settlements': 'Empty list while settlement is disabled',
  },
}));

app.get('/health', async (_req, res) => {
  try {
    const chainId = await publicClient.getChainId();
    if (chainId !== baseSepolia.id) {
      return res.status(503).json({ error: 'RPC must use Base Sepolia (84532)', settlementEnabled: false });
    }
    return res.json({ status: 'healthy', mode: 'read-only', chainId, settlementEnabled: false });
  } catch {
    return res.status(503).json({ error: 'Testnet RPC unavailable', settlementEnabled: false });
  }
});

// Neither a supplied sender/amount nor a public transaction receipt can
// authorize a settlement. A memory Map would lose consumed receipts on restart.
app.post('/settle', (_req, res) => res.status(503).json(settlementUnavailable));

app.get('/attestation/:txHash', async (req, res) => {
  const { txHash } = req.params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return res.status(400).json({ error: 'A 32-byte transaction hash is required' });
  }
  try {
    if (await publicClient.getChainId() !== baseSepolia.id) {
      return res.status(503).json({ error: 'RPC must use Base Sepolia (84532)', settlementEnabled: false });
    }
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hash });
    const transfers = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
      try {
        const { args } = decodeEventLog({
          abi: TRANSFER_ABI, eventName: 'Transfer', data: log.data, topics: log.topics, strict: true,
        });
        transfers.push({ from: args.from, to: args.to, amount: formatUnits(args.value, 6), logIndex: log.logIndex });
      } catch {
        // An unrelated or malformed token log is not a Transfer event.
      }
    }
    return res.json({
      txHash,
      status: receipt.status,
      chainId: baseSepolia.id,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      transferCount: transfers.length,
      transfers,
      verified: false,
      paymentAuthorized: false,
      settlementEnabled: false,
      note: 'Receipt data is diagnostic only. Sender, amount, and challenge binding have not authorized a payment.',
    });
  } catch {
    return res.status(503).json({ error: 'Receipt unavailable from the testnet RPC', paymentAuthorized: false });
  }
});

app.get('/settlements', (_req, res) => res.json({ settlements: [], total: 0, settlementEnabled: false }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Base Sepolia receipt inspector: http://127.0.0.1:${PORT}. Settlement submission is disabled.`);
});
