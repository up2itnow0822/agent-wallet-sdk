import { describe, it, expect } from 'vitest';
import { classifySpendAttempt } from '../outcomes/index.js';
import { x402DebitAmount, x402ProtocolFeeAmount } from '../x402/fee.js';
import { SpendingPolicy } from './SpendingPolicy.js';
import type { PaymentIntent, SpendingPolicyConfig } from './SpendingPolicy.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePayment(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    merchant: '0xAllowedMerchant',
    amount: 10,
    ...overrides,
  };
}

function makePolicy(config: SpendingPolicyConfig): SpendingPolicy {
  return new SpendingPolicy(config);
}

// ─── MerchantAllowlist ────────────────────────────────────────────────────────

describe('MerchantAllowlist', () => {
  it('allowlisted merchant passes', async () => {
    const policy = makePolicy({ merchantAllowlist: ['0xallowedmerchant'] });
    const result = await policy.check(makePayment({ merchant: '0xAllowedMerchant' }));
    expect(result.status).toBe('approved');
  });

  it('non-allowlisted merchant is blocked', async () => {
    const policy = makePolicy({ merchantAllowlist: ['0xallowedmerchant'] });
    const result = await policy.check(makePayment({ merchant: '0xEvilMerchant' }));
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/not on the allowlist/i);
  });

  it('addMerchant allows previously blocked merchant', async () => {
    const policy = makePolicy({ merchantAllowlist: ['0xallowedmerchant'] });
    policy.addMerchant('0xNewMerchant');
    const result = await policy.check(makePayment({ merchant: '0xNewMerchant' }));
    expect(result.status).toBe('approved');
  });

  it('getMerchantAllowlist returns current allowlist', () => {
    const policy = makePolicy({ merchantAllowlist: ['0xA', '0xB'] });
    const list = policy.getMerchantAllowlist();
    expect(list).toContain('0xa');
    expect(list).toContain('0xb');
    expect(list.length).toBe(2);
  });
});

// ─── RollingSpendCap ──────────────────────────────────────────────────────────

describe('RollingSpendCap', () => {
  it('allows payment under the rolling cap', async () => {
    const policy = makePolicy({
      rollingCap: { maxAmount: 100, windowMs: 86_400_000 },
    });
    const result = await policy.check(makePayment({ amount: 50 }));
    expect(result.status).toBe('approved');
  });

  it('blocks payment that would exceed the rolling cap', async () => {
    const policy = makePolicy({
      rollingCap: { maxAmount: 100, windowMs: 86_400_000 },
    });
    // First spend: 80
    await policy.check(makePayment({ amount: 80 }));
    // Second spend: 30 — total 110 > 100
    const result = await policy.check(makePayment({ amount: 30 }));
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/rolling spend cap exceeded/i);
  });

  it('allows payment exactly at the rolling cap', async () => {
    const policy = makePolicy({
      rollingCap: { maxAmount: 100, windowMs: 86_400_000 },
    });
    await policy.check(makePayment({ amount: 50 }));
    const result = await policy.check(makePayment({ amount: 50 }));
    expect(result.status).toBe('approved');
  });
});

// ─── DraftThenApprove ─────────────────────────────────────────────────────────

describe('DraftThenApprove', () => {
  it('queues payment at or above draft threshold', async () => {
    const policy = makePolicy({ draftThreshold: 500 });
    const result = await policy.check(makePayment({ amount: 500 }));
    expect(result.status).toBe('draft');
    expect(result.draftId).toBeTruthy();
  });

  it('approves payment below draft threshold immediately', async () => {
    const policy = makePolicy({ draftThreshold: 500 });
    const result = await policy.check(makePayment({ amount: 499 }));
    expect(result.status).toBe('approved');
  });

  it('queued draft appears in getPendingDrafts()', async () => {
    const policy = makePolicy({ draftThreshold: 100 });
    const result = await policy.check(makePayment({ amount: 200 }));
    const pending = policy.getPendingDrafts();
    expect(pending.length).toBe(1);
    expect(pending[0].draftId).toBe(result.draftId);
  });

  it('approveDraft marks draft approved and removes from pending', async () => {
    const policy = makePolicy({ draftThreshold: 100 });
    const result = await policy.check(makePayment({ amount: 200 }));
    const draftId = result.draftId!;
    expect(policy.approveDraft(draftId)).toBe(true);
    expect(policy.getPendingDrafts().length).toBe(0);
    const draft = policy.getAllDrafts().find((d) => d.draftId === draftId)!;
    expect(draft.approved).toBe(true);
  });
});

// ─── AuditTrail ───────────────────────────────────────────────────────────────

describe('AuditTrail', () => {
  it('creates an audit entry for every payment attempt', async () => {
    const policy = makePolicy({});
    await policy.check(makePayment({ amount: 10 }));
    await policy.check(makePayment({ amount: 20 }));
    const log = policy.getAuditLog();
    expect(log.length).toBe(2);
  });

  it('audit entry records merchant, amount, and status', async () => {
    const policy = makePolicy({ merchantAllowlist: ['0xgood'] });
    await policy.check(makePayment({ merchant: '0xBad', amount: 99 }));
    const entry = policy.getAuditLog()[0];
    expect(entry.merchant).toBe('0xBad');
    expect(entry.amount).toBe(99);
    expect(entry.status).toBe('rejected');
  });

  it('audit log is append-only (getAuditLog returns copy)', async () => {
    const policy = makePolicy({});
    await policy.check(makePayment());
    const log = policy.getAuditLog();
    log.push({ id: 'tamper', timestamp: '', merchant: '', amount: 0, status: 'approved' });
    // Original log should still have only 1 entry
    expect(policy.getAuditLog().length).toBe(1);
  });
});

// ─── FailClosed ───────────────────────────────────────────────────────────────

describe('FailClosed', () => {
  it('rejects payment when policy engine throws an error', async () => {
    const policy = makePolicy({ merchantAllowlist: ['0xgood'] });

    // Corrupt internal state to trigger an error inside _check
    // We spy on the private method by monkey-patching to throw
    const original = (policy as any)._check.bind(policy);
    (policy as any)._check = async () => {
      throw new Error('Simulated internal policy crash');
    };

    const result = await policy.check(makePayment());
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/fail-closed/i);

    // Restore
    (policy as any)._check = original;
  });
});

// ─── reserve / commit / release ──────────────────────────────────────────────

describe('SpendingPolicy reserve/commit/release', () => {
  const VALID_HASH =
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  it('releases a reservation and restores rolling-cap capacity', async () => {
    const policy = makePolicy({
      rollingCap: { maxAmount: 100, windowMs: 86_400_000 },
    });
    const reserved = await policy.reserve(makePayment({ amount: 80 }));
    expect(reserved.status).toBe('reserved');
    expect(reserved.reservation?.status).toBe('held');

    const blocked = await policy.reserve(makePayment({ amount: 30 }));
    expect(blocked.status).toBe('rejected');

    expect(policy.release(reserved.reservation!)).toBe(true);
    expect(reserved.reservation?.status).toBe('released');

    const retried = await policy.reserve(makePayment({ amount: 30 }));
    expect(retried.status).toBe('reserved');
  });

  it('commits a reservation and keeps capacity consumed', async () => {
    const policy = makePolicy({
      rollingCap: { maxAmount: 100, windowMs: 86_400_000 },
    });
    const reserved = await policy.reserve(makePayment({ amount: 80 }));
    expect(policy.commit(reserved.reservation!)).toBe(true);
    expect(reserved.reservation?.status).toBe('committed');

    const blocked = await policy.reserve(makePayment({ amount: 30 }));
    expect(blocked.status).toBe('rejected');
    expect(policy.release(reserved.reservation!)).toBe(false);
  });

  it('does not release a hold-unknown reservation, even twice', async () => {
    const policy = makePolicy({
      rollingCap: { maxAmount: 100, windowMs: 86_400_000 },
    });
    const reserved = await policy.reserve(makePayment({ amount: 80 }));
    const outcome = classifySpendAttempt({
      error: Object.assign(new Error('waitForTransactionReceipt timed out'), {
        txHash: VALID_HASH,
      }),
    });
    expect(outcome.status).toBe('hold-unknown');
    expect(outcome.retrySafe).toBe(false);

    expect(policy.applyOutcome(reserved.reservation!, outcome)).toBe(true);
    expect(reserved.reservation?.status).toBe('locked');
    expect(policy.release(reserved.reservation!)).toBe(false);
    expect(policy.release(reserved.reservation!)).toBe(false);

    const blocked = await policy.reserve(makePayment({ amount: 30 }));
    expect(blocked.status).toBe('rejected');
  });

  it('does not auto-unlock a hold-unknown reservation after the rolling window elapses', async () => {
    const policy = makePolicy({
      rollingCap: { maxAmount: 100, windowMs: 50 },
    });
    const reserved = await policy.reserve(makePayment({ amount: 80 }));
    policy.applyOutcome(
      reserved.reservation!,
      classifySpendAttempt({ txHash: VALID_HASH }),
    );
    expect(reserved.reservation?.status).toBe('locked');

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(policy.release(reserved.reservation!)).toBe(false);
    expect(reserved.reservation?.status).toBe('locked');
    expect((await policy.reserve(makePayment({ amount: 30 }))).status).toBe('rejected');
  });

  it('applies a settled outcome by committing the reservation', async () => {
    const policy = makePolicy({
      rollingCap: { maxAmount: 2_000_000, windowMs: 86_400_000 },
    });
    const reserved = await policy.reserve(makePayment({ amount: 1_000_000 }));
    const outcome = classifySpendAttempt({
      receipt: { status: 'success', transactionHash: VALID_HASH },
      txHash: VALID_HASH,
      amount: 1_000_000n,
    });
    expect(policy.applyOutcome(reserved.reservation!, outcome)).toBe(true);
    expect(reserved.reservation?.status).toBe('committed');
  });

  it('includes the 0.77% protocol fee in exact base units when configured', async () => {
    const principal = 1_000_000;
    const policy = makePolicy({
      includeProtocolFee: true,
      rollingCap: { maxAmount: 1_007_700, windowMs: 86_400_000 },
    });
    const reserved = await policy.reserve(makePayment({ amount: principal }));
    expect(reserved.status).toBe('reserved');
    expect(reserved.reservation?.principalAmount).toBe(principal);
    expect(reserved.reservation?.feeAmount).toBe(Number(x402ProtocolFeeAmount(BigInt(principal))));
    expect(reserved.reservation?.reservedAmount).toBe(Number(x402DebitAmount(BigInt(principal))));

    const over = await policy.reserve(makePayment({ amount: 1 }));
    expect(over.status).toBe('rejected');
  });

  it('keeps check() as reserve-then-commit for backward compatibility', async () => {
    const policy = makePolicy({
      rollingCap: { maxAmount: 100, windowMs: 86_400_000 },
    });
    const result = await policy.check(makePayment({ amount: 80 }));
    expect(result.status).toBe('approved');
    expect(result.reservationId).toBeTruthy();
    expect(policy.getReservation(result.reservationId!)?.status).toBe('committed');

    const blocked = await policy.reserve(makePayment({ amount: 30 }));
    expect(blocked.status).toBe('rejected');
  });

  it('can approve and reserve a stored over-cap draft instead of leaving a dead-end', async () => {
    const policy = makePolicy({
      rollingCap: { maxAmount: 50, windowMs: 86_400_000 },
      overCapBehavior: 'draft',
    });
    const drafted = await policy.reserve(makePayment({ amount: 80 }));
    expect(drafted.status).toBe('draft');
    expect(drafted.draftId).toBeTruthy();

    expect(policy.approveDraft(drafted.draftId!)).toBe(true);
    const reserved = await policy.reserveApprovedDraft(drafted.draftId!);
    expect(reserved.status).toBe('reserved');
    expect(reserved.reservation?.draftId).toBe(drafted.draftId);
    expect(reserved.reservation?.payment.amount).toBe(80);
  });

  it('single-flights concurrent reserves so only one claim consumes remaining cap', async () => {
    const policy = makePolicy({
      rollingCap: { maxAmount: 100, windowMs: 86_400_000 },
    });
    const [first, second] = await Promise.all([
      policy.reserve(makePayment({ amount: 80 })),
      policy.reserve(makePayment({ amount: 80 })),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(['rejected', 'reserved']);
    expect(policy.getHeldAmount()).toBe(80);
  });

  it('reuses an in-flight reservation for the same idempotency key', async () => {
    const policy = makePolicy({
      rollingCap: { maxAmount: 100, windowMs: 86_400_000 },
    });
    const payment = makePayment({ amount: 40, idempotencyKey: 'intent-1' });
    const first = await policy.reserve(payment);
    const second = await policy.reserve(payment);
    expect(first.status).toBe('reserved');
    expect(second.status).toBe('reserved');
    expect(second.reservation?.reservationId).toBe(first.reservation?.reservationId);
    expect(policy.getHeldAmount()).toBe(40);
  });

  it('rejects idempotency-key reuse when the payload differs', async () => {
    const policy = makePolicy({
      rollingCap: { maxAmount: 100, windowMs: 86_400_000 },
    });
    const first = await policy.reserve(makePayment({ amount: 40, idempotencyKey: 'intent-1' }));
    expect(first.status).toBe('reserved');
    const conflict = await policy.reserve(
      makePayment({ amount: 41, idempotencyKey: 'intent-1' }),
    );
    expect(conflict.status).toBe('rejected');
    expect(conflict.reason).toMatch(/idempotency/i);
  });
});
