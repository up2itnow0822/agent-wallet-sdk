import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { X402Client } from '../client.js';
import { judgedSpotCheckNetwork, withSpotCheck } from '../spotcheck.js';
import type { SpotCheckOptions } from '../spotcheck.js';
import { USDC_ADDRESSES } from '../types.js';
import type { X402PaymentRequired } from '../types.js';
import { stubReceiptEvidence } from './receipt-evidence.js';

const URL = 'https://api.example.com/premium/data';
const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x1111111111111111111111111111111111111111';
const OTHER_PAY_TO = '0x2222222222222222222222222222222222222222';
const TX_HASH = `0x${'ab'.repeat(32)}` as const;
const AMOUNT = '1000000';

function walletOnChain(chainId: number) {
  return {
    chain: { id: chainId },
    publicClient: {
      waitForTransactionReceipt: async () => ({ status: 'success' }),
    },
  } as const;
}

function challenge(overrides: Partial<X402PaymentRequired['accepts'][number]> = {}): X402PaymentRequired {
  return {
    x402Version: 1,
    resource: { url: '/premium/data', description: 'Data API', mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact',
      network: 'base:8453',
      asset: ASSET,
      amount: AMOUNT,
      payTo: PAY_TO,
      maxTimeoutSeconds: 30,
      extra: {},
      ...overrides,
    }],
  };
}

function mockMerchant(required: X402PaymentRequired = challenge()) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const headers = new Headers(init?.headers);
    if (headers.get('X-PAYMENT')) {
      return new Response('paid', { status: 200 });
    }
    return new Response(null, {
      status: 402,
      headers: { 'payment-required': btoa(JSON.stringify(required)) },
    });
  });
}

function executeSpy() {
  return vi.spyOn(X402Client.prototype as any, 'executePayment').mockResolvedValue({ txHash: TX_HASH });
}

async function pay(opts: SpotCheckOptions, config = {}, chainId = 8453, required?: X402PaymentRequired) {
  mockMerchant(required ?? challenge());
  const spy = executeSpy();
  const client = new X402Client(walletOnChain(chainId), withSpotCheck(config, opts));
  const result = await client.fetch(URL);
  return { result, spy };
}

beforeEach(() => { stubReceiptEvidence(); });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('withSpotCheck fail-closed contract', () => {
  it('pays when listing payTo, network, and atomic price match', async () => {
    const { result, spy } = await pay({
      check: { payTo: PAY_TO, network: 'base:8453', price: AMOUNT },
    });
    expect(result.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('pays when the supplied checker returns allowed true', async () => {
    const { result, spy } = await pay({
      checker: { checkBeforePay: async () => ({ allowed: true }) },
    });
    expect(result.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the checker returns a non-allow', async () => {
    const { result, spy } = await pay({
      checker: { checkBeforePay: async () => ({ allowed: false }) },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when the checker returns allowed true with verdict skip', async () => {
    const { result, spy } = await pay({
      checker: { checkBeforePay: async () => ({ allowed: true, verdict: 'skip' }) },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('pays a listed base-sepolia:84532 requirement', async () => {
    const required = challenge({
      network: 'base-sepolia:84532',
      asset: USDC_ADDRESSES['base-sepolia:84532'],
    });
    const { result, spy } = await pay({
      check: { payTo: PAY_TO, network: 'base-sepolia:84532', price: AMOUNT },
    }, { supportedNetworks: ['base-sepolia:84532'], supportedAssets: { 'base-sepolia:84532': [USDC_ADDRESSES['base-sepolia:84532']] } }, 84532, required);
    expect(result.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fails closed when listing payTo differs', async () => {
    const { result, spy } = await pay({
      check: { payTo: OTHER_PAY_TO, network: 'base:8453', price: AMOUNT },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when listing price differs, including a 1.01x slack amount', async () => {
    const { result, spy } = await pay({
      check: { payTo: PAY_TO, network: 'base:8453', price: '1010000' },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when listing names a different mapped chain', async () => {
    const { result, spy } = await pay({
      check: { payTo: PAY_TO, network: 'ethereum:1', price: AMOUNT },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when listing payTo mismatches even if the checker allows', async () => {
    const { result, spy } = await pay({
      check: { payTo: OTHER_PAY_TO, network: 'base:8453', price: AMOUNT },
      checker: { checkBeforePay: async () => ({ allowed: true }) },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when no checker is supplied', async () => {
    const { result, spy } = await pay({});
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([undefined, {}])('fails closed when expected returns %s', async (listing) => {
    const { result, spy } = await pay({
      check: { expected: () => listing },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when load throws', async () => {
    const { result, spy } = await pay({
      load: async () => { throw new Error('missing module'); },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when checkBeforePay throws', async () => {
    const { result, spy } = await pay({
      checker: { checkBeforePay: async () => { throw new Error('boom'); } },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when expected throws', async () => {
    const { result, spy } = await pay({
      check: { expected: () => { throw new Error('listing failed'); } },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when load and checkBeforePay together exceed one timeout budget', async () => {
    const hang = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });
    const { result, spy } = await pay({
      timeoutMs: 40,
      load: async () => {
        await hang(25);
        return { checkBeforePay: async () => { await hang(25); return { allowed: true }; } };
      },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not invoke the checker when the caller onBeforePayment returns false', async () => {
    const checkBeforePay = vi.fn(async () => ({ allowed: true }));
    const { result, spy } = await pay(
      { checker: { checkBeforePay } },
      { onBeforePayment: () => false },
    );
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
    expect(checkBeforePay).not.toHaveBeenCalled();
  });

  it('pays ethereum:1 when the listing uses the SDK network form', async () => {
    const required = challenge({
      network: 'ethereum:1',
      asset: USDC_ADDRESSES['ethereum:1'],
    });
    const { result, spy } = await pay({
      check: { payTo: PAY_TO, network: 'ethereum:1', price: AMOUNT },
    }, { supportedNetworks: ['ethereum:1'], supportedAssets: { 'ethereum:1': [USDC_ADDRESSES['ethereum:1']] } }, 1, required);
    expect(result.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fails closed on an unrecognized network', async () => {
    const hook = withSpotCheck({}, {
      checker: { checkBeforePay: async () => ({ allowed: true }) },
    }).onBeforePayment;
    const allowed = await hook!(
      challenge({ network: 'not-a-chain' }).accepts[0],
      URL,
    );
    expect(allowed).toBe(false);
  });

  it('exposes no fail-open or prePay skip flag', () => {
    const keys: Array<keyof SpotCheckOptions> = ['check', 'timeoutMs', 'checker', 'load'];
    expect(keys).toEqual(expect.arrayContaining(['check', 'timeoutMs', 'checker', 'load']));
    expect(withSpotCheck.toString()).not.toMatch(/failOpen|prePay/);
  });

  it('does not import a spot-check package', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../spotcheck.ts'), 'utf8');
    expect(source).not.toMatch(/x402-spotcheck|github:/);
  });
});

describe('judgedSpotCheckNetwork', () => {
  it('maps SDK base:8453 so a listing mismatch is judged instead of skipped', () => {
    expect(judgedSpotCheckNetwork('base:8453')).toBe('eip155:8453');
    expect(judgedSpotCheckNetwork('eip155:8453')).toBe('eip155:8453');
    expect(judgedSpotCheckNetwork('base')).toBe('eip155:8453');
    expect(judgedSpotCheckNetwork('base-sepolia:84532')).toBe('eip155:84532');
    expect(judgedSpotCheckNetwork('not-a-chain')).toBeNull();
  });
});
