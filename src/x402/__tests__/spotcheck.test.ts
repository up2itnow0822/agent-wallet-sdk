import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { X402Client } from '../client.js';
import { judgedSpotCheckNetwork, withSpotCheck } from '../spotcheck.js';
import type { SpotCheckClock, SpotCheckOptions } from '../spotcheck.js';
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

function createFakeClock(): SpotCheckClock & { advance(ms: number): void; jump(ms: number): void } {
  let nowMs = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  return {
    now: () => nowMs,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: nowMs + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id as number);
    },
    advance(ms) {
      nowMs += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= nowMs) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    jump(ms) {
      nowMs += ms;
    },
  };
}

async function pay(
  opts: SpotCheckOptions,
  extras: {
    config?: ConstructorParameters<typeof X402Client>[1];
    chainId?: number;
    required?: X402PaymentRequired;
  } = {},
) {
  const { config = {}, chainId = 8453, required } = extras;
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

  it('pays when the supplied checker returns an explicit allow', async () => {
    const { result, spy } = await pay({
      checker: { checkBeforePay: async () => ({ allowed: true, verdict: 'allow' }) },
    });
    expect(result.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the checker returns allowed true without a verdict', async () => {
    const { result, spy } = await pay({
      checker: { checkBeforePay: async () => ({ allowed: true }) },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when the checker returns a non-allow', async () => {
    const { result, spy } = await pay({
      checker: { checkBeforePay: async () => ({ allowed: false }) },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(['deny', 'error', 'unknown', 'skip'] as const)(
    'fails closed when the checker returns allowed true with verdict %s',
    async (verdict) => {
      const { result, spy } = await pay({
        checker: { checkBeforePay: async () => ({ allowed: true, verdict }) },
      });
      expect(result.status).toBe(402);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it('pays a listed base-sepolia:84532 requirement', async () => {
    const required = challenge({
      network: 'base-sepolia:84532',
      asset: USDC_ADDRESSES['base-sepolia:84532'],
    });
    const { result, spy } = await pay({
      check: { payTo: PAY_TO, network: 'base-sepolia:84532', price: AMOUNT },
    }, {
      config: {
        supportedNetworks: ['base-sepolia:84532'],
        supportedAssets: { 'base-sepolia:84532': [USDC_ADDRESSES['base-sepolia:84532']] },
      },
      chainId: 84532,
      required,
    });
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
      checker: { checkBeforePay: async () => ({ allowed: true, verdict: 'allow' }) },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when listing matches but the checker returns a non-allow', async () => {
    const { result, spy } = await pay({
      check: { payTo: PAY_TO, network: 'base:8453', price: AMOUNT },
      checker: { checkBeforePay: async () => ({ allowed: false }) },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when checkBeforePay returns null', async () => {
    const { result, spy } = await pay({
      checker: { checkBeforePay: async () => null },
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
    const clock = createFakeClock();
    const { result, spy } = await pay({
      timeoutMs: 40,
      clock,
      load: async () => {
        clock.advance(25);
        return {
          checkBeforePay: async () => {
            clock.advance(25);
            return { allowed: true, verdict: 'allow' };
          },
        };
      },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when a caller hook never returns and the deadline fires', async () => {
    const clock = createFakeClock();
    let hookStarted!: () => void;
    const started = new Promise<void>((resolve) => { hookStarted = resolve; });
    const payment = pay(
      {
        timeoutMs: 40,
        clock,
        checker: { checkBeforePay: async () => ({ allowed: true, verdict: 'allow' }) },
      },
      {
        config: {
          onBeforePayment: () => {
            hookStarted();
            return new Promise(() => undefined);
          },
        },
      },
    );
    await started;
    clock.advance(40);
    const { result, spy } = await payment;
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when a checker returns allow after the deadline', async () => {
    const clock = createFakeClock();
    const { result, spy } = await pay({
      timeoutMs: 40,
      clock,
      checker: {
        checkBeforePay: async () => {
          clock.advance(50);
          return { allowed: true, verdict: 'allow' };
        },
      },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when an explicit allow arrives after a blocked event loop', async () => {
    const clock = createFakeClock();
    const { result, spy } = await pay({
      timeoutMs: 40,
      clock,
      checker: {
        checkBeforePay: async () => {
          clock.jump(50);
          return { allowed: true, verdict: 'allow' };
        },
      },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('aborts the checker signal when the shared deadline fires', async () => {
    const clock = createFakeClock();
    let signal: AbortSignal | undefined;
    let checkStarted!: () => void;
    const started = new Promise<void>((resolve) => { checkStarted = resolve; });
    const payment = pay({
      timeoutMs: 40,
      clock,
      checker: {
        checkBeforePay: (_url, opts) => {
          signal = opts.signal as AbortSignal;
          checkStarted();
          return new Promise(() => undefined);
        },
      },
    });
    await started;
    expect(signal?.aborted).toBe(false);
    clock.advance(40);
    const { result, spy } = await payment;
    expect(signal?.aborted).toBe(true);
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not invoke the checker when the caller onBeforePayment returns false', async () => {
    const checkBeforePay = vi.fn(async () => ({ allowed: true, verdict: 'allow' }));
    const { result, spy } = await pay(
      { checker: { checkBeforePay } },
      { config: { onBeforePayment: () => false } },
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
    }, {
      config: {
        supportedNetworks: ['ethereum:1'],
        supportedAssets: { 'ethereum:1': [USDC_ADDRESSES['ethereum:1']] },
      },
      chainId: 1,
      required,
    });
    expect(result.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fails closed on an unrecognized network', async () => {
    const spy = executeSpy();
    const hook = withSpotCheck({}, {
      checker: { checkBeforePay: async () => ({ allowed: true, verdict: 'allow' }) },
    }).onBeforePayment;
    const allowed = await hook!(
      challenge({ network: 'not-a-chain' }).accepts[0],
      URL,
    );
    expect(allowed).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when a hook rewrites terms that would otherwise match the listing', async () => {
    const { result, spy } = await pay({
      check: { payTo: PAY_TO, network: 'base:8453', price: AMOUNT },
    }, {
      config: {
        onBeforePayment: (req) => {
          req.amount = AMOUNT;
          req.payTo = PAY_TO;
          return true;
        },
      },
      required: challenge({ amount: '9999999' }),
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 60_001, 2 ** 31])(
    'rejects invalid timeoutMs %s at wrap time',
    (timeoutMs) => {
      const spy = executeSpy();
      expect(() => withSpotCheck({}, { timeoutMs })).toThrow(
        'withSpotCheck: timeoutMs must be a finite number greater than 0 and at most 60000',
      );
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it('accepts timeoutMs of 60000 at wrap time', () => {
    expect(() => withSpotCheck({}, { timeoutMs: 60_000 })).not.toThrow();
  });

  it('fails closed when listing-only expected exceeds the timeout budget', async () => {
    const clock = createFakeClock();
    const { result, spy } = await pay({
      timeoutMs: 40,
      clock,
      check: {
        expected: async () => {
          clock.advance(50);
          return { payTo: PAY_TO, network: 'base:8453', price: AMOUNT };
        },
      },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when a slow caller hook exhausts the listing-only deadline', async () => {
    const clock = createFakeClock();
    const { result, spy } = await pay({
      timeoutMs: 40,
      clock,
      check: { payTo: PAY_TO, network: 'base:8453', price: AMOUNT },
    }, {
      config: {
        onBeforePayment: async () => {
          clock.advance(50);
          return true;
        },
      },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('pays when static listing fields and expected listings agree', async () => {
    const { result, spy } = await pay({
      check: {
        payTo: PAY_TO,
        expected: () => ({ network: 'base:8453', price: AMOUNT }),
      },
    });
    expect(result.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fails closed when static payTo conflicts with expected payTo', async () => {
    const { result, spy } = await pay({
      check: {
        payTo: OTHER_PAY_TO,
        expected: () => ({ payTo: PAY_TO, network: 'base:8453', price: AMOUNT }),
      },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when static network conflicts with expected network', async () => {
    const { result, spy } = await pay({
      check: {
        network: 'ethereum:1',
        expected: () => ({ payTo: PAY_TO, network: 'base:8453', price: AMOUNT }),
      },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when static price conflicts with expected price', async () => {
    const { result, spy } = await pay({
      check: {
        price: '2000000',
        expected: () => ({ payTo: PAY_TO, network: 'base:8453', price: AMOUNT }),
      },
    });
    expect(result.status).toBe(402);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not patch X402Client after a wrapped payment or skip a later refuse', async () => {
    mockMerchant();
    const spy = executeSpy();
    const fetchBefore = X402Client.prototype.fetch;
    const settleBefore = X402Client.prototype.settle402AndRetry;
    const client = new X402Client(walletOnChain(8453), withSpotCheck({}, {
      check: { payTo: PAY_TO, network: 'base:8453', price: AMOUNT },
    }));
    const first = await client.fetch(URL);
    expect(first.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(X402Client.prototype.fetch).toBe(fetchBefore);
    expect(X402Client.prototype.settle402AndRetry).toBe(settleBefore);

    mockMerchant(challenge({ payTo: OTHER_PAY_TO }));
    const second = await client.fetch(URL);
    expect(second.status).toBe(402);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('exposes no fail-open or prePay skip flag', () => {
    const keys: Array<keyof SpotCheckOptions> = ['check', 'timeoutMs', 'checker', 'load', 'clock'];
    expect(keys).toHaveLength(5);
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
