/**
 * x402 request-binding regressions — findings 23, 25, 27 and 28.
 * Transfers are mocked; no network or funds are used.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { X402Client, X402IntentTermsConflictError } from '../client.js';
import { wrapWithX402 } from '../middleware.js';

const URL = 'https://merchant.example/purchase';
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAYEE = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const PAYEE_HASH = `0x${'bb'.repeat(32)}` as const;
const FEE_HASH = `0x${'aa'.repeat(32)}` as const;

const { transfer, checkBudget } = vi.hoisted(() => ({ transfer: vi.fn(), checkBudget: vi.fn() }));
vi.mock('../../index.js', () => ({
  submitAgentTransferToken: (...args: unknown[]) => transfer(...args),
  checkBudget: (...args: unknown[]) => checkBudget(...args),
}));

function wallet() {
  transfer.mockReset().mockImplementation(async (_w, args: { to: string }) =>
    args.to.toLowerCase() === PAYEE.toLowerCase() ? PAYEE_HASH : FEE_HASH);
  checkBudget.mockResolvedValue({ perTxLimit: 2n ** 255n, remainingInPeriod: 2n ** 255n });
  return {
    address: WALLET, chain: { id: 8453 },
    publicClient: { waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })), getTransaction: vi.fn() },
  };
}

function challenge(resourceUrl: string, extra: Record<string, unknown> = {}) {
  return {
    x402Version: 1,
    resource: { url: resourceUrl, description: 'Purchase', mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact', network: 'base:8453', asset: TOKEN, amount: '1000000',
      payTo: PAYEE, maxTimeoutSeconds: 30, extra,
    }],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('x402 resource binding includes the query (finding 23)', () => {
  it('refuses a challenge for a different query than the request', async () => {
    const w = wallet();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(challenge('/purchase?item=other')), { status: 402 }));
    const res = await new X402Client(w).fetch(`${URL}?item=trusted`);
    expect(res.status).toBe(402);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('refuses a query-less resource for a request that has a query', async () => {
    const w = wallet();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(challenge('/purchase')), { status: 402 }));
    expect((await new X402Client(w).fetch(`${URL}?item=trusted`)).status).toBe(402);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('pays when origin, path and query all match', async () => {
    const w = wallet();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_i, init) =>
      new Headers(init?.headers).has('X-PAYMENT')
        ? new Response('ok')
        : new Response(JSON.stringify(challenge('/purchase?item=trusted')), { status: 402 }));
    expect((await new X402Client(w).fetch(`${URL}?item=trusted`)).status).toBe(200);
  });
});

describe('x402 402 body fallback is bounded (finding 25)', () => {
  it('ignores an oversized JSON challenge body without paying', async () => {
    const w = wallet();
    const big = { ...challenge('/purchase'), padding: 'x'.repeat(200_000) };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(big), { status: 402 }));
    expect((await new X402Client(w).fetch(URL)).status).toBe(402);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('ignores a challenge with too many payment options', async () => {
    const w = wallet();
    const many = challenge('/purchase');
    many.accepts = Array.from({ length: 40 }, () => many.accepts[0]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(many), { status: 402 }));
    expect((await new X402Client(w).fetch(URL)).status).toBe(402);
    expect(transfer).not.toHaveBeenCalled();
  });
});

describe('explicit intent ids bind the request identity (finding 27)', () => {
  it('never replays a proof for a different body under the same merchant nonce', async () => {
    const w = wallet();
    const proofsFor: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_i, init) => {
      if (new Headers(init?.headers).has('X-PAYMENT')) {
        proofsFor.push(String(init?.body));
        return new Response('ok');
      }
      return new Response(JSON.stringify(challenge('/purchase', { nonce: 'order-1' })), { status: 402 });
    });
    const client = new X402Client(w);
    expect((await client.fetch(URL, { method: 'POST', body: 'qty=1' })).status).toBe(200);
    const payeeTransfers = () => transfer.mock.calls.filter(([, a]) => (a as { to: string }).to === PAYEE).length;
    expect(payeeTransfers()).toBe(1);
    await expect(client.fetch(URL, { method: 'POST', body: 'qty=1000' })).rejects.toBeInstanceOf(X402IntentTermsConflictError);
    expect(payeeTransfers()).toBe(1);
    expect(proofsFor).toEqual(['qty=1']);
  });

  it('also binds caller context (headers) for explicit intents', async () => {
    const w = wallet();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_i, init) =>
      new Headers(init?.headers).has('X-PAYMENT')
        ? new Response('ok')
        : new Response(JSON.stringify(challenge('/purchase', { idempotencyKey: 'k-1' })), { status: 402 }));
    const client = new X402Client(w);
    await client.fetch(URL, { headers: { Authorization: 'Bearer tenant-a' } });
    await expect(client.fetch(URL, { headers: { Authorization: 'Bearer tenant-b' } }))
      .rejects.toBeInstanceOf(X402IntentTermsConflictError);
  });
});

describe('wrapWithX402 snapshots before the first hop (finding 28)', () => {
  it('pays for and retries the bytes that were challenged, not later mutations', async () => {
    const w = wallet();
    const body = new Uint8Array([1, 2, 3]);
    const retried: number[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (new Headers(init?.headers).has('X-PAYMENT')) {
        retried.push(Array.from(init!.body as Uint8Array));
        return new Response('ok');
      }
      await gate; // merchant delays its 402
      return new Response(JSON.stringify(challenge('/purchase')), { status: 402 });
    }) as unknown as typeof fetch;
    const wrapped = wrapWithX402(fetchFn, w);
    const pending = wrapped(URL, { method: 'POST', body });
    await Promise.resolve();
    body[0] = 99; // caller mutates while the 402 is delayed
    release();
    expect((await pending).status).toBe(200);
    expect(retried).toEqual([[1, 2, 3]]);
  });
});

describe('pathological 402 nesting (review follow-up)', () => {
  it('returns the 402 instead of throwing on deeply nested extra data', async () => {
    const w = wallet();
    const deep = '['.repeat(22_000) + ']'.repeat(22_000); // fits the 64 KiB header, too deep to re-serialize
    const body = JSON.stringify(challenge('/purchase')).replace('"extra":{}', `"extra":{"x":${deep}}`);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(null, { status: 402, headers: { 'payment-required': btoa(body) } }));
    const res = await new X402Client(w).fetch(URL);
    expect(res.status).toBe(402);
    expect(transfer).not.toHaveBeenCalled();
  });
});
