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
});
