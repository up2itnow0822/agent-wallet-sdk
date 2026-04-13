import { describe, expect, it } from 'vitest';
import { UptoBillingPolicy } from './UptoBillingPolicy.js';

describe('UptoBillingPolicy', () => {
  it('tracks max authorization and exposes reservation ledger delta', () => {
    const policy = new UptoBillingPolicy();
    const auth = policy.authorize({
      authorizationId: 'auth-1',
      service: 'api.example.com',
      resource: 'GET /inference',
      network: 'base:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0xabc',
      maxAmount: 1_000_000n,
    });

    expect(auth.maxAmount).toBe(1_000_000n);
    expect(auth.remainingAmount).toBe(1_000_000n);
    expect(policy.getReservedAmount('auth-1')).toBe(1_000_000n);

    const deltas = policy.getWalletLedgerDeltas('auth-1');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].type).toBe('authorization');
    expect(deltas[0].reservedDelta).toBe(1_000_000n);
    expect(deltas[0].netWalletDelta).toBe(0n);
  });

  it('records actual settlement and wallet delta', () => {
    const policy = new UptoBillingPolicy();
    policy.authorize({
      authorizationId: 'auth-2',
      service: 'api.example.com',
      network: 'base:8453',
      asset: 'usdc',
      payTo: '0xabc',
      maxAmount: 1_000_000n,
    });

    const snapshot = policy.recordSettlement('auth-2', 420_000n, {
      txHash: '0xsettle',
    });

    expect(snapshot.authorization.settledAmount).toBe(420_000n);
    expect(snapshot.authorization.remainingAmount).toBe(580_000n);
    expect(snapshot.authorization.status).toBe('partially_settled');
    expect(policy.getNetWalletDelta('auth-2')).toBe(-420_000n);

    const settlementDelta = snapshot.ledgerDeltas[1];
    expect(settlementDelta.type).toBe('settlement');
    expect(settlementDelta.reservedDelta).toBe(-420_000n);
    expect(settlementDelta.settledDelta).toBe(420_000n);
    expect(settlementDelta.netWalletDelta).toBe(-420_000n);
  });

  it('releases unused authorization capacity on finalize', () => {
    const policy = new UptoBillingPolicy();
    policy.authorize({
      authorizationId: 'auth-3',
      service: 'api.example.com',
      network: 'base:8453',
      asset: 'usdc',
      payTo: '0xabc',
      maxAmount: 1_000_000n,
    });

    policy.recordSettlement('auth-3', 250_000n, { finalize: true });
    const auth = policy.getAuthorization('auth-3');
    const deltas = policy.getWalletLedgerDeltas('auth-3');

    expect(auth?.settledAmount).toBe(250_000n);
    expect(auth?.releasedAmount).toBe(750_000n);
    expect(auth?.remainingAmount).toBe(0n);
    expect(auth?.status).toBe('settled');
    expect(policy.getReservedAmount('auth-3')).toBe(0n);
    expect(deltas.map((delta) => delta.type)).toEqual([
      'authorization',
      'settlement',
      'release',
    ]);
  });

  it('rejects settlement above the authorized amount', () => {
    const policy = new UptoBillingPolicy();
    policy.authorize({
      authorizationId: 'auth-4',
      service: 'api.example.com',
      network: 'base:8453',
      asset: 'usdc',
      payTo: '0xabc',
      maxAmount: 100n,
    });

    expect(() => policy.recordSettlement('auth-4', 101n)).toThrow(
      /exceeds remaining authorized amount/i,
    );
  });

  it('supports multiple settlements up to the authorized cap', () => {
    const policy = new UptoBillingPolicy();
    policy.authorize({
      authorizationId: 'auth-5',
      service: 'api.example.com',
      network: 'base:8453',
      asset: 'usdc',
      payTo: '0xabc',
      maxAmount: 1_000n,
    });

    policy.recordSettlement('auth-5', 250n);
    policy.recordSettlement('auth-5', 750n);

    const auth = policy.getAuthorization('auth-5');
    expect(auth?.settledAmount).toBe(1_000n);
    expect(auth?.remainingAmount).toBe(0n);
    expect(auth?.status).toBe('settled');
    expect(policy.getNetWalletDelta('auth-5')).toBe(-1_000n);
  });
});
