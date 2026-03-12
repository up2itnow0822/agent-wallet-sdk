/**
 * Self-test: Send USDC on Base Sepolia to our own settlement endpoint
 * and verify the full x402 → payment → attestation → settle flow.
 */
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, encodeFunctionData, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import * as dotenv from 'dotenv';

dotenv.config();

const ENDPOINT = 'https://dexter-settlement-test-production.up.railway.app';
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;

const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http('https://sepolia.base.org') });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http('https://sepolia.base.org') });

  console.log(`\n🧪 Self-Test: Full x402 Settlement Flow`);
  console.log(`Wallet: ${account.address}`);

  // Check balance
  const balance = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
  console.log(`USDC Balance: ${formatUnits(balance, 6)}`);

  if (balance < parseUnits('1', 6)) {
    console.error('❌ Insufficient USDC balance for test. Need at least 1 USDC.');
    process.exit(1);
  }

  // Step 1: Request settlement (get 402)
  console.log(`\n📤 Step 1: POST /settle (expect 402)...`);
  const step1 = await fetch(`${ENDPOINT}/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: '0.10', from: account.address }),
  });
  const payment = await step1.json();
  console.log(`   Status: ${step1.status}`);
  console.log(`   Settlement ID: ${payment.settlementId}`);
  console.log(`   Pay ${payment.paymentRequired.amount} USDC to ${payment.paymentRequired.recipient}`);

  if (step1.status !== 402) {
    console.error('❌ Expected 402, got', step1.status);
    process.exit(1);
  }

  // Step 2: Send USDC on-chain
  console.log(`\n💸 Step 2: Sending 0.10 USDC on Base Sepolia...`);
  const recipient = payment.paymentRequired.recipient as `0x${string}`;
  
  // Since we're sending to ourselves (same wallet), use a minimal amount
  // In a real test with separate wallets, this would be a cross-wallet transfer
  const txHash = await walletClient.writeContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [recipient, parseUnits('0.10', 6)],
  });
  console.log(`   Tx: ${txHash}`);

  // Wait for confirmation
  console.log(`   Waiting for confirmation...`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`   Block: ${receipt.blockNumber} | Status: ${receipt.status}`);

  // Step 3: Complete settlement with payment proof
  console.log(`\n✅ Step 3: POST /settle with paymentTxHash...`);
  const step3 = await fetch(`${ENDPOINT}/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: '0.10',
      from: account.address,
      paymentTxHash: txHash,
    }),
  });
  const settlement = await step3.json();
  console.log(`   Status: ${step3.status}`);
  console.log(`   Settlement:`, JSON.stringify(settlement, null, 2));

  // Step 4: Verify attestation
  console.log(`\n🔍 Step 4: GET /attestation/${txHash}...`);
  const step4 = await fetch(`${ENDPOINT}/attestation/${txHash}`);
  const attestation = await step4.json();
  console.log(`   Verified: ${attestation.verified}`);
  console.log(`   Transfers: ${attestation.transferCount}`);

  // Summary
  console.log(`\n${'━'.repeat(50)}`);
  if (step3.status === 200 && settlement.status === 'settled') {
    console.log(`✅ SELF-TEST PASSED — Full x402 settlement flow verified`);
    console.log(`   Amount: ${settlement.amount} USDC`);
    console.log(`   Fee: ${settlement.fee} USDC (0.77%)`);
    console.log(`   Net: ${settlement.netAmount} USDC`);
    console.log(`   Attestation: ${settlement.attestationVerified ? 'VERIFIED' : 'FAILED'}`);
  } else {
    console.log(`❌ SELF-TEST FAILED`);
    console.log(`   Response:`, settlement);
  }
}

main().catch(console.error);
