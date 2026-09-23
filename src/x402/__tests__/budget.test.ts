// [MAX-ADDED] Tests for x402 Budget Tracker
import { describe, it, expect, beforeEach } from 'vitest';
import { X402BudgetTracker } from '../budget.js';
import type { X402TransactionLog } from '../types.js';

describe('X402BudgetTracker', () => {
  let tracker: X402BudgetTracker;

  beforeEach(() => {
    tracker = new X402BudgetTracker({
      globalDailyLimit: 100_000_000n, // 100 USDC
      globalPerRequestMax: 10_000_000n, // 10 USDC
      serviceBudgets: [
        { service: 'api.example.com', maxPerRequest: 5_000_000n, dailyLimit: 50_000_000n },
        { service: '*', maxPerRequest: 2_000_000n, dailyLimit: 20_000_000n },
      ],
    });
  });

  it('allows payments within limits', () => {
    const result = tracker.checkBudget('api.example.com', 1_000_000n);
    expect(result.allowed).toBe(true);
  });

  it('rejects payments exceeding global per-request max', () => {
    const result = tracker.checkBudget('api.example.com', 15_000_000n);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('global per-request max');
  });

  it('rejects payments exceeding service per-request max', () => {
    const result = tracker.checkBudget('api.example.com', 6_000_000n);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('service per-request max');
  });

  it('uses wildcard budget for unknown services', () => {
    const result = tracker.checkBudget('unknown.com', 3_000_000n);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('service per-request max');
  });

  it('tracks daily spending per service', () => {
    const log: X402TransactionLog = {
      timestamp: Math.floor(Date.now() / 1000),
      service: 'api.example.com',
      url: 'https://api.example.com/data',
      amount: 4_000_000n,
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
      recipient: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
      txHash: '0xabc123' as `0x${string}`,
      network: 'base:8453',
      scheme: 'exact',
      success: true,
    };

    tracker.recordPayment(log);

    const summary = tracker.getDailySpendSummary();
    expect(summary.global).toBe(4_000_000n);
    expect(summary.byService['api.example.com']).toBe(4_000_000n);
  });

  it('rejects when daily limit would be exceeded', () => {
    // Spend 48 USDC
    for (let i = 0; i < 12; i++) {
      tracker.recordPayment({
        timestamp: Math.floor(Date.now() / 1000),
        service: 'api.example.com',
        url: 'https://api.example.com/data',
        amount: 4_000_000n,
        token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
        recipient: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
        txHash: '0xabc123' as `0x${string}`,
        network: 'base:8453',
        scheme: 'exact',
        success: true,
      });
    }

    // Next 4 USDC would exceed 50 USDC service daily limit
    const result = tracker.checkBudget('api.example.com', 4_000_000n);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('daily limit');
  });

  it('returns transaction log with filters', () => {
    const now = Math.floor(Date.now() / 1000);
    tracker.recordPayment({
      timestamp: now - 100,
      service: 'api.example.com',
      url: 'https://api.example.com/a',
      amount: 1_000_000n,
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
      recipient: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
      txHash: '0xaaa' as `0x${string}`,
      network: 'base:8453',
      scheme: 'exact',
      success: true,
    });
    tracker.recordPayment({
      timestamp: now,
      service: 'other.com',
      url: 'https://other.com/b',
      amount: 500_000n,
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
      recipient: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
      txHash: '0xbbb' as `0x${string}`,
      network: 'base:8453',
      scheme: 'exact',
      success: true,
    });

    expect(tracker.getTransactionLog()).toHaveLength(2);
    expect(tracker.getTransactionLog({ service: 'other.com' })).toHaveLength(1);
    expect(tracker.getTransactionLog({ since: now - 50 })).toHaveLength(1);
  });

  it('allows runtime budget updates', () => {
    tracker.setServiceBudget({
      service: 'new-api.com',
      maxPerRequest: 1_000_000n,
      dailyLimit: 5_000_000n,
    });

    expect(tracker.checkBudget('new-api.com', 500_000n).allowed).toBe(true);
    expect(tracker.checkBudget('new-api.com', 2_000_000n).allowed).toBe(false);
  });

  function reservedLog(amount: bigint, service = 'api.example.com'): X402TransactionLog {
    return {
      timestamp: Math.floor(Date.now() / 1000),
      service,
      url: `https://${service}/data`,
      amount,
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
      recipient: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
      txHash: '0xabc123' as `0x${string}`,
      network: 'base:8453',
      scheme: 'exact',
      success: true,
    };
  }

  it('counts reserved spend against daily limits before recordPayment', () => {
    const reservationId = tracker.reserve('api.example.com', 48_000_000n);
    const blocked = tracker.checkBudget('api.example.com', 4_000_000n);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('daily limit');

    tracker.recordPayment(reservedLog(48_000_000n), { reserved: true });
    expect(tracker.settle(reservationId)).toBe(true);

    expect(tracker.getDailySpendSummary().global).toBe(48_000_000n);
    expect(tracker.getDailySpendSummary().byService['api.example.com']).toBe(48_000_000n);
    expect(tracker.getReservedSummary().global).toBe(0n);
  });

  it('keeps a retained fee when the rest of a reservation is released', () => {
    const tight = new X402BudgetTracker({ globalDailyLimit: 1_007_700n });
    const reservationId = tight.reserve('api.example.com', 1_007_700n);
    expect(tight.releaseExcept(reservationId, 2_000_000n)).toBe(false);
    expect(tight.getDailySpendSummary().global).toBe(1_007_700n);
    expect(tight.getReservedSummary().global).toBe(1_007_700n);

    expect(tight.releaseExcept(reservationId, 7_700n)).toBe(true);
    expect(tight.releaseExcept(reservationId, 7_700n)).toBe(false);
    expect(tight.getReservedSummary().global).toBe(0n);
    expect(tight.getDailySpendSummary().global).toBe(7_700n);
    expect(tight.getDailySpendSummary().byService['api.example.com']).toBe(7_700n);
    expect(tight.checkBudget('api.example.com', 1_000_000n).allowed).toBe(true);
    expect(tight.checkBudget('api.example.com', 1_000_001n).allowed).toBe(false);
  });

  it('releases a reservation when settlement reverts', () => {
    const reservationId = tracker.reserve('api.example.com', 4_000_000n);
    expect(tracker.getDailySpendSummary().global).toBe(4_000_000n);
    expect(tracker.release(reservationId)).toBe(true);
    expect(tracker.getDailySpendSummary().global).toBe(0n);
    expect(tracker.checkBudget('api.example.com', 4_000_000n).allowed).toBe(true);
  });

  it('releases a reservation at most once even with concurrent observers', () => {
    tracker.recordPayment(reservedLog(3_000_000n, 'other.example.com'));
    const reservationId = tracker.reserve('api.example.com', 4_000_000n);
    expect(tracker.getDailySpendSummary().global).toBe(7_000_000n);

    expect(tracker.release(reservationId)).toBe(true);
    expect(tracker.release(reservationId)).toBe(false);
    expect(tracker.settle(reservationId)).toBe(false);

    expect(tracker.getDailySpendSummary().global).toBe(3_000_000n);
    expect(tracker.getDailySpendSummary().byService['other.example.com']).toBe(3_000_000n);
    expect(tracker.getDailySpendSummary().byService['api.example.com']).toBe(0n);
  });

  it('only releases the reservation that belongs to the reverted payment', () => {
    const pending = tracker.reserve('api.example.com', 10_000_000n);
    const unkeyed = tracker.reserve('api.example.com', 5_000_000n);
    tracker.recordPayment(reservedLog(5_000_000n), { reserved: true });
    tracker.settle(unkeyed);
    expect(tracker.getDailySpendSummary().byService['api.example.com']).toBe(15_000_000n);

    tracker.release(pending);
    expect(tracker.getDailySpendSummary().byService['api.example.com']).toBe(5_000_000n);
    expect(tracker.getDailySpendSummary().global).toBe(5_000_000n);
  });

  it('carries a still-pending reservation into the new budget day', () => {
    const realNow = Date.now;
    try {
      const dayStart = Math.floor(realNow() / 86_400_000) * 86_400_000;
      Date.now = () => dayStart + 60_000;
      const tracker2 = new X402BudgetTracker({ globalDailyLimit: 5_000_000n });
      const pending = tracker2.reserve('api.example.com', 4_000_000n);
      const settledYesterday = tracker2.reserve('api.example.com', 1_000_000n);
      tracker2.settle(settledYesterday);

      // Rollover: the settled spend is gone, the pending payment still counts.
      Date.now = () => dayStart + 86_400_000 + 60_000;
      expect(tracker2.getDailySpendSummary().global).toBe(4_000_000n);
      expect(tracker2.getDailySpendSummary().byService['api.example.com']).toBe(4_000_000n);
      expect(tracker2.checkBudget('api.example.com', 2_000_000n).allowed).toBe(false);
      expect(tracker2.checkBudget('api.example.com', 1_000_000n).allowed).toBe(true);

      // It settles into today's totals without being added twice ...
      tracker2.recordPayment(reservedLog(4_000_000n), { reserved: true });
      expect(tracker2.settle(pending)).toBe(true);
      expect(tracker2.getDailySpendSummary().global).toBe(4_000_000n);
      expect(tracker2.getReservedSummary().global).toBe(0n);
    } finally {
      Date.now = realNow;
    }
  });

  it('releases a carried-forward reservation from the new day only, and only once', () => {
    const realNow = Date.now;
    try {
      const dayStart = Math.floor(realNow() / 86_400_000) * 86_400_000;
      Date.now = () => dayStart + 60_000;
      const tracker2 = new X402BudgetTracker({ globalDailyLimit: 100_000_000n });
      const pending = tracker2.reserve('api.example.com', 4_000_000n);

      Date.now = () => dayStart + 86_400_000 + 60_000;
      tracker2.recordPayment(reservedLog(2_000_000n, 'other.example.com'));
      expect(tracker2.getDailySpendSummary().global).toBe(6_000_000n);

      // The revert lands today: it subtracts exactly what rollover re-added.
      expect(tracker2.release(pending)).toBe(true);
      expect(tracker2.release(pending)).toBe(false);
      expect(tracker2.getDailySpendSummary().global).toBe(2_000_000n);
      expect(tracker2.getDailySpendSummary().byService['api.example.com']).toBe(0n);
      expect(tracker2.getDailySpendSummary().byService['other.example.com']).toBe(2_000_000n);
    } finally {
      Date.now = realNow;
    }
  });

  it('checks and reserves atomically', () => {
    const first = tracker.checkAndReserve('api.example.com', 5_000_000n);
    expect(first.allowed).toBe(true);
    expect(tracker.getDailySpendSummary().byService['api.example.com']).toBe(5_000_000n);

    const overLimit = tracker.checkAndReserve('api.example.com', 6_000_000n);
    expect(overLimit.allowed).toBe(false);
    expect(tracker.getDailySpendSummary().byService['api.example.com']).toBe(5_000_000n);
  });
});
