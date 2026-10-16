import { describe, expect, it, vi } from 'vitest';
import { withSpotCheck } from '../spotcheck.js';
import type { X402PaymentRequirements, X402TransactionLog } from '../types.js';

const REQ: X402PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '10000',
  payTo: '0x1111111111111111111111111111111111111111',
} as X402PaymentRequirements;
const URL_ = 'https://seller.example/api';
const LOG = {
  timestamp: 0, service: 'seller.example', url: URL_, amount: 10000n,
  token: REQ.asset, recipient: REQ.payTo, txHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
  network: REQ.network, scheme: 'exact', success: false, error: 'receipt timeout',
} as X402TransactionLog;

const fakeMod = (decision: Record<string, unknown>, fits = '') => ({
  checkBeforePay: vi.fn(async () => ({ ...decision, fits: async () => fits })),
  afterPay: vi.fn(async () => ({ status: 'landed', safe_to_resign: false })),
});

describe('withSpotCheck', () => {
  it('keeps the original config and does not mutate it', () => {
    const base = { globalDailyLimit: 5n };
    const out = withSpotCheck(base, { load: async () => fakeMod({ allowed: true }) });
    expect(out.globalDailyLimit).toBe(5n);
    expect(base).toEqual({ globalDailyLimit: 5n });
  });

  it('allows when x402-spotcheck allows, passing the selected terms', async () => {
    const m = fakeMod({ allowed: true, verdict: 'pay' });
    const cfg = withSpotCheck({}, { load: async () => m, check: { mode: 'local' } });
    await expect(cfg.onBeforePayment!(REQ, URL_)).resolves.toBe(true);
    expect(m.checkBeforePay).toHaveBeenCalledWith(URL_, { mode: 'local', accepts: [expect.objectContaining({ payTo: REQ.payTo, amount: '10000' })] });
  });

  it('declines on a skip verdict or when the terms do not fit, and reports the decision', async () => {
    const seen: unknown[] = [];
    let cfg = withSpotCheck({}, { load: async () => fakeMod({ allowed: false, verdict: 'skip', reason_code: 'pay_to_mismatch' }), onDecision: (d) => seen.push(d) });
    await expect(cfg.onBeforePayment!(REQ, URL_)).resolves.toBe(false);
    cfg = withSpotCheck({}, { load: async () => fakeMod({ allowed: true }, 'price_mismatch: above listing'), onDecision: (d) => seen.push(d) });
    await expect(cfg.onBeforePayment!(REQ, URL_)).resolves.toBe(false);
    expect(seen).toHaveLength(2);
  });

  it("runs the caller's own onBeforePayment first; its false still declines without a check", async () => {
    const m = fakeMod({ allowed: true });
    const cfg = withSpotCheck({ onBeforePayment: () => false }, { load: async () => m });
    await expect(cfg.onBeforePayment!(REQ, URL_)).resolves.toBe(false);
    expect(m.checkBeforePay).not.toHaveBeenCalled();
  });

  it('fails open when the module is missing, throws, or times out', async () => {
    await expect(withSpotCheck({}, { load: async () => { throw new Error('not installed'); } }).onBeforePayment!(REQ, URL_)).resolves.toBe(true);
    await expect(withSpotCheck({}, { load: async () => ({ checkBeforePay: async () => { throw new Error('boom'); } }) }).onBeforePayment!(REQ, URL_)).resolves.toBe(true);
    await expect(withSpotCheck({}, { timeoutMs: 20, load: async () => ({ checkBeforePay: () => new Promise(() => {}) }) }).onBeforePayment!(REQ, URL_)).resolves.toBe(true);
  });

  it('prePay: false skips the pre-pay check', async () => {
    const m = fakeMod({ allowed: false });
    await expect(withSpotCheck({}, { prePay: false, load: async () => m }).onBeforePayment!(REQ, URL_)).resolves.toBe(true);
    expect(m.checkBeforePay).not.toHaveBeenCalled();
  });

  it('after-pay is opt-in: only failed transfers with a tx hash are looked up; the caller hook always runs', async () => {
    const m = fakeMod({ allowed: true });
    const user = vi.fn();
    const got = vi.fn();
    withSpotCheck({ onPaymentComplete: user }, { load: async () => m }).onPaymentComplete!(LOG);
    expect(user).toHaveBeenCalledTimes(1);
    expect(m.afterPay).not.toHaveBeenCalled();
    const cfg = withSpotCheck({ onPaymentComplete: user }, { afterPay: true, load: async () => m, onAfterPay: got });
    cfg.onPaymentComplete!({ ...LOG, success: true });
    cfg.onPaymentComplete!(LOG);
    await vi.waitFor(() => expect(got).toHaveBeenCalledTimes(1));
    expect(m.afterPay).toHaveBeenCalledWith({ txHash: LOG.txHash }, {});
    expect(got.mock.calls[0][0]).toEqual({ status: 'landed', safe_to_resign: false });
    expect(user).toHaveBeenCalledTimes(3);
  });

  it('after-pay errors never surface', async () => {
    const cfg = withSpotCheck({}, { afterPay: true, load: async () => ({ afterPay: async () => { throw new Error('down'); } }) });
    expect(() => cfg.onPaymentComplete!(LOG)).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});
