import { describe, it, expect, vi } from 'vitest';
import { classifySpendAttempt, classifySpendError } from '../outcomes/index.js';
import { X402SettlementBacklogError, X402SettlementQueuedError } from '../x402/client.js';
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

  it('releases a confirmed agent-execution revert so the spend hold is not retained', async () => {
    const policy = makePolicy({
      rollingCap: { maxAmount: 100, windowMs: 86_400_000 },
    });
    const reserved = await policy.reserve(makePayment({ amount: 80 }));
    const outcome = classifySpendAttempt({
      error: Object.assign(new Error(`Agent execution reverted: ${VALID_HASH}`), {
        name: 'AgentExecutionError',
        txHash: VALID_HASH,
        executionStatus: 'reverted',
      }),
    });
    expect(outcome.status).toBe('released');
    expect(outcome.retrySafe).toBe(true);

    expect(policy.applyOutcome(reserved.reservation!, outcome)).toBe(true);
    expect(reserved.reservation?.status).toBe('released');

    const retried = await policy.reserve(makePayment({ amount: 80 }));
    expect(retried.status).toBe('reserved');
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

  it('does not reconcile an earlier unknown spend using a later no-hash rejection', async () => {
    const policy = makePolicy({ rollingCap: { maxAmount: 100, windowMs: 86_400_000 } });
    const payment = makePayment({ amount: 80, idempotencyKey: 'unresolved-intent' });
    const reserved = await policy.reserve(payment);
    policy.applyOutcome(reserved.reservation!, classifySpendAttempt({ txHash: VALID_HASH }));

    const rejectedAttempt = classifySpendAttempt({ error: new X402SettlementBacklogError(3) });
    expect(rejectedAttempt.status).toBe('released');
    expect(policy.applyOutcome(reserved.reservation!, rejectedAttempt)).toBe(false);
    expect(policy.getReservation(reserved.reservation!.reservationId)?.status).toBe('locked');
    expect((await policy.reserve(payment)).status).toBe('existing');
    expect((await policy.reserve(makePayment({ amount: 30 }))).status).toBe('rejected');
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

  it('keeps a queued spend locked beyond the rolling window after its outer receipt succeeds', async () => {
    vi.useFakeTimers();
    try {
      const policy = makePolicy({ rollingCap: { maxAmount: 100, windowMs: 50 } });
      const reserved = await policy.reserve(makePayment({ amount: 100, idempotencyKey: 'queued-intent' }));
      const queuedError = new X402SettlementQueuedError(VALID_HASH);
      expect(policy.applyOutcome(reserved.reservation!, classifySpendAttempt({ error: queuedError }))).toBe(true);
      expect(reserved.reservation?.status).toBe('locked');

      policy.applyOutcome(reserved.reservation!, classifySpendAttempt({
        error: queuedError,
        receipt: { status: 'success', transactionHash: VALID_HASH },
      }));
      vi.advanceTimersByTime(1_000);

      expect(reserved.reservation?.status).toBe('locked');
      expect(policy.getHeldAmount()).toBe(100);
      expect((await policy.reserve(makePayment({ amount: 100 }))).status).toBe('rejected');

      const executedHash = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const executedOutcome = classifySpendAttempt({
        receipt: { status: 'success', transactionHash: executedHash },
      });
      expect(executedOutcome.status).toBe('settled');
      expect(policy.applyOutcome(reserved.reservation!, executedOutcome)).toBe(true);
      expect(reserved.reservation?.status).toBe('committed');
    } finally {
      vi.useRealTimers();
    }
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

  it('joins an in-flight reservation without authorizing another execution', async () => {
    const policy = makePolicy({
      rollingCap: { maxAmount: 100, windowMs: 86_400_000 },
    });
    const payment = makePayment({ amount: 40, idempotencyKey: 'intent-1' });
    const first = await policy.reserve(payment);
    const second = await policy.reserve(payment);
    expect(first.status).toBe('reserved');
    expect(second.status).toBe('existing');
    expect(second.reservation?.reservationId).toBe(first.reservation?.reservationId);
    expect(policy.getHeldAmount()).toBe(40);
  });

  it('grants one executable claim to concurrent reserves for the same intent', async () => {
    const policy = makePolicy({ rollingCap: { maxAmount: 100, windowMs: 86_400_000 } });
    const payment = makePayment({ amount: 80, idempotencyKey: 'concurrent-intent' });
    const results = await Promise.all([policy.reserve(payment), policy.reserve(payment)]);

    expect(results.map((result) => result.status).sort()).toEqual(['existing', 'reserved']);
    expect(results[0].reservation?.reservationId).toBe(results[1].reservation?.reservationId);
    expect(policy.getHeldAmount()).toBe(80);
  });

  it.each(['held', 'locked', 'committed'] as const)(
    'does not make an existing %s idempotent reservation executable',
    async (state) => {
      const policy = makePolicy({});
      const payment = makePayment({ idempotencyKey: `state-${state}` });
      const first = await policy.reserve(payment);
      if (state === 'locked') policy.lock(first.reservation!);
      if (state === 'committed') policy.commit(first.reservation!);

      const repeated = await policy.reserve(payment);
      expect(repeated.status).toBe('existing');
      expect(repeated.reservation?.reservationId).toBe(first.reservation?.reservationId);
      expect(repeated.reservation?.status).toBe(state);
    },
  );

  it.each(['held', 'locked', 'committed'] as const)(
    'check() refuses an existing %s reservation without changing its state',
    async (state) => {
      const policy = makePolicy({ rollingCap: { maxAmount: 100, windowMs: 86_400_000 } });
      const payment = makePayment({ amount: 80, idempotencyKey: `checked-${state}` });
      const first = await policy.reserve(payment);
      if (state === 'locked') policy.lock(first.reservation!);
      if (state === 'committed') policy.commit(first.reservation!);

      expect((await policy.check(payment)).status).toBe('rejected');
      expect(policy.getReservation(first.reservation!.reservationId)?.status).toBe(state);
      expect((await policy.reserve(makePayment({ amount: 30 }))).status).toBe('rejected');
    },
  );

  it.each(['held', 'locked'] as const)(
    'keeps a %s reservation occupied after the rolling window expires',
    async (state) => {
      vi.useFakeTimers();
      try {
        const policy = makePolicy({ rollingCap: { maxAmount: 100, windowMs: 50 } });
        const payment = makePayment({ amount: 80, idempotencyKey: `expired-${state}` });
        const first = await policy.reserve(payment);
        if (state === 'locked') policy.lock(first.reservation!);
        vi.advanceTimersByTime(1_000);

        expect((await policy.reserve(payment)).status).toBe('existing');
        expect(policy.getReservation(first.reservation!.reservationId)?.status).toBe(state);
        expect(policy.getHeldAmount()).toBe(80);
        expect((await policy.reserve(makePayment({ amount: 30 }))).status).toBe('rejected');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('keeps a committed idempotency key consumed after its spend ages out of the cap', async () => {
    vi.useFakeTimers();
    try {
      const policy = makePolicy({ rollingCap: { maxAmount: 100, windowMs: 50 } });
      const payment = makePayment({ amount: 80, idempotencyKey: 'settled-intent' });
      const first = await policy.reserve(payment);
      policy.commit(first.reservation!);
      vi.advanceTimersByTime(1_000);

      expect((await policy.reserve(payment)).status).toBe('existing');
      expect((await policy.reserve(makePayment({ amount: 80 }))).status).toBe('reserved');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['held', 'locked', 'committed'] as const)(
    'binds an over-cap draft approval to its %s reservation',
    async (state) => {
      const policy = makePolicy({
        rollingCap: { maxAmount: 50, windowMs: 86_400_000 },
        overCapBehavior: 'draft',
      });
      const draft = await policy.reserve(makePayment({ amount: 80 }));
      policy.approveDraft(draft.draftId!);
      const first = await policy.reserveApprovedDraft(draft.draftId!);
      if (state === 'locked') policy.lock(first.reservation!);
      if (state === 'committed') policy.commit(first.reservation!);

      const repeated = await policy.reserveApprovedDraft(draft.draftId!);
      expect(repeated.status).toBe('existing');
      expect(repeated.reservation?.reservationId).toBe(first.reservation?.reservationId);
      expect(policy.getHeldAmount()).toBe(state === 'committed' ? 0 : 80);
    },
  );

  it('atomically claims an approved draft when callers reserve concurrently', async () => {
    const policy = makePolicy({
      rollingCap: { maxAmount: 50, windowMs: 86_400_000 },
      overCapBehavior: 'draft',
    });
    const draft = await policy.reserve(makePayment({ amount: 80 }));
    policy.approveDraft(draft.draftId!);

    const results = await Promise.all([
      policy.reserveApprovedDraft(draft.draftId!),
      policy.reserveApprovedDraft(draft.draftId!),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['existing', 'reserved']);
    expect(results[0].reservation?.reservationId).toBe(results[1].reservation?.reservationId);
    expect(policy.getHeldAmount()).toBe(80);
  });

  it('retries an approved draft once after a confirmed revert releases its previous claim', async () => {
    const policy = makePolicy({
      rollingCap: { maxAmount: 50, windowMs: 86_400_000 },
      overCapBehavior: 'draft',
    });
    const draft = await policy.reserve(makePayment({ amount: 80 }));
    policy.approveDraft(draft.draftId!);
    const first = await policy.reserveApprovedDraft(draft.draftId!);
    const call = { from: '0x' + '1'.repeat(40), to: '0x' + '2'.repeat(40), data: '0xa9059cbb' };
    policy.lock(first.reservation!, { chainId: 8453, txHashes: [VALID_HASH], ...call });
    expect(policy.release(first.reservation!)).toBe(false);
    expect((await policy.reserveApprovedDraft(draft.draftId!)).status).toBe('existing');

    // A structural "released" outcome can no longer unlock a locked claim.
    expect(policy.applyOutcome(first.reservation!, classifySpendAttempt({
      receipt: { status: 'reverted', transactionHash: VALID_HASH },
    }))).toBe(false);
    const reconciled = await policy.reconcileLocked(first.reservation!, {
      getChainId: async () => 8453,
      getTransactionReceipt: async ({ hash }) => ({ transactionHash: hash, status: 'reverted' }),
      getTransaction: async ({ hash }) => ({ hash, from: call.from, to: call.to, input: call.data }),
    });
    expect(reconciled.status).toBe('released');
    const retry = await policy.reserveApprovedDraft(draft.draftId!);
    expect(retry.status).toBe('reserved');
    expect(retry.reservation?.reservationId).not.toBe(first.reservation?.reservationId);
    expect((await policy.reserveApprovedDraft(draft.draftId!)).status).toBe('existing');
    expect(policy.getHeldAmount()).toBe(80);
  });

  it('does not let a caller mutate a reservation into a released authorization', async () => {
    const policy = makePolicy({ rollingCap: { maxAmount: 100, windowMs: 86_400_000 } });
    const payment = makePayment({ amount: 80, idempotencyKey: 'immutable-claim' });
    const first = await policy.reserve(payment);
    try { first.reservation!.status = 'released'; } catch { /* a readonly view may throw */ }
    try { first.reservation!.reservedAmount = 0; } catch { /* a readonly view may throw */ }
    try { first.reservation!.payment.amount = 1; } catch { /* a readonly view may throw */ }

    expect(policy.getReservation(first.reservation!.reservationId)?.status).toBe('held');
    expect(policy.getHeldAmount()).toBe(80);
    expect((await policy.reserve(payment)).status).toBe('existing');
    expect((await policy.reserve(makePayment({ amount: 30 }))).status).toBe('rejected');
  });

  it('keeps reservation status observable through a protected view', async () => {
    const policy = makePolicy({});
    const first = await policy.reserve(makePayment());
    expect(policy.lock(first.reservation!)).toBe(true);
    expect(first.reservation?.status).toBe('locked');
    expect(policy.commit(first.reservation!)).toBe(true);
    expect(first.reservation?.status).toBe('committed');
  });

  it('does not allow draft readers to alter approval or the approved amount', async () => {
    const policy = makePolicy({ draftThreshold: 50 });
    const drafted = await policy.reserve(makePayment({ amount: 80 }));
    const pending = policy.getPendingDrafts()[0];
    pending.approved = true;
    pending.payment.amount = 1;
    expect((await policy.reserveApprovedDraft(drafted.draftId!)).status).toBe('rejected');

    policy.approveDraft(drafted.draftId!);
    const approved = policy.getAllDrafts()[0];
    approved.payment.amount = 1;
    const reserved = await policy.reserveApprovedDraft(drafted.draftId!);
    expect(reserved.status).toBe('reserved');
    expect(reserved.reservation?.principalAmount).toBe(80);
  });

  it('does not change reservations owned by another policy instance', async () => {
    const owner = makePolicy({});
    const observer = makePolicy({});
    const first = await owner.reserve(makePayment());

    expect(observer.commit(first.reservation!)).toBe(false);
    expect(observer.release(first.reservation!)).toBe(false);
    expect(observer.lock(first.reservation!)).toBe(false);
    expect(owner.getReservation(first.reservation!.reservationId)?.status).toBe('held');
    expect(owner.getHeldAmount()).toBe(10);
    expect(observer.getHeldAmount()).toBe(0);
  });

  it('allows a released intent to retry while preserving its original terms', async () => {
    const policy = makePolicy({});
    const payment = makePayment({ amount: 40, idempotencyKey: 'released-intent' });
    const first = await policy.reserve(payment);
    policy.release(first.reservation!);

    const conflict = await policy.reserve({ ...payment, amount: 41 });
    expect(conflict.status).toBe('rejected');
    const retry = await policy.reserve(payment);
    expect(retry.status).toBe('reserved');
    expect(retry.reservation?.reservationId).not.toBe(first.reservation?.reservationId);
    expect(policy.getHeldAmount()).toBe(40);
  });

  it('rejects different intent terms even when field separators produce the same text', async () => {
    const policy = makePolicy({});
    const payment = makePayment({ merchant: 'merchant', amount: 10, description: '1|20|', idempotencyKey: 'terms-key' });
    const first = await policy.reserve(payment);
    policy.release(first.reservation!);

    const conflict = await policy.reserve(makePayment({
      merchant: 'merchant|10|1', amount: 20, description: '', idempotencyKey: 'terms-key',
    }));
    expect(conflict.status).toBe('rejected');
    expect(policy.getHeldAmount()).toBe(0);
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


describe('SpendingPolicy intent snapshot (finding 2)', () => {
  it('validates and stores the same terms even when getters change between reads', async () => {
    const policy = new SpendingPolicy({
      merchantAllowlist: ['good.example'],
      rollingCap: { maxAmount: 100, windowMs: 86_400_000 },
      draftThreshold: 90,
    });
    let merchantReads = 0;
    let amountReads = 0;
    const tricky = {
      get merchant() { return merchantReads++ === 0 ? 'good.example' : 'evil.example'; },
      get amount() { return amountReads++ === 0 ? 10 : 1_000_000; },
    } as PaymentIntent;
    const result = await policy.reserve(tricky);
    expect(result.status).toBe('reserved');
    expect(merchantReads).toBe(1);
    expect(amountReads).toBe(1);
    expect(result.reservation?.payment.merchant).toBe('good.example');
    expect(result.reservation?.payment.amount).toBe(10);
    expect(result.reservation?.reservedAmount).toBe(10);
    expect(Object.isFrozen(result.reservation?.payment)).toBe(true);
  });

  it('reads Proxy-backed intents once per field', async () => {
    const policy = new SpendingPolicy({ merchantAllowlist: ['good.example'] });
    const reads: Record<string, number> = {};
    const proxy = new Proxy({ merchant: 'good.example', amount: 5 }, {
      get(target, key: string) {
        reads[key] = (reads[key] ?? 0) + 1;
        return reads[key] > 1 && key === 'merchant' ? 'evil.example' : (target as any)[key];
      },
    }) as PaymentIntent;
    const result = await policy.check(proxy);
    expect(result.status).toBe('approved');
    expect(reads.merchant).toBe(1);
    expect(policy.getAuditLog().every((e) => e.merchant === 'good.example')).toBe(true);
  });

  it('rejects non-primitive intent fields fail-closed', async () => {
    const policy = new SpendingPolicy({});
    const bad = { merchant: { toLowerCase: () => 'x' }, amount: 1 } as unknown as PaymentIntent;
    expect((await policy.reserve(bad)).status).toBe('rejected');
    expect((await policy.check({ merchant: 'm', amount: '5' as unknown as number })).status).toBe('rejected');
  });
});

describe('SpendingPolicy locked reconciliation (finding 8)', () => {
  const HASH_A = ('0x' + 'a'.repeat(64)) as `0x${string}`;
  const HASH_B = ('0x' + 'b'.repeat(64)) as `0x${string}`;
  const CALL = { from: '0x' + '1'.repeat(40), to: '0x' + '2'.repeat(40), data: '0xa9059cbb' };
  const client = (
    status: string | number, chainId = 8453, echo?: string,
    tx: { hash?: string; from?: string; to: string; input: string } = { from: CALL.from, to: CALL.to, input: CALL.data },
  ) => ({
    getChainId: async () => chainId,
    getTransactionReceipt: async ({ hash }: { hash: string }) => ({ transactionHash: echo ?? hash, status }),
    getTransaction: async ({ hash }: { hash: string }) => ({ hash, ...tx }),
  });

  async function lockedPolicy(hashes: string[] = [HASH_A]) {
    const policy = new SpendingPolicy({ rollingCap: { maxAmount: 100, windowMs: 86_400_000 } });
    const r = await policy.reserve({ merchant: 'm', amount: 80 });
    policy.lock(r.reservation!, { chainId: 8453, txHashes: hashes, ...CALL });
    return { policy, reservation: r.reservation! };
  }

  it('has no boolean override: release() never unlocks a locked reservation', async () => {
    const { policy, reservation } = await lockedPolicy();
    expect((policy.release as any)(reservation, { reconciled: true })).toBe(false);
    expect(policy.getHeldAmount()).toBe(80);
  });

  it('ignores a structural released outcome carrying an unrelated valid-looking hash', async () => {
    const { policy, reservation } = await lockedPolicy();
    const forged = { status: 'released', retrySafe: true, txHashes: [HASH_B] } as const;
    expect(policy.applyOutcome(reservation, forged as any)).toBe(false);
    expect(policy.getReservation(reservation.reservationId)?.status).toBe('locked');
  });

  it('releases only when the recorded hash reverted on the recorded chain', async () => {
    const { policy, reservation } = await lockedPolicy();
    expect((await policy.reconcileLocked(reservation, client('reverted', 1))).status).toBe('unresolved');
    expect((await policy.reconcileLocked(reservation, client('reverted', 8453, HASH_B))).status).toBe('unresolved');
    expect((await policy.reconcileLocked(reservation, client('reverted'))).status).toBe('released');
    expect(policy.getHeldAmount()).toBe(0);
  });

  it('commits when the recorded submission actually succeeded', async () => {
    const { policy, reservation } = await lockedPolicy();
    expect((await policy.reconcileLocked(reservation, client('success'))).status).toBe('committed');
    expect((await policy.reserve({ merchant: 'm', amount: 30 })).status).toBe('rejected');
  });

  it('never attaches hashes to an existing lock (identity is immutable)', async () => {
    const policy = new SpendingPolicy({});
    const r = await policy.reserve({ merchant: 'm', amount: 1 });
    policy.lock(r.reservation!);
    expect((await policy.reconcileLocked(r.reservation!, client('reverted'))).status).toBe('unresolved');
    expect(policy.lock(r.reservation!, { chainId: 8453, txHashes: [HASH_A], ...CALL })).toBe(false);
    expect(policy.getReservation(r.reservation!.reservationId)?.submission?.txHashes).toEqual([]);
  });

  it('cannot release from an outcome that carries unrelated hashes but no call binding (review follow-up)', async () => {
    const policy = new SpendingPolicy({ rollingCap: { maxAmount: 100, windowMs: 86_400_000 } });
    const r = await policy.reserve({ merchant: 'm', amount: 100 });
    policy.applyOutcome(r.reservation!, { status: 'hold-unknown', retrySafe: false, txHashes: [HASH_B], chainId: 8453 });
    const res = await policy.reconcileLocked(r.reservation!, client('reverted'));
    expect(res.status).toBe('unresolved');
    expect(res.reason).toMatch(/call binding/);
    expect((await policy.reserve({ merchant: 'm', amount: 100 })).status).toBe('rejected');
  });

  it('releases an applyOutcome lock only when the supplied call binding matches', async () => {
    const policy = new SpendingPolicy({});
    const r = await policy.reserve({ merchant: 'm', amount: 1 });
    policy.applyOutcome(r.reservation!, { status: 'hold-unknown', retrySafe: false, txHashes: [HASH_A], chainId: 8453 }, CALL);
    expect((await policy.reconcileLocked(r.reservation!, client('reverted', 8453, undefined, { from: CALL.from, to: CALL.to, input: '0xdead' }))).status).toBe('unresolved');
    expect((await policy.reconcileLocked(r.reservation!, client('reverted'))).status).toBe('released');
  });

  describe('multi-phase submissions bind each hash to its own call (Codex P2)', () => {
    const FEE = { hash: HASH_A, from: CALL.from, to: CALL.to, data: '0xfee0' };
    const PAYEE = { hash: HASH_B, from: CALL.from, to: CALL.to, data: '0xbee0' };
    const txFor = (map: Record<string, { from: string; to: string; input: string }>) => ({
      getChainId: async () => 8453,
      getTransactionReceipt: async ({ hash }: { hash: string }) => ({ transactionHash: hash, status: 'reverted' }),
      getTransaction: async ({ hash }: { hash: string }) => (map[hash.toLowerCase()] ? { hash, ...map[hash.toLowerCase()] } : undefined),
    });
    const honest = { [HASH_A]: { from: CALL.from, to: CALL.to, input: '0xfee0' }, [HASH_B]: { from: CALL.from, to: CALL.to, input: '0xbee0' } };

    async function twoPhase(calls: Array<typeof FEE>) {
      const policy = new SpendingPolicy({ rollingCap: { maxAmount: 100, windowMs: 86_400_000 } });
      const r = await policy.reserve({ merchant: 'm', amount: 80 });
      policy.applyOutcome(r.reservation!, { status: 'hold-unknown', retrySafe: false, txHashes: [], chainId: 8453 }, { calls });
      return { policy, reservation: r.reservation! };
    }

    it('records every phase hash and releases when both differing-calldata phases reverted', async () => {
      const { policy, reservation } = await twoPhase([FEE, PAYEE]);
      expect(policy.getReservation(reservation.reservationId)?.submission?.txHashes).toEqual([HASH_A, HASH_B]);
      expect((await policy.reconcileLocked(reservation, txFor(honest))).status).toBe('released');
      expect(policy.getHeldAmount()).toBe(0);
    });

    it('refuses when a phase hash carries the other phase\'s calldata', async () => {
      const { policy, reservation } = await twoPhase([FEE, PAYEE]);
      const swapped = { [HASH_A]: honest[HASH_B], [HASH_B]: honest[HASH_A] };
      expect((await policy.reconcileLocked(reservation, txFor(swapped))).status).toBe('unresolved');
      expect(policy.getHeldAmount()).toBe(80);
    });

    it('makes a hash with conflicting bindings unprovable', async () => {
      const { policy, reservation } = await twoPhase([FEE, { ...FEE, data: '0xbee0' }]);
      expect((await policy.reconcileLocked(reservation, txFor(honest))).status).toBe('unresolved');
      expect(policy.getHeldAmount()).toBe(80);
    });

    it('commits when any phase succeeded', async () => {
      const { policy, reservation } = await twoPhase([FEE, PAYEE]);
      const c = { ...txFor(honest), getTransactionReceipt: async ({ hash }: { hash: string }) => ({ transactionHash: hash, status: hash === HASH_B ? 'success' : 'reverted' }) };
      expect((await policy.reconcileLocked(reservation, c)).status).toBe('committed');
    });
  });

  it('verifies the recorded call binding when present', async () => {
    const policy = new SpendingPolicy({});
    const r = await policy.reserve({ merchant: 'm', amount: 1 });
    policy.lock(r.reservation!, { chainId: 8453, txHashes: [HASH_A], to: '0x' + '1'.repeat(40), data: '0xabcd' });
    const c = {
      ...client('reverted'),
      getTransaction: async ({ hash }: { hash: string }) => ({ hash, to: '0x' + '2'.repeat(40), input: '0xabcd' }),
    };
    expect((await policy.reconcileLocked(r.reservation!, c)).status).toBe('unresolved');
  });

  describe('the returned transaction body must be the requested hash (Codex round 9)', () => {
    it.each([
      ['a different hash', HASH_B],
      ['no hash', undefined],
      ['a malformed hash', 'not-a-hash'],
    ])('refuses to release when getTransaction returns %s with a matching call', async (_label, returned) => {
      const { policy, reservation } = await lockedPolicy();
      const c = { ...client('reverted'), getTransaction: async () => ({ hash: returned, from: CALL.from, to: CALL.to, input: CALL.data }) };
      const res = await policy.reconcileLocked(reservation, c);
      expect(res.status).toBe('unresolved');
      expect(res.reason).toMatch(/does not match the recorded call/);
      expect(policy.getHeldAmount()).toBe(80);
    });

    it('refuses to commit on a substituted body too', async () => {
      const { policy, reservation } = await lockedPolicy();
      const c = { ...client('success'), getTransaction: async () => ({ hash: HASH_B, from: CALL.from, to: CALL.to, input: CALL.data }) };
      expect((await policy.reconcileLocked(reservation, c)).status).toBe('unresolved');
      expect(policy.getReservation(reservation.reservationId)?.status).toBe('locked');
    });

    it('accepts the requested hash in any case', async () => {
      const { policy, reservation } = await lockedPolicy();
      const c = { ...client('reverted'), getTransaction: async ({ hash }: { hash: string }) => ({ hash: hash.toUpperCase().replace('0X', '0x'), from: CALL.from, to: CALL.to, input: CALL.data }) };
      expect((await policy.reconcileLocked(reservation, c)).status).toBe('released');
    });
  });
});

describe('incomplete hash evidence never releases a lock (Codex round 10)', () => {
  const HASH_A = ('0x' + 'a'.repeat(64)) as `0x${string}`;
  const HASH_B = ('0x' + 'b'.repeat(64)) as `0x${string}`;
  const CALL = { from: '0x' + '1'.repeat(40), to: '0x' + '2'.repeat(40), data: '0xa9059cbb' };
  const chain = (status: (hash: string) => string) => ({
    getChainId: async () => 8453,
    getTransactionReceipt: async ({ hash }: { hash: string }) => ({ transactionHash: hash, status: status(hash) }),
    getTransaction: async ({ hash }: { hash: string }) => ({ hash, from: CALL.from, to: CALL.to, input: CALL.data }),
  });
  const reverted = chain(() => 'reverted');

  async function held() {
    const policy = new SpendingPolicy({ rollingCap: { maxAmount: 100, windowMs: 86_400_000 } });
    const r = await policy.reserve({ merchant: 'm', amount: 80 });
    return { policy, reservation: r.reservation! };
  }

  it.each([
    ['a malformed second phase', [HASH_A, '0xabc123']],
    ['an empty second phase', [HASH_A, '']],
  ])('keeps a hold-unknown outcome with %s locked when the recorded hash reverted', async (_label, txHashes) => {
    const { policy, reservation } = await held();
    policy.applyOutcome(reservation, { status: 'hold-unknown', retrySafe: false, txHashes: txHashes as string[], chainId: 8453 }, CALL);
    expect(policy.getReservation(reservation.reservationId)?.submission?.incomplete).toBe(true);
    const res = await policy.reconcileLocked(reservation, reverted);
    expect(res.status).toBe('unresolved');
    expect(res.reason).toMatch(/no usable transaction hash/);
    expect(policy.getHeldAmount()).toBe(80);
  });

  it('carries the classifier\'s dropped-hash evidence into the lock', async () => {
    // Fee hash valid, payee hash garbled by the RPC: the classifier keeps only
    // the valid hash, so the outcome must say the evidence is incomplete.
    const err = Object.assign(new Error('payee submission failed'), { name: 'Error', feeTxHash: HASH_A, txHash: '0xnot-a-hash', chainId: 8453 });
    const outcome = classifySpendError(err);
    expect(outcome.status).toBe('hold-unknown');
    expect(outcome.txHashes).toEqual([HASH_A]);
    expect(outcome.incompleteEvidence).toBe(true);
    const { policy, reservation } = await held();
    policy.applyOutcome(reservation, outcome, CALL);
    expect((await policy.reconcileLocked(reservation, reverted)).status).toBe('unresolved');
    expect(policy.getHeldAmount()).toBe(80);
  });

  it('marks classifySpendAttempt outcomes with a dropped hash', () => {
    const o = classifySpendAttempt({ receipt: { status: 'success', transactionHash: HASH_A }, txHashes: ['0xabc123'], chainId: 8453 });
    expect(o.status).toBe('hold-unknown');
    expect(o.incompleteEvidence).toBe(true);
    expect(classifySpendAttempt({ receipt: { status: 'success', transactionHash: HASH_A }, chainId: 8453 }).incompleteEvidence).toBeUndefined();
  });

  it('keeps a per-phase call without a usable hash or binding locked', async () => {
    for (const bad of [{ ...CALL, hash: 'pending' }, { ...CALL, hash: HASH_B, data: undefined as unknown as string }]) {
      const { policy, reservation } = await held();
      policy.applyOutcome(reservation, { status: 'hold-unknown', retrySafe: false, txHashes: [], chainId: 8453 }, {
        calls: [{ hash: HASH_A, ...CALL }, bad],
      });
      expect((await policy.reconcileLocked(reservation, reverted)).status).toBe('unresolved');
      expect(policy.getHeldAmount()).toBe(80);
    }
  });

  it('honors an explicit incomplete flag on lock()', async () => {
    const { policy, reservation } = await held();
    policy.lock(reservation, { chainId: 8453, txHashes: [HASH_A], incomplete: true, ...CALL });
    expect((await policy.reconcileLocked(reservation, reverted)).status).toBe('unresolved');
  });

  it('still commits incomplete evidence when a recorded hash succeeded', async () => {
    const { policy, reservation } = await held();
    policy.applyOutcome(reservation, { status: 'hold-unknown', retrySafe: false, txHashes: [HASH_A, ''], chainId: 8453 }, CALL);
    expect((await policy.reconcileLocked(reservation, chain(() => 'success'))).status).toBe('committed');
  });

  it('still releases complete evidence when every hash reverted', async () => {
    const { policy, reservation } = await held();
    policy.applyOutcome(reservation, { status: 'hold-unknown', retrySafe: false, txHashes: [HASH_A], chainId: 8453 }, CALL);
    expect(policy.getReservation(reservation.reservationId)?.submission?.incomplete).toBeUndefined();
    expect((await policy.reconcileLocked(reservation, reverted)).status).toBe('released');
  });
});
