import { describe, it, expect } from 'vitest';
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
