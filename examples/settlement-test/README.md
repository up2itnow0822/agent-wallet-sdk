# Base Sepolia Receipt Inspector

This local testnet example inspects transaction receipts. It has no signing
account, requires no private key, and performs no outgoing token transfers.
`POST /settle` always returns `503` and issues no payment instructions.

Settlement is disabled because the example does not implement a durable
challenge store or atomically consume a transfer identity. A public receipt
cannot establish which request was paid, and a memory map cannot prevent replay
after a restart. The former fee forwarding flow was a separate transaction and
did not implement atomic settlement.

Before any settlement implementation can be enabled, it must bind each payment
to an issued challenge and its sender, recipient, chain, token, and exact positive
bounded amount. It must consume `(chainId, transactionHash, logIndex)` atomically
and durably across concurrent requests and restarts. Fees and trade/payment
outcomes need a reviewed atomic route or explicit independent outcome handling.
These features are not implemented in this example.

## API

| Endpoint | Behavior |
|---|---|
| `GET /docs` | Describes the read-only API and disabled settlement path |
| `GET /health` | Checks that the configured RPC reports Base Sepolia, chain 84532 |
| `POST /settle` | Always returns 503 with `settlementEnabled: false` |
| `GET /attestation/:txHash` | Shows receipt status and USDC Transfer logs; `paymentAuthorized` and `verified` remain false |
| `GET /settlements` | Returns an empty list while settlement is disabled |

The historical `/attestation` route name is retained for compatibility. Its
response is diagnostic receipt data, not a payment or settlement proof. Receipt
inspection can be repeated because it never authorizes a service or moves funds.

## Run Locally

From the repository root, install the example's optional dependencies separately
if needed (`express`, `dotenv`, and `tsx` are not SDK dependencies), then run:

```bash
cp examples/settlement-test/.env.example .env
npx tsx examples/settlement-test/server.ts
```

The server binds to `127.0.0.1` and supports only Base Sepolia. The token is the
Base Sepolia USDC contract `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
No hosted deployment is verified by this example.

## Read-Only Probe

```bash
npx tsx examples/settlement-test/self-test.ts
```

The probe checks the local server and verifies that settlement submission is
disabled. It submits no on-chain transactions.
