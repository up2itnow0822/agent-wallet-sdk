import { describe, it, expect } from 'vitest';
import { x402ProtocolFee, x402TotalDebit, X402_PROTOCOL_FEE_BPS } from '../fees.js';

describe('x402ProtocolFee', () => {
  it('charges 77 bps floored in base units', () => {
    expect(X402_PROTOCOL_FEE_BPS).toBe(77n);
    // 100 USDC (6 decimals) → 0.77 USDC fee
    expect(x402ProtocolFee(100_000_000n)).toBe(770_000n);
    expect(x402TotalDebit(100_000_000n)).toBe(100_770_000n);
  });

  it('returns zero for non-positive amounts', () => {
    expect(x402ProtocolFee(0n)).toBe(0n);
    expect(x402ProtocolFee(-1n)).toBe(0n);
  });

  it('floors sub-unit fees', () => {
    // 100 base units * 77 / 10000 = 0
    expect(x402ProtocolFee(100n)).toBe(0n);
    expect(x402TotalDebit(100n)).toBe(100n);
  });
});
