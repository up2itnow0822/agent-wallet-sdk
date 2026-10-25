/** Read-only local probe. It creates no wallet and submits no transactions. */
import * as dotenv from 'dotenv';

dotenv.config();

const ENDPOINT = 'http://127.0.0.1:3402';

async function main() {
  const health = await fetch(`${ENDPOINT}/health`);
  const status = await health.json();
  if (health.status !== 200 || status.chainId !== 84532 || status.settlementEnabled !== false) {
    throw new Error('Expected a healthy, read-only Base Sepolia inspector');
  }

  const submission = await fetch(`${ENDPOINT}/settle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: '0.10', from: '0x1111111111111111111111111111111111111111' }),
  });
  const result = await submission.json();
  if (submission.status !== 503 || result.settlementEnabled !== false) {
    throw new Error('Settlement submission must stay disabled');
  }
  console.log('Read-only probe passed: Base Sepolia RPC checked; settlement submission disabled.');
}

main().catch(console.error);
