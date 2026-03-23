/**
 * Tests for token decimal normalization utilities.
 */
import { describe, it, expect } from 'vitest';
import { toRaw, toHuman, formatBalance, parseAmount } from '../decimals.js';

describe('toRaw', () => {
  it('converts "1.5" with 6 decimals to 1500000n (USDC)', () => {
    expect(toRaw('1.5', 6)).toBe(1500000n);
  });

  it('converts "1.0" with 18 decimals to 1000000000000000000n (WETH)', () => {
    expect(toRaw('1.0', 18)).toBe(1_000_000_000_000_000_000n);
  });

  it('converts "0.001" with 8 decimals to 100000n (WBTC)', () => {
    expect(toRaw('0.001', 8)).toBe(100000n);
  });

  it('converts integer "100" with 6 decimals correctly', () => {
    expect(toRaw('100', 6)).toBe(100_000_000n);
  });

  it('converts "0" to 0n', () => {
    expect(toRaw('0', 6)).toBe(0n);
  });

  it('handles string with more fractional digits than decimals (truncates)', () => {
    // 1.9999999 with 6 decimals should truncate to 1.999999 → 1999999n
    expect(toRaw('1.9999999', 6)).toBe(1_999_999n);
  });

  it('handles fractional-only strings', () => {
    expect(toRaw('0.5', 6)).toBe(500_000n);
  });

  it('handles bigint passthrough', () => {
    expect(toRaw(12345n, 6)).toBe(12345n);
  });

  it('handles zero-padding short fractions', () => {
    // "1.5" with 18 decimals → 1500000000000000000n
    expect(toRaw('1.5', 18)).toBe(1_500_000_000_000_000_000n);
  });

  it('throws on invalid amount string', () => {
    expect(() => toRaw('abc', 6)).toThrow();
    expect(() => toRaw('1.2.3', 6)).toThrow();
  });
});

describe('toHuman', () => {
  it('converts 1500000n with 6 decimals to "1.5"', () => {
    expect(toHuman(1500000n, 6)).toBe('1.5');
  });

  it('converts 1000000000000000000n with 18 decimals to "1.0"', () => {
    expect(toHuman(1_000_000_000_000_000_000n, 18)).toBe('1.0');
  });

  it('converts 0n to "0.0"', () => {
    expect(toHuman(0n, 6)).toBe('0.0');
    expect(toHuman(0n, 18)).toBe('0.0');
  });

  it('converts 100000000n with 6 decimals to "100.0"', () => {
    expect(toHuman(100_000_000n, 6)).toBe('100.0');
  });

  it('trims trailing zeros but keeps at least one decimal', () => {
    expect(toHuman(1_500_000n, 6)).toBe('1.5');
    expect(toHuman(1_000_000n, 6)).toBe('1.0');
  });

  it('handles 0 decimals', () => {
    expect(toHuman(12345n, 0)).toBe('12345');
  });
});

describe('formatBalance', () => {
  it('formats USDC (6 decimals) with 2 decimal places', () => {
    const token = { symbol: 'USDC', decimals: 6, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}` };
    expect(formatBalance(1_500_000n, token)).toBe('1.50 USDC');
  });

  it('formats WETH (18 decimals) with 4 decimal places', () => {
    const token = { symbol: 'WETH', decimals: 18, address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as `0x${string}` };
    expect(formatBalance(1_000_000_000_000_000_000n, token)).toBe('1.0000 WETH');
  });

  it('formats 0 balance correctly', () => {
    const token = { symbol: 'USDC', decimals: 6, address: '0x0000000000000000000000000000000000000000' as `0x${string}` };
    expect(formatBalance(0n, token)).toBe('0.00 USDC');
  });

  it('accepts custom displayDecimals', () => {
    const token = { symbol: 'WETH', decimals: 18, address: '0x0000000000000000000000000000000000000000' as `0x${string}` };
    expect(formatBalance(1_000_000_000_000_000_000n, token, 2)).toBe('1.00 WETH');
  });
});

describe('parseAmount', () => {
  it('parses string to raw bigint', () => {
    expect(parseAmount('1.5', 6)).toBe(1_500_000n);
  });

  it('passes through bigint unchanged', () => {
    expect(parseAmount(1_500_000n, 6)).toBe(1_500_000n);
  });
});

describe('round-trip consistency', () => {
  it('toRaw(toHuman(x)) === x for USDC amounts', () => {
    const cases = [0n, 1n, 1_000_000n, 1_500_000n, 100_000_000n, 999_999n];
    for (const raw of cases) {
      const human = toHuman(raw, 6);
      const backToRaw = toRaw(human, 6);
      expect(backToRaw).toBe(raw);
    }
  });

  it('toRaw(toHuman(x)) === x for ETH amounts (selected)', () => {
    const cases = [0n, 1_000_000_000_000_000_000n, 500_000_000_000_000_000n];
    for (const raw of cases) {
      const human = toHuman(raw, 18);
      const backToRaw = toRaw(human, 18);
      expect(backToRaw).toBe(raw);
    }
  });
});
