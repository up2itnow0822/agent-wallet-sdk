import { describe, expect, it } from 'vitest';
import {
  X402BudgetExceededError,
  X402IntentTermsConflictError,
  X402PaymentError,
  X402SettlementBacklogError,
  X402SettlementQueuedError,
  X402SettlementRevertedError,
  X402SettlementUnknownError,
} from '../x402/client.js';
import type { X402PaymentRequirements } from '../x402/types.js';
import {
  classifySpendAttempt,
  classifySpendError,
  isEvmTxHash,
  type SpendOutcome,
} from './index.js';

const VALID_HASH =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const VALID_FEE_HASH =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SHORT_HASH = '0xabc123';

const REQUIREMENTS: X402PaymentRequirements = {
  scheme: 'exact',
  network: 'base:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '1000000',
  payTo: '0x1111111111111111111111111111111111111111',
  maxTimeoutSeconds: 30,
  extra: {},
};

function expectReleased(outcome: SpendOutcome): void {
  expect(outcome.status).toBe('released');
  expect(outcome.retrySafe).toBe(true);
}

function expectHoldUnknown(outcome: SpendOutcome): void {
  expect(outcome.status).toBe('hold-unknown');
  expect(outcome.retrySafe).toBe(false);
}

function expectSettled(outcome: SpendOutcome): void {
  expect(outcome.status).toBe('settled');
  expect(outcome.retrySafe).toBe(false);
}

describe('isEvmTxHash', () => {
  it('accepts 0x-prefixed 32-byte hex', () => {
    expect(isEvmTxHash(VALID_HASH)).toBe(true);
    expect(isEvmTxHash(VALID_HASH.toUpperCase())).toBe(true);
  });

  it('rejects missing, short, or malformed hashes', () => {
    expect(isEvmTxHash(undefined)).toBe(false);
    expect(isEvmTxHash(SHORT_HASH)).toBe(false);
    expect(isEvmTxHash('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
    expect(isEvmTxHash(`0x${'gg'.repeat(32)}`)).toBe(false);
    expect(isEvmTxHash(`0x${'aa'.repeat(31)}`)).toBe(false);
  });
});

describe('classifySpendError', () => {
  it('treats confirmed reverts as definite not-charged', () => {
    const outcome = classifySpendError(new X402SettlementRevertedError(VALID_HASH as `0x${string}`));
    expectReleased(outcome);
    expect(outcome.txHash).toBe(VALID_HASH);
    expect(outcome.txHashes).toEqual([VALID_HASH]);
  });

  it('treats pre-broadcast budget and payment errors as definite not-charged', () => {
    expectReleased(classifySpendError(new X402BudgetExceededError('cap', 'https://api.example.com', REQUIREMENTS)));
    expectReleased(classifySpendError(new X402PaymentError('no matching requirements', REQUIREMENTS)));
    expectReleased(classifySpendError(new X402SettlementBacklogError(3)));
  });

  it('treats intent conflicts as definite and not auto-retryable', () => {
    const outcome = classifySpendError(
      new X402IntentTermsConflictError('intent', 'cached', 'observed'),
    );
    expect(outcome.status).toBe('released');
    expect(outcome.retrySafe).toBe(false);
  });

  it('treats unknown and queued post-broadcast errors as hold-unknown', () => {
    expectHoldUnknown(classifySpendError(new X402SettlementUnknownError(VALID_HASH as `0x${string}`)));
    expectHoldUnknown(classifySpendError(new X402SettlementQueuedError(VALID_HASH as `0x${string}`)));
  });

  it('treats receipt timeouts and unclear post-broadcast failures as hold-unknown', () => {
    expectHoldUnknown(classifySpendError(Object.assign(new Error('waitForTransactionReceipt timed out'), {
      txHash: VALID_HASH,
    })));
    expectHoldUnknown(classifySpendError(new Error(`receipt polling failed (${VALID_HASH})`)));
  });

  it('treats generic pre-broadcast throws as definite not-charged', () => {
    expectReleased(classifySpendError(new Error('user rejected request')));
    expectReleased(classifySpendError(new Error('insufficient funds for gas')));
  });
});

describe('classifySpendAttempt', () => {
  it('settles only when the receipt is successful and every required hash is valid', () => {
    const outcome = classifySpendAttempt({
      receipt: { status: 'success', transactionHash: VALID_HASH },
      txHashes: [VALID_HASH, VALID_FEE_HASH],
      chainId: 8453,
      amount: 1_000_000n,
      fee: 7_700n,
      idempotencyKey: 'pay-1',
    });
    expectSettled(outcome);
    expect(outcome.txHash).toBe(VALID_HASH);
    expect(outcome.txHashes).toEqual([VALID_HASH, VALID_FEE_HASH]);
    expect(outcome.chainId).toBe(8453);
    expect(outcome.amount).toBe(1_000_000n);
    expect(outcome.fee).toBe(7_700n);
    expect(outcome.idempotencyKey).toBe('pay-1');
  });

  it('refuses to settle a success-shaped receipt with an invalid hash', () => {
    const outcome = classifySpendAttempt({
      receipt: { status: 'success', txHash: SHORT_HASH },
    });
    expectHoldUnknown(outcome);
    expect(outcome.txHashes).toEqual([]);
  });

  it('releases a confirmed on-chain revert receipt', () => {
    const outcome = classifySpendAttempt({
      receipt: { status: 'reverted', transactionHash: VALID_HASH },
      txHash: VALID_HASH,
    });
    expectReleased(outcome);
    expect(outcome.txHash).toBe(VALID_HASH);
  });

  it('keeps a hold when a hash was returned but confirmation is missing', () => {
    const outcome = classifySpendAttempt({
      txHash: VALID_HASH,
      chainId: 8453,
    });
    expectHoldUnknown(outcome);
    expect(outcome.txHash).toBe(VALID_HASH);
  });

  it('releases a definite error even if a hash is attached', () => {
    const outcome = classifySpendAttempt({
      error: new X402SettlementRevertedError(VALID_HASH as `0x${string}`),
      txHash: VALID_HASH,
    });
    expectReleased(outcome);
  });

  it('does not treat hold-unknown as retry-safe', () => {
    const outcome = classifySpendAttempt({
      error: new X402SettlementUnknownError(VALID_HASH as `0x${string}`),
    });
    expectHoldUnknown(outcome);
    expect(outcome.retrySafe).toBe(false);
  });

  it('exports the outcomes API from the package entry', async () => {
    const root = await import('../index.js');
    expect(root.classifySpendAttempt).toBe(classifySpendAttempt);
    expect(root.classifySpendError).toBe(classifySpendError);
    expect(root.isEvmTxHash).toBe(isEvmTxHash);
    expect(root.x402ProtocolFeeAmount(1_000_000n)).toBe(7_700n);
  });
});
