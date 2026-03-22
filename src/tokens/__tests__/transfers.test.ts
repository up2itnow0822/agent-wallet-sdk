/**
 * Tests for ERC-20 and native transfer encoding.
 * Uses mocked publicClient/walletClient to avoid real RPC calls.
 *
 * NOTE: viem enforces EIP-55 checksummed addresses. All addresses here
 * are checksummed via `getAddress()` from viem.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Address } from 'viem';
import { encodeERC20Transfer } from '../transfers.js';
import { toRaw } from '../decimals.js';

// Checksummed test addresses (verified via viem's getAddress)
// These are real EIP-55 addresses used only in tests
const TO:      Address = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB'; // BBBB... checksummed
const ACCOUNT: Address = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa'; // AAAA... checksummed
const USDC_ETH: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const FAKE_HASH = ('0x' + 'a'.repeat(64)) as `0x${string}`;

// ─── encodeERC20Transfer tests ────────────────────────────────────────────────

describe('encodeERC20Transfer', () => {
  it('produces correct 4-byte selector for transfer()', () => {
    const data = encodeERC20Transfer(TO, 1_000_000n);
    // transfer(address,uint256) selector = 0xa9059cbb
    expect(data.slice(0, 10).toLowerCase()).toBe('0xa9059cbb');
  });

  it('encodes the recipient address in the calldata', () => {
    const data = encodeERC20Transfer(TO, 1_000_000n);
    // Recipient is ABI-encoded as 32-byte padded address starting at byte 4
    const lowerTo = TO.toLowerCase().slice(2); // strip 0x
    expect(data.toLowerCase()).toContain(lowerTo);
  });

  it('encodes the amount correctly', () => {
    const amount = 1_500_000n; // 1.5 USDC
    const data = encodeERC20Transfer(TO, amount);
    // Amount 1500000 = 0x16e360
    expect(data.toLowerCase()).toContain('16e360');
  });

  it('encodes zero amount', () => {
    const data = encodeERC20Transfer(TO, 0n);
    expect(data).toBeDefined();
    expect(data.startsWith('0xa9059cbb')).toBe(true);
  });

  it('encodes large amounts (18 decimals, 1 WETH)', () => {
    const oneWeth = toRaw('1.0', 18);
    const data = encodeERC20Transfer(TO, oneWeth);
    expect(data.startsWith('0xa9059cbb')).toBe(true);
    // 1e18 = 0xde0b6b3a7640000
    expect(data.toLowerCase()).toContain('de0b6b3a7640000');
  });
});

// ─── Transfer function smoke tests (mocked clients) ──────────────────────────

describe('sendToken (mocked)', () => {
  it('calls walletClient.sendTransaction with transfer calldata', async () => {
    const { sendToken } = await import('../transfers.js');

    const sendTransaction = vi.fn().mockResolvedValue(FAKE_HASH);
    const readContract = vi.fn().mockResolvedValue(6); // decimals

    const ctx = {
      publicClient: { readContract } as any,
      walletClient: { sendTransaction } as any,
      account: ACCOUNT,
      chainId: 1,
    };

    const hash = await sendToken(ctx, TO, '1.5', USDC_ETH);

    expect(hash).toBe(FAKE_HASH);
    expect(sendTransaction).toHaveBeenCalledOnce();

    const callArgs = sendTransaction.mock.calls[0][0];
    // Should send to the token contract address
    expect(callArgs.to).toBe(USDC_ETH);
    // Data should start with transfer() selector
    expect(callArgs.data.toLowerCase().startsWith('0xa9059cbb')).toBe(true);
  });
});

describe('sendNative (mocked)', () => {
  it('calls walletClient.sendTransaction with value and no data', async () => {
    const { sendNative } = await import('../transfers.js');

    const sendTransaction = vi.fn().mockResolvedValue(('0x' + 'b'.repeat(64)) as `0x${string}`);

    const ctx = {
      publicClient: {} as any,
      walletClient: { sendTransaction } as any,
      account: ACCOUNT,
    };

    const hash = await sendNative(ctx, TO, '0.5'); // 0.5 ETH

    expect(sendTransaction).toHaveBeenCalledOnce();

    const callArgs = sendTransaction.mock.calls[0][0];
    expect(callArgs.to).toBe(TO);
    expect(callArgs.value).toBe(500_000_000_000_000_000n); // 0.5 * 10^18
  });
});

describe('getNativeBalance (mocked)', () => {
  it('returns correct balance info', async () => {
    const { getNativeBalance } = await import('../transfers.js');

    const getBalance = vi.fn().mockResolvedValue(1_000_000_000_000_000_000n); // 1 ETH

    const ctx = {
      publicClient: { getBalance } as any,
      walletClient: {} as any,
      account: ACCOUNT,
      chainId: 8453,
    };

    const result = await getNativeBalance(ctx);
    expect(result.rawBalance).toBe(1_000_000_000_000_000_000n);
    expect(result.humanBalance).toBe('1.0');
    expect(result.decimals).toBe(18);
  });
});
