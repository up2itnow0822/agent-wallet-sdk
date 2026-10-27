import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { X402Client } from '../client.js';
import { withSpotCheck } from '../spotcheck.js';
import type { X402PaymentRequirements, X402TransactionLog } from '../types.js';
import { stubReceiptEvidence } from './receipt-evidence.js';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'spotcheck.ts'), 'utf8');

const REQ: X402PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '10000',
  payTo: '0x1111111111111111111111111111111111111111',
  maxTimeoutSeconds: 30,
  extra: {},
};
const SDK_REQ: X402PaymentRequirements = { ...REQ, network: 'base:8453' };
const URL_ = 'https://seller.example/api';
const TX_HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const LOG = {
  timestamp: 0, service: 'seller.example', url: URL_, amount: 10000n,
  token: REQ.asset, recipient: REQ.payTo, txHash: TX_HASH,
  network: REQ.network, scheme: 'exact', success: false, error: 'receipt timeout',
} as X402TransactionLog;

afterEach(() => {
  vi.restoreAllMocks();
});

const fakeMod = (decision: Record<string, unknown>, fits = '') => ({
  checkBeforePay: vi.fn(async () => ({ ...decision, fits: async () => fits })),
  afterPay: vi.fn(async () => ({ status: 'landed', safe_to_resign: false })),
});

describe('withSpotCheck', () => {
  it('does not import a spot-check package', () => {
    expect(SRC).not.toMatch(/x402-spotcheck/);
    expect(SRC).not.toMatch(/\bimport\s*\(/);
  });

  it('accepts a caller-supplied checker object', async () => {
    const checkBeforePay = vi.fn(async () => ({ allowed: true, verdict: 'pay' }));
    const cfg = withSpotCheck({}, { checker: { checkBeforePay } });
    await expect(cfg.onBeforePayment!(REQ, URL_)).resolves.toBe(true);
    expect(checkBeforePay).toHaveBeenCalled();
  });

  it('keeps the original config and does not mutate it', () => {
    const base = { globalDailyLimit: 5n };
    const out = withSpotCheck(base, { load: async () => fakeMod({ allowed: true }) });
    expect(out.globalDailyLimit).toBe(5n);
    expect(base).toEqual({ globalDailyLimit: 5n });
  });

  it('allows when the caller-supplied checker allows, passing the selected terms', async () => {
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

  it('fails closed when no checker is supplied', async () => {
    await expect(withSpotCheck({}).onBeforePayment!(REQ, URL_)).resolves.toBe(false);
    await expect(withSpotCheck({}, { check: { mode: 'local' } }).onBeforePayment!(REQ, URL_)).resolves.toBe(false);
    await expect(withSpotCheck({}, { check: { payTo: '', network: '' } }).onBeforePayment!(REQ, URL_)).resolves.toBe(false);
  });

  it('fails closed when expected returns no listing', async () => {
    await expect(withSpotCheck({}, { check: { expected: () => undefined } }).onBeforePayment!(REQ, URL_)).resolves.toBe(false);
  });

  it('fails closed unless the caller-supplied checker explicitly allows', async () => {
    await expect(withSpotCheck({}, { load: async () => ({ checkBeforePay: async () => ({}) }) }).onBeforePayment!(REQ, URL_)).resolves.toBe(false);
    await expect(withSpotCheck({}, { load: async () => ({ checkBeforePay: async () => ({ verdict: 'skip' }) }) }).onBeforePayment!(REQ, URL_)).resolves.toBe(false);
    await expect(withSpotCheck({}, { load: async () => ({ checkBeforePay: async () => undefined }) }).onBeforePayment!(REQ, URL_)).resolves.toBe(false);
  });

  it('fails closed when the checker is missing, throws, or times out', async () => {
    await expect(withSpotCheck({}, { load: async () => { throw new Error('not installed'); } }).onBeforePayment!(REQ, URL_)).resolves.toBe(false);
    await expect(withSpotCheck({}, { load: async () => ({ checkBeforePay: async () => { throw new Error('boom'); } }) }).onBeforePayment!(REQ, URL_)).resolves.toBe(false);
    await expect(withSpotCheck({}, { timeoutMs: 20, load: async () => ({ checkBeforePay: () => new Promise(() => {}) }) }).onBeforePayment!(REQ, URL_)).resolves.toBe(false);
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

  it('invokes check.expected and denies a mismatched recipient', async () => {
    const expected = vi.fn(() => ({
      price: 0.01,
      payTo: '0x2222222222222222222222222222222222222222',
      network: 'base',
    }));
    const cfg = withSpotCheck({}, { check: { expected } });
    await expect(cfg.onBeforePayment!(SDK_REQ, URL_)).resolves.toBe(false);
    expect(expected).toHaveBeenCalledWith(URL_, expect.objectContaining({
      network: SDK_REQ.network,
      payTo: SDK_REQ.payTo,
    }));
  });

  it('invokes check.expected and denies a mismatched price', async () => {
    const expected = vi.fn(() => ({
      price: 0.001,
      payTo: SDK_REQ.payTo,
      network: 'eip155:8453',
    }));
    const cfg = withSpotCheck({}, { check: { expected } });
    await expect(cfg.onBeforePayment!(SDK_REQ, URL_)).resolves.toBe(false);
    expect(expected).toHaveBeenCalled();
  });

  it('converts SDK base:8453 so a listing mismatch is judged instead of skipped', async () => {
    const cfg = withSpotCheck({}, {
      check: { expected: () => ({ price: 0.01, payTo: '0x2222222222222222222222222222222222222222', network: 'base' }) },
    });
    await expect(cfg.onBeforePayment!(SDK_REQ, URL_)).resolves.toBe(false);
  });

  it('denies a network the spot-check cannot recognize', async () => {
    const other = { ...SDK_REQ, network: 'ethereum:1' };
    const cfg = withSpotCheck({}, {
      check: { expected: () => ({ price: 0.01, payTo: other.payTo, network: 'ethereum:1' }) },
    });
    await expect(cfg.onBeforePayment!(other, URL_)).resolves.toBe(false);
  });

  it('allows matching terms after converting the SDK default network', async () => {
    const expected = vi.fn(() => ({ price: 0.01, payTo: SDK_REQ.payTo, network: 'base' }));
    const cfg = withSpotCheck({}, { check: { expected } });
    await expect(cfg.onBeforePayment!(SDK_REQ, URL_)).resolves.toBe(true);
    expect(expected).toHaveBeenCalled();
  });

  it('does not call fits after a denial', async () => {
    const fits = vi.fn(async () => { throw new Error('fits after deny'); });
    const cfg = withSpotCheck({}, {
      load: async () => ({ checkBeforePay: async () => ({ allowed: false, verdict: 'skip', fits }) }),
    });
    await expect(cfg.onBeforePayment!(SDK_REQ, URL_)).resolves.toBe(false);
    expect(fits).not.toHaveBeenCalled();
  });

  it('denies when fits throws', async () => {
    const cfg = withSpotCheck({}, {
      load: async () => ({
        checkBeforePay: async () => ({ allowed: true, fits: async () => { throw new Error('fits boom'); } }),
      }),
    });
    await expect(cfg.onBeforePayment!(SDK_REQ, URL_)).resolves.toBe(false);
  });

  it('after-pay looks up a receipt failure that throws before onPaymentComplete', async () => {
    const afterPay = vi.fn(async () => ({ status: 'unknown', safe_to_resign: false }));
    const onAfterPay = vi.fn();
    const userComplete = vi.fn();
    vi.spyOn(X402Client.prototype as unknown as { executePayment: () => Promise<{ txHash: `0x${string}` }> }, 'executePayment').mockResolvedValue({ txHash: TX_HASH });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (new Headers(init?.headers).get('X-PAYMENT')) return new Response('paid', { status: 200 });
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(challenge())) },
      });
    });
    const wallet = {
      chain: { id: 8453 },
      publicClient: {
        waitForTransactionReceipt: async () => { throw new Error('receipt timeout'); },
      },
    };
    const cfg = withSpotCheck({ onPaymentComplete: userComplete }, {
      afterPay: true,
      load: async () => ({ checkBeforePay: async () => ({ allowed: true }), afterPay }),
      onAfterPay,
    });
    const client = new X402Client(wallet, cfg);
    await expect(client.fetch(URL_, { method: 'POST' })).rejects.toThrow('receipt timeout');
    expect(userComplete).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(afterPay).toHaveBeenCalledWith({ txHash: TX_HASH }, {}));
    expect(onAfterPay).toHaveBeenCalled();
  });

  it('after-pay looks up a paid-request failure after a success:true completion', async () => {
    const afterPay = vi.fn(async () => ({ status: 'landed', safe_to_resign: false }));
    const onAfterPay = vi.fn();
    const userComplete = vi.fn();
    stubReceiptEvidence();
    vi.spyOn(X402Client.prototype as unknown as { executePayment: () => Promise<{ txHash: `0x${string}` }> }, 'executePayment').mockResolvedValue({ txHash: TX_HASH });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (new Headers(init?.headers).get('X-PAYMENT')) throw new TypeError('fetch failed');
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(challenge())) },
      });
    });
    const wallet = {
      chain: { id: 8453 },
      publicClient: {
        waitForTransactionReceipt: async () => ({ status: 'success', transactionHash: TX_HASH }),
      },
    };
    const cfg = withSpotCheck({ onPaymentComplete: userComplete }, {
      afterPay: true,
      load: async () => ({ checkBeforePay: async () => ({ allowed: true }), afterPay }),
      onAfterPay,
    });
    const client = new X402Client(wallet, cfg);
    await expect(client.fetch(URL_, { method: 'POST' })).rejects.toMatchObject({ name: 'X402PaidRequestError', txHash: TX_HASH });
    expect(userComplete).toHaveBeenCalledWith(expect.objectContaining({ success: true, txHash: TX_HASH }));
    await vi.waitFor(() => expect(afterPay).toHaveBeenCalledWith({ txHash: TX_HASH }, {}));
    expect(onAfterPay).toHaveBeenCalled();
  });
});

function challenge() {
  return {
    x402Version: 1,
    resource: { url: '/api', description: 'API', mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact',
      network: 'base:8453',
      asset: REQ.asset,
      amount: '10000',
      payTo: REQ.payTo,
      maxTimeoutSeconds: 30,
      extra: { nonce: 'spotcheck-intent' },
    }],
  };
}
