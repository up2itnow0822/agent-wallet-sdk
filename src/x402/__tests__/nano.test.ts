// Tests for x402 Nano (XNO) rail selection — pure, deterministic, no network.
import { describe, it, expect } from 'vitest';
import { selectNanoRail, isNanoExactRail } from '../nano.js';
import type { X402PaymentRequirements } from '../types.js';

const baseNano = {
  scheme: 'exact',
  network: 'nano:mainnet',
  asset: 'XNO',
  amount: '100000000000000000000000000', // 0.1 XNO (raw)
  payTo: 'nano_135sa19immd5hzygn3w7zu8gaheu75s5qmoqjfzpmbg3nrwo3cb61onp8xf7',
  maxTimeoutSeconds: 60,
  extra: {},
} as const;

describe('isNanoExactRail', () => {
  it('accepts an exact nano:mainnet XNO rail', () => {
    expect(isNanoExactRail(baseNano as X402PaymentRequirements)).toBe(true);
  });

  it('accepts a zero maxTimeout', () => {
    const req = { ...baseNano, maxTimeoutSeconds: 0 };
    expect(isNanoExactRail(req as unknown as X402PaymentRequirements)).toBe(true);
  });

  it('rejects a non-Nano network', () => {
    const req = { ...baseNano, network: 'base:8453' };
    expect(isNanoExactRail(req as unknown as X402PaymentRequirements)).toBe(false);
  });

  it('rejects a non-exact scheme', () => {
    const req = { ...baseNano, scheme: 'upto' };
    expect(isNanoExactRail(req as unknown as X402PaymentRequirements)).toBe(false);
  });

  it('rejects a non-XNO asset', () => {
    const req = { ...baseNano, asset: 'USDC' };
    expect(isNanoExactRail(req as unknown as X402PaymentRequirements)).toBe(false);
  });
});

describe('selectNanoRail', () => {
  it('returns null when the merchant offers no Nano rail', () => {
    const accepts = [
      { ...baseNano, network: 'base:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    ] as unknown as X402PaymentRequirements[];
    expect(selectNanoRail(accepts)).toBeNull();
  });

  it('selects the Nano exact rail when offered beside USDC rails', () => {
    const accepts = [
      { ...baseNano, network: 'base:8453', asset: 'USDC' },
      baseNano,
    ] as unknown as X402PaymentRequirements[];
    const sel = selectNanoRail(accepts);
    expect(sel).not.toBeNull();
    expect(sel?.payTo).toBe(baseNano.payTo);
    expect(sel?.maxTimeoutSeconds).toBe(60);
  });

  it('parses the raw XNO amount as a bigint', () => {
    const sel = selectNanoRail([baseNano] as unknown as X402PaymentRequirements[]);
    expect(sel?.raw).toBe(100000000000000000000000000n);
  });

  it('round-trips an amount of exactly one XNO', () => {
    const req = { ...baseNano, amount: BigInt(10n ** 30n).toString() }; // 1 XNO raw
    const sel = selectNanoRail([req] as unknown as X402PaymentRequirements[]);
    expect(sel?.raw).toBe(10n ** 30n);
  });

  it('ignores non-exact or non-Nano entries and prefers the Nano one', () => {
    const accepts = [
      { ...baseNano, network: 'base:8453', asset: 'USDC' },
      { ...baseNano, scheme: 'upto', network: 'nano:mainnet' },
      baseNano,
    ] as unknown as X402PaymentRequirements[];
    const sel = selectNanoRail(accepts);
    expect(sel).not.toBeNull();
    expect(sel?.payTo).toBe(baseNano.payTo);
  });
});
