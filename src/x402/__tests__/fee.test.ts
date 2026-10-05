import { describe, expect, it } from 'vitest';
import { x402DebitAmount, x402ProtocolFeeAmount } from '../fee.js';

describe('x402 protocol fee', () => {
  it('uses exact 0.77% floor division in base units', () => {
    expect(x402ProtocolFeeAmount(1_000_000n)).toBe(7_700n);
    expect(x402DebitAmount(1_000_000n)).toBe(1_007_700n);
    expect(x402ProtocolFeeAmount(1n)).toBe(0n);
  });
});
