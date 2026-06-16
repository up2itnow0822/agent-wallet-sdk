import { describe, expect, it } from 'vitest';
import { formatSolanaUnits } from '../solana.js';

describe('formatSolanaUnits', () => {
  it('formats balances without converting through Number', () => {
    expect(formatSolanaUnits(1234567890123456789012345n, 6)).toBe(
      '1234567890123456789.012345'
    );
  });

  it('trims trailing fractional zeros', () => {
    expect(formatSolanaUnits(1500000n, 6)).toBe('1.5');
    expect(formatSolanaUnits(1000000n, 6)).toBe('1');
  });

  it('preserves small fractional balances', () => {
    expect(formatSolanaUnits(1n, 9)).toBe('0.000000001');
  });
});
