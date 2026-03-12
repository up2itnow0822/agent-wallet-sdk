# Atomic Settlement Test — Base Sepolia

Proof of atomic settlement with on-chain attestation verification using the AgentWallet SDK's x402 payment flow.

## Live Endpoint

```
https://dexter-settlement-test-production.up.railway.app
```

## Verified On-Chain Transactions

| Step | Transaction | Status |
|---|---|---|
| USDC Payment | [`0xbba6c34a...`](https://sepolia.basescan.org/tx/0xbba6c34ad6b11cc4e511317ca38553df903dcbe989ee47e45b5c48f3af7e4334) | ✅ Confirmed |
| Fee Routing (0.77%) | [`0x9a5e450c...`](https://sepolia.basescan.org/tx/0x9a5e450c1080a2478ea22792b6ab034974d8f99072808f83354c98451441733a) | ✅ Confirmed |

## How It Works

1. **Request settlement** → Server returns `402 Payment Required` with USDC payment instructions
2. **Send USDC** on Base Sepolia to the settlement address
3. **Complete settlement** → Server verifies the on-chain transfer, checks attestation, routes fees, confirms atomically

## Settlement Flow

```
Agent A                    Settlement Server              Base Sepolia
  │                              │                            │
  ├──POST /settle {amount}──────►│                            │
  │◄─────── 402 + payment req────│                            │
  │                              │                            │
  ├──USDC transfer──────────────────────────────────────────►│
  │                              │                            │
  ├──POST /settle {paymentTx}───►│                            │
  │                              ├──verify tx on-chain───────►│
  │                              │◄──receipt + logs────────────│
  │                              ├──route fee to collector───►│
  │◄─────── 200 settled──────────│                            │
```

## API

### `GET /docs`
Returns full API documentation.

### `GET /health`
Server health + USDC balance.

### `POST /settle`
```json
// Step 1: Request (returns 402)
{ "amount": "1.00", "from": "0xYourAddress" }

// Step 2: Complete (returns 200)
{ "amount": "1.00", "from": "0xYourAddress", "paymentTxHash": "0x..." }
```

### `GET /attestation/:txHash`
Verify on-chain attestation for any transaction.

## Run Locally

```bash
cp .env.example .env  # Add your Base Sepolia private key
npm install
npx tsx server.ts
```

## Self-Test

```bash
npx tsx self-test.ts
```

## Chain Details

- **Network:** Base Sepolia (Chain ID: 84532)
- **USDC:** `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- **Settlement Fee:** 0.77%
- **USDC Faucet:** https://faucet.circle.com/
