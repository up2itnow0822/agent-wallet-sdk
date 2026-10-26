/**
 * Stellar x402 regression tests — findings 7, 10, 17, 21, 26.
 * @stellar/stellar-sdk is mocked; no network or funds are used.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@stellar/stellar-sdk', () => {
  class Account { constructor(readonly id: string, readonly seq: string) {} }
  class Asset { constructor(readonly code: string, readonly issuer: string) {} }
  class TransactionBuilder {
    ops: unknown[] = [];
    constructor(readonly account: Account, readonly opts: { networkPassphrase: string }) {}
    addOperation(op: unknown) { this.ops.push(op); return this; }
    addMemo() { return this; }
    setTimeout() { return this; }
    build() { return { toXDR: () => `XDR|${this.opts.networkPassphrase}|${JSON.stringify(this.ops)}` }; }
    static fromXDR(xdr: string, passphrase: string) {
      if (!xdr.includes(passphrase)) throw new Error('network mismatch');
      return {
        hash: () => Buffer.from((xdr.includes('EVIL') ? 'cd' : 'ab').repeat(32), 'hex'),
        timeBounds: { minTime: '0', maxTime: '1700000300' },
      };
    }
  }
  return {
    Account, Asset, TransactionBuilder, BASE_FEE: '100',
    Operation: { payment: (p: unknown) => ({ type: 'payment', ...(p as object) }) },
    Memo: { text: (t: string) => t },
  };
});

const {
  StellarX402Adapter, stellarX402Pay, StellarSpendBudget, StellarSubmissionUnknownError,
  StellarPaymentPolicyError, STELLAR_NETWORK, STELLAR_RECONCILE_HISTORY_MARGIN_S,
} = await import('../../src/x402/chains/stellar/index.js');

const HASH = 'ab'.repeat(32);
const SRC = 'G' + 'A'.repeat(55);
const DEST = 'G' + 'B'.repeat(55);
const OTHER = 'G' + 'C'.repeat(55);

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
function horizon(opts: {
  passphrase?: string;
  submit?: Route;
  confirm?: Route;
} = {}) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/') && !url.includes('/transactions')) {
      return new Response(JSON.stringify({ network_passphrase: opts.passphrase ?? STELLAR_NETWORK.pubnet.networkPassphrase }));
    }
    if (url.includes('/accounts/')) return new Response(JSON.stringify({ sequence: '123' }));
    if (init?.method === 'POST') {
      return opts.submit ? opts.submit(url, init) : new Response(JSON.stringify({ hash: HASH, ledger: 9, successful: true }));
    }
    if (url.includes(`/transactions/${HASH}`)) {
      return opts.confirm ? opts.confirm(url, init) : new Response(JSON.stringify({ hash: HASH, ledger: 9, successful: true }));
    }
    return new Response('not found', { status: 404 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const headers = (chains: string, amount = '1.5', dest = DEST) => ({
  'X-Payment-Chains': chains, 'X-Payment-Amount': amount, 'X-Payment-Destination': dest,
});
const signer = vi.fn(async (xdr: string) => xdr);

beforeEach(() => signer.mockClear());

describe('exact Stellar chain matching (finding 7)', () => {
  const pubnet = new StellarX402Adapter({ network: 'pubnet' });
  it.each(['stellar:testnet', 'stellar', 'stellar:pubnetx', 'mystellar:pubnet', 'eip155:8453'])('rejects %s on a pubnet adapter', (chains) => {
    expect(pubnet.parseX402Response(headers(chains)).supported).toBe(false);
  });
  it('accepts the exact chain id in a list', () => {
    expect(pubnet.parseX402Response(headers('eip155:8453, stellar:pubnet')).supported).toBe(true);
  });
  it('never pays a testnet challenge with a pubnet adapter', async () => {
    const { impl } = horizon();
    await expect(stellarX402Pay({
      responseHeaders: headers('stellar:testnet'), sourcePublicKey: SRC, sign: signer,
      policy: { maxPerPayment: '5', budget: new StellarSpendBudget('100') }, adapter: { fetchImpl: impl },
    })).rejects.toBeInstanceOf(StellarPaymentPolicyError);
    expect(signer).not.toHaveBeenCalled();
  });
});

describe('mandatory spending policy (finding 10)', () => {
  it('refuses to auto-pay without a cumulative budget', async () => {
    const { impl } = horizon();
    await expect(stellarX402Pay({
      responseHeaders: headers('stellar:pubnet'), sourcePublicKey: SRC, sign: signer,
      policy: { maxPerPayment: '5' } as never, adapter: { fetchImpl: impl },
    })).rejects.toThrow(/budget/);
    expect(signer).not.toHaveBeenCalled();
  });

  it('refuses to auto-pay without a policy', async () => {
    await expect(stellarX402Pay({ responseHeaders: headers('stellar:pubnet'), sourcePublicKey: SRC, sign: signer } as never))
      .rejects.toThrow(/spending policy/);
    expect(signer).not.toHaveBeenCalled();
  });
  it('enforces per-payment cap, allowlist, approval and cumulative budget before signing', async () => {
    const { impl } = horizon();
    const base = { sourcePublicKey: SRC, sign: signer, adapter: { fetchImpl: impl } };
    await expect(stellarX402Pay({ ...base, responseHeaders: headers('stellar:pubnet', '1000'), policy: { maxPerPayment: '5', budget: new StellarSpendBudget('100') } }))
      .rejects.toThrow(/exceeds/);
    await expect(stellarX402Pay({ ...base, responseHeaders: headers('stellar:pubnet', '1', OTHER), policy: { maxPerPayment: '5', allowedDestinations: [DEST], budget: new StellarSpendBudget('100') } }))
      .rejects.toThrow(/not allowed/);
    await expect(stellarX402Pay({ ...base, responseHeaders: headers('stellar:pubnet', '1'), policy: { maxPerPayment: '5', approve: () => false, budget: new StellarSpendBudget('100') } }))
      .rejects.toThrow(/not approved/);
    const budget = new StellarSpendBudget('2');
    await stellarX402Pay({ ...base, responseHeaders: headers('stellar:pubnet', '1.5'), policy: { maxPerPayment: '5', budget } });
    await expect(stellarX402Pay({ ...base, responseHeaders: headers('stellar:pubnet', '1'), policy: { maxPerPayment: '5', budget } }))
      .rejects.toThrow(/budget exceeded/);
    expect(signer).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed amounts and destinations', async () => {
    const { impl } = horizon();
    for (const [amount, dest] of [['1e3', DEST], ['-1', DEST], ['0.00000001', DEST], ['1', 'not-an-account']]) {
      await expect(stellarX402Pay({
        responseHeaders: headers('stellar:pubnet', amount, dest), sourcePublicKey: SRC, sign: signer,
        policy: { maxPerPayment: '5', budget: new StellarSpendBudget('100') }, adapter: { fetchImpl: impl },
      })).rejects.toBeInstanceOf(StellarPaymentPolicyError);
    }
    expect(signer).not.toHaveBeenCalled();
  });
});

describe('configured Horizon is used and must match the network (finding 17)', () => {
  it('sends every call to the configured Horizon', async () => {
    const { impl, calls } = horizon();
    const adapter = new StellarX402Adapter({ horizonUrl: 'https://private-horizon.example', fetchImpl: impl });
    const xdr = await adapter.buildPaymentTransaction({ destination: DEST, amount: '1', sourcePublicKey: SRC });
    await adapter.submitTransaction(xdr);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.includes('https://private-horizon.example'))).toBe(true);
  });
  it('refuses a Horizon that serves another network', async () => {
    const { impl } = horizon({ passphrase: STELLAR_NETWORK.testnet.networkPassphrase });
    const adapter = new StellarX402Adapter({ horizonUrl: 'https://private-horizon.example', fetchImpl: impl });
    await expect(adapter.buildPaymentTransaction({ destination: DEST, amount: '1', sourcePublicKey: SRC }))
      .rejects.toThrow(/does not serve the pubnet/);
  });
  it('refuses non-https Horizon URLs', () => {
    expect(() => new StellarX402Adapter({ horizonUrl: 'http://horizon.example' })).toThrow(/https/);
  });
});

describe('bounded Horizon I/O and ambiguous submission (finding 21)', () => {
  it('times out a stalled submission and reports unknown with the expected hash', async () => {
    const { impl } = horizon({
      submit: () => new Response(new ReadableStream({ start() { /* stall */ } })),
      confirm: () => new Response('{}', { status: 404 }),
    });
    const adapter = new StellarX402Adapter({ fetchImpl: impl, timeoutMs: 30 });
    const xdr = await adapter.buildPaymentTransaction({ destination: DEST, amount: '1', sourcePublicKey: SRC });
    const err = await adapter.submitTransaction(xdr).catch((e) => e);
    expect(err).toBeInstanceOf(StellarSubmissionUnknownError);
    expect(err.expectedHash).toBe(HASH);
  });
  it('keeps the budget reservation for an unknown submission', async () => {
    const { impl } = horizon({ submit: () => new Response('gateway timeout', { status: 504 }), confirm: () => new Response('{}', { status: 404 }) });
    const budget = new StellarSpendBudget('3');
    await expect(stellarX402Pay({
      responseHeaders: headers('stellar:pubnet', '2'), sourcePublicKey: SRC, sign: signer,
      policy: { maxPerPayment: '5', budget }, adapter: { fetchImpl: impl },
    })).rejects.toBeInstanceOf(StellarSubmissionUnknownError);
    expect(budget.unresolved()).toHaveLength(1);
    expect(budget.occupiedStroops).toBe(20_000_000n);
  });
});

describe('settlement verification (finding 26)', () => {
  it('does not treat a 2xx body without successful=true as settled', async () => {
    const { impl } = horizon({
      submit: () => new Response(JSON.stringify({ hash: HASH, ledger: 9 })),
      confirm: () => new Response('{}', { status: 404 }),
    });
    const adapter = new StellarX402Adapter({ fetchImpl: impl });
    const xdr = await adapter.buildPaymentTransaction({ destination: DEST, amount: '1', sourcePublicKey: SRC });
    await expect(adapter.submitTransaction(xdr)).rejects.toBeInstanceOf(StellarSubmissionUnknownError);
  });
  it('does not accept a 2xx body for a different transaction hash', async () => {
    const { impl } = horizon({
      submit: () => new Response(JSON.stringify({ hash: 'cd'.repeat(32), ledger: 9, successful: true })),
      confirm: () => new Response('{}', { status: 404 }),
    });
    const adapter = new StellarX402Adapter({ fetchImpl: impl });
    const xdr = await adapter.buildPaymentTransaction({ destination: DEST, amount: '1', sourcePublicKey: SRC });
    await expect(adapter.submitTransaction(xdr)).rejects.toBeInstanceOf(StellarSubmissionUnknownError);
  });
  it('requires ledger confirmation of the signed transaction', async () => {
    const { impl } = horizon({ confirm: () => new Response(JSON.stringify({ hash: HASH, successful: true })) });
    const adapter = new StellarX402Adapter({ fetchImpl: impl });
    const xdr = await adapter.buildPaymentTransaction({ destination: DEST, amount: '1', sourcePublicKey: SRC });
    await expect(adapter.submitTransaction(xdr)).rejects.toBeInstanceOf(StellarSubmissionUnknownError);
  });
  it('returns a confirmed result only after the confirmation read', async () => {
    const { impl } = horizon();
    const adapter = new StellarX402Adapter({ fetchImpl: impl });
    const xdr = await adapter.buildPaymentTransaction({ destination: DEST, amount: '1', sourcePublicKey: SRC });
    expect(await adapter.submitTransaction(xdr)).toEqual({ hash: HASH, ledger: 9, successful: true, network: 'pubnet' });
  });
  it('rejects a signed envelope for another network', async () => {
    const { impl } = horizon();
    const adapter = new StellarX402Adapter({ fetchImpl: impl });
    await expect(adapter.submitTransaction(`XDR|${STELLAR_NETWORK.testnet.networkPassphrase}|[]`))
      .rejects.toBeInstanceOf(StellarPaymentPolicyError);
  });
});


describe('review follow-ups (N1, N6)', () => {
  it('never broadcasts when the confirmation Horizon is unhealthy, and releases the reservation', async () => {
    const { impl, calls } = horizon();
    const confirmImpl = vi.fn(async (url: string, init?: RequestInit) =>
      url.startsWith('https://confirm.example') ? new Response('down', { status: 503 }) : impl(url, init)) as unknown as typeof fetch;
    const budget = new StellarSpendBudget('1');
    await expect(stellarX402Pay({
      responseHeaders: headers('stellar:pubnet', '1'), sourcePublicKey: SRC, sign: signer,
      policy: { maxPerPayment: '5', budget },
      adapter: { fetchImpl: confirmImpl, confirmationHorizonUrl: 'https://confirm.example' },
    })).rejects.toBeInstanceOf(StellarPaymentPolicyError);
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
    expect(budget.occupiedStroops).toBe(0n);
  });

  it('keeps the reservation when the confirmation lacks an explicit successful flag', async () => {
    const { impl } = horizon({ confirm: () => new Response(JSON.stringify({ hash: HASH, ledger: 9 })) });
    const budget = new StellarSpendBudget('1');
    await expect(stellarX402Pay({
      responseHeaders: headers('stellar:pubnet', '1'), sourcePublicKey: SRC, sign: signer,
      policy: { maxPerPayment: '5', budget }, adapter: { fetchImpl: impl },
    })).rejects.toBeInstanceOf(StellarSubmissionUnknownError);
    expect(budget.occupiedStroops).toBe(10_000_000n);
    expect(budget.unresolved()).toHaveLength(1);
  });

  it('refuses a signer that alters the policy-checked envelope', async () => {
    const { impl, calls } = horizon();
    const evil = vi.fn(async (xdr: string) => xdr.replace(DEST, 'EVIL'));
    const budget = new StellarSpendBudget('5');
    await expect(stellarX402Pay({
      responseHeaders: headers('stellar:pubnet', '1'), sourcePublicKey: SRC, sign: evil,
      policy: { maxPerPayment: '5', budget }, adapter: { fetchImpl: impl },
    })).rejects.toThrow(/differs from the policy-checked/);
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
    expect(budget.occupiedStroops).toBe(0n);
  });
});

describe('evidence-bound reconciliation of unknown reservations (Codex P2)', () => {
  const MAX_TIME = 1_700_000_300;
  const iso = (unix: number) => new Date(unix * 1000).toISOString();

  /** A reservation left unknown by a 504 submission whose confirmation 404s. */
  async function unknownReservation() {
    const { impl } = horizon({ submit: () => new Response('gateway timeout', { status: 504 }), confirm: () => new Response('{}', { status: 404 }) });
    const budget = new StellarSpendBudget('2');
    await expect(stellarX402Pay({
      responseHeaders: headers('stellar:pubnet', '2'), sourcePublicKey: SRC, sign: signer,
      policy: { maxPerPayment: '5', budget }, adapter: { fetchImpl: impl },
    })).rejects.toBeInstanceOf(StellarSubmissionUnknownError);
    const [pending] = budget.unresolved();
    expect(pending).toMatchObject({ hash: HASH, chainId: 'stellar:pubnet', maxTime: MAX_TIME });
    return { budget, id: pending.id };
  }

  function ledgerHorizon(opts: { tx?: () => Response; latest?: number; oldest?: number; passphrase?: string }) {
    return vi.fn(async (url: string) => {
      if (url.endsWith('/')) {
        return new Response(JSON.stringify({ network_passphrase: opts.passphrase ?? STELLAR_NETWORK.pubnet.networkPassphrase }));
      }
      if (url.includes(`/transactions/${HASH}`)) return opts.tx ? opts.tx() : new Response('{}', { status: 404 });
      if (url.includes('/ledgers?order=desc')) {
        return new Response(JSON.stringify({ _embedded: { records: [{ closed_at: iso(opts.latest ?? MAX_TIME + 60) }] } }));
      }
      if (url.includes('/ledgers?order=asc')) {
        return new Response(JSON.stringify({ _embedded: { records: [{ closed_at: iso(opts.oldest ?? MAX_TIME - 86_400) }] } }));
      }
      return new Response('?', { status: 500 });
    }) as unknown as typeof fetch;
  }

  it('releases a reservation whose transaction was included but failed', async () => {
    const { budget, id } = await unknownReservation();
    const adapter = new StellarX402Adapter({
      fetchImpl: ledgerHorizon({ tx: () => new Response(JSON.stringify({ hash: HASH, ledger: 10, successful: false })) }),
    });
    expect((await budget.reconcile(id, adapter)).status).toBe('released');
    expect(budget.occupiedStroops).toBe(0n);
    expect(budget.unresolved()).toHaveLength(0);
  });

  it('commits a reservation whose transaction succeeded', async () => {
    const { budget, id } = await unknownReservation();
    const adapter = new StellarX402Adapter({
      fetchImpl: ledgerHorizon({ tx: () => new Response(JSON.stringify({ hash: HASH, ledger: 10, successful: true })) }),
    });
    expect((await budget.reconcile(id, adapter)).status).toBe('committed');
    expect(budget.occupiedStroops).toBe(20_000_000n);
    expect(budget.unresolved()).toHaveLength(0);
  });

  it('releases a never-applied transaction only after its maxTime, with covering history', async () => {
    const { budget, id } = await unknownReservation();
    const adapter = new StellarX402Adapter({ fetchImpl: ledgerHorizon({}) });
    expect((await budget.reconcile(id, adapter)).status).toBe('released');
    expect(budget.occupiedStroops).toBe(0n);
  });

  it('keeps the reservation while the transaction could still apply', async () => {
    const { budget, id } = await unknownReservation();
    const adapter = new StellarX402Adapter({ fetchImpl: ledgerHorizon({ latest: MAX_TIME }) });
    expect((await budget.reconcile(id, adapter)).status).toBe('unresolved');
    expect(budget.occupiedStroops).toBe(20_000_000n);
  });

  it('keeps the reservation when Horizon history does not cover the validity window', async () => {
    const { budget, id } = await unknownReservation();
    const adapter = new StellarX402Adapter({
      fetchImpl: ledgerHorizon({ oldest: MAX_TIME - STELLAR_RECONCILE_HISTORY_MARGIN_S + 1 }),
    });
    expect((await budget.reconcile(id, adapter)).status).toBe('unresolved');
    expect(budget.occupiedStroops).toBe(20_000_000n);
  });

  it('keeps the reservation on ambiguous lookups or another network', async () => {
    const { budget, id } = await unknownReservation();
    const flaky = new StellarX402Adapter({ fetchImpl: ledgerHorizon({ tx: () => new Response('busy', { status: 503 }) }) });
    expect((await budget.reconcile(id, flaky)).status).toBe('unresolved');
    const testnet = new StellarX402Adapter({ network: 'testnet', fetchImpl: ledgerHorizon({ passphrase: STELLAR_NETWORK.testnet.networkPassphrase }) });
    expect((await budget.reconcile(id, testnet)).status).toBe('unresolved');
    const wrongHorizon = new StellarX402Adapter({ fetchImpl: ledgerHorizon({ passphrase: STELLAR_NETWORK.testnet.networkPassphrase }) });
    expect((await budget.reconcile(id, wrongHorizon)).status).toBe('unresolved');
    expect(budget.occupiedStroops).toBe(20_000_000n);
  });
});
