/**
 * Stellar x402 regression tests — findings 7, 10, 17, 21, 26.
 * @stellar/stellar-sdk is mocked; no network or funds are used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@stellar/stellar-sdk', () => {
  // Captured so the SDK mock keeps working when a test hides the Node global.
  const NodeBuffer = Buffer;
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
        hash: () => NodeBuffer.from((xdr.includes('EVIL') ? 'cd' : 'ab').repeat(32), 'hex'),
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

  it('keeps the reservation when the Horizon switches networks after the 404 (Codex round 5)', async () => {
    const { budget, id } = await unknownReservation();
    let rootCalls = 0;
    const base = ledgerHorizon({});
    const switching = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/')) {
        rootCalls += 1;
        const passphrase = rootCalls === 1 ? STELLAR_NETWORK.pubnet.networkPassphrase : STELLAR_NETWORK.testnet.networkPassphrase;
        return new Response(JSON.stringify({ network_passphrase: passphrase }));
      }
      return base(url, init);
    }) as unknown as typeof fetch;
    const r = await budget.reconcile(id, new StellarX402Adapter({ fetchImpl: switching }));
    expect(r.status).toBe('unresolved');
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

describe('Horizon network is re-checked before every submission (Codex round 4)', () => {
  it('refuses to broadcast when the Horizon switches networks while the signer runs', async () => {
    let passphrase = STELLAR_NETWORK.pubnet.networkPassphrase;
    const posts: string[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/')) return new Response(JSON.stringify({ network_passphrase: passphrase }));
      if (url.includes('/accounts/')) return new Response(JSON.stringify({ sequence: '123' }));
      if (init?.method === 'POST') { posts.push(url); return new Response(JSON.stringify({ hash: HASH, ledger: 9, successful: true })); }
      return new Response(JSON.stringify({ hash: HASH, ledger: 9, successful: true }));
    }) as unknown as typeof fetch;
    const slowSigner = vi.fn(async (xdr: string) => {
      passphrase = STELLAR_NETWORK.testnet.networkPassphrase; // backend changes mid-signing
      return xdr;
    });
    const budget = new StellarSpendBudget('5');
    await expect(stellarX402Pay({
      responseHeaders: headers('stellar:pubnet', '1'), sourcePublicKey: SRC, sign: slowSigner,
      policy: { maxPerPayment: '5', budget }, adapter: { fetchImpl: impl },
    })).rejects.toBeInstanceOf(StellarPaymentPolicyError);
    expect(posts).toHaveLength(0);
    expect(budget.occupiedStroops).toBe(0n);
  });

  it('re-checks on every call of a reused adapter', async () => {
    const { impl, calls } = horizon();
    const adapter = new StellarX402Adapter({ fetchImpl: impl });
    const xdr = await adapter.buildPaymentTransaction({ destination: DEST, amount: '1', sourcePublicKey: SRC });
    await adapter.submitTransaction(xdr);
    await adapter.submitTransaction(xdr);
    expect(calls.filter((c) => c.endsWith('/') && c.startsWith('GET')).length).toBeGreaterThanOrEqual(5);
  });
});

describe('4xx rejections are decided from the ledger (Codex round 8)', () => {
  const rejected = (code: string) => () => new Response(JSON.stringify({ extras: { result_codes: { transaction: code } } }), { status: 400 });

  it('keeps the reservation for tx_bad_seq when the hash is not yet on the ledger', async () => {
    const { impl } = horizon({ submit: rejected('tx_bad_seq'), confirm: () => new Response('{}', { status: 404 }) });
    const budget = new StellarSpendBudget('5');
    await expect(stellarX402Pay({
      responseHeaders: headers('stellar:pubnet', '1'), sourcePublicKey: SRC, sign: signer,
      policy: { maxPerPayment: '5', budget }, adapter: { fetchImpl: impl },
    })).rejects.toBeInstanceOf(StellarSubmissionUnknownError);
    expect(budget.occupiedStroops).toBe(10_000_000n);
    expect(budget.unresolved()).toHaveLength(1);
  });

  it('commits when a proxy retry got tx_bad_seq but the first submission landed', async () => {
    const { impl } = horizon({ submit: rejected('tx_bad_seq') }); // confirm: successful
    const budget = new StellarSpendBudget('5');
    const r = await stellarX402Pay({
      responseHeaders: headers('stellar:pubnet', '1'), sourcePublicKey: SRC, sign: signer,
      policy: { maxPerPayment: '5', budget }, adapter: { fetchImpl: impl },
    });
    expect(r.successful).toBe(true);
    expect(budget.occupiedStroops).toBe(10_000_000n);
    expect(budget.unresolved()).toHaveLength(0);
  });

  it('commits a 4xx-coded submission when the ledger shows it applied', async () => {
    const { impl } = horizon({ submit: rejected('tx_bad_auth') }); // confirm: successful
    const budget = new StellarSpendBudget('5');
    const r = await stellarX402Pay({
      responseHeaders: headers('stellar:pubnet', '1'), sourcePublicKey: SRC, sign: signer,
      policy: { maxPerPayment: '5', budget }, adapter: { fetchImpl: impl },
    });
    expect(r.successful).toBe(true);
    expect(budget.occupiedStroops).toBe(10_000_000n);
  });

  it('releases a 4xx-coded submission only when the ledger shows it failed', async () => {
    const { impl } = horizon({
      submit: rejected('tx_bad_auth'),
      confirm: () => new Response(JSON.stringify({ hash: HASH, ledger: 9, successful: false })),
    });
    const budget = new StellarSpendBudget('5');
    await expect(stellarX402Pay({
      responseHeaders: headers('stellar:pubnet', '1'), sourcePublicKey: SRC, sign: signer,
      policy: { maxPerPayment: '5', budget }, adapter: { fetchImpl: impl },
    })).rejects.toThrow(/included but failed/);
    expect(budget.occupiedStroops).toBe(0n);
  });
});

describe('no Horizon result code releases a reservation on its own (Codex round 9)', () => {
  const rejected = (code: string) => () => new Response(JSON.stringify({ extras: { result_codes: { transaction: code } } }), { status: 400 });
  // tx_too_early: the same signed bytes become valid later. The others can be
  // reported falsely by a forwarding or untrusted endpoint, or change with
  // account signers / protocol version within the envelope's time bounds.
  it.each(['tx_too_early', 'tx_bad_auth', 'tx_bad_auth_extra', 'tx_not_supported', 'tx_malformed', 'tx_missing_operation'])(
    'keeps the reservation for %s until the ledger decides',
    async (code) => {
      const { impl } = horizon({ submit: rejected(code), confirm: () => new Response('{}', { status: 404 }) });
      const budget = new StellarSpendBudget('5');
      await expect(stellarX402Pay({
        responseHeaders: headers('stellar:pubnet', '1'), sourcePublicKey: SRC, sign: signer,
        policy: { maxPerPayment: '5', budget }, adapter: { fetchImpl: impl },
      })).rejects.toBeInstanceOf(StellarSubmissionUnknownError);
      expect(budget.occupiedStroops).toBe(10_000_000n);
      expect(budget.unresolved()).toEqual([
        expect.objectContaining({ hash: HASH, chainId: 'stellar:pubnet', maxTime: 1_700_000_300 }),
      ]);
    },
  );

  it('does not export a release allowlist', async () => {
    const root = await import('../../src/index.js') as Record<string, unknown>;
    const x402 = await import('../../src/x402/index.js') as Record<string, unknown>;
    expect(root.STELLAR_DETERMINISTIC_REJECTIONS).toBeUndefined();
    expect(x402.STELLAR_DETERMINISTIC_REJECTIONS).toBeUndefined();
  });
});

describe('reconcile requires the recorded submission network (Codex round 8)', () => {
  it('leaves a reservation without a recorded chain unresolved', async () => {
    const budget = new StellarSpendBudget('5');
    const id = budget.reserve('1');
    budget.markUnknown(id, HASH, { maxTime: 1_700_000_300 }); // no chainId
    const r = await budget.reconcile(id, new StellarX402Adapter({ network: 'testnet' }));
    expect(r.status).toBe('unresolved');
    expect(r.reason).toMatch(/network was recorded/);
    expect(budget.occupiedStroops).toBe(10_000_000n);
  });
});

describe('Stellar API is exported from the package root (Codex round 8)', () => {
  it('exposes the mandatory budget, adapter, helper and errors', async () => {
    const root = await import('../../src/index.js');
    for (const name of ['StellarSpendBudget', 'StellarX402Adapter', 'stellarX402Pay', 'StellarSubmissionUnknownError',
      'StellarPaymentPolicyError', 'StellarTransactionRejectedError', 'stellarAmountToStroops']) {
      expect(typeof (root as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});

describe('Stellar hashing does not need the Node Buffer global (Codex post-merge #98)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('computes the transaction identity in a runtime without Buffer', async () => {
    const adapter = new StellarX402Adapter({ network: 'pubnet' });
    const xdr = `XDR|${STELLAR_NETWORK.pubnet.networkPassphrase}|[]`;
    vi.stubGlobal('Buffer', undefined);
    expect(await adapter.transactionIdentity(xdr)).toEqual({ hash: HASH, maxTime: 1_700_000_300 });
  });

  it('accepts the hash as a plain Uint8Array', async () => {
    const { TransactionBuilder } = await import('@stellar/stellar-sdk') as unknown as { TransactionBuilder: { fromXDR: (x: string, p: string) => { hash: () => Uint8Array } } };
    const spy = vi.spyOn(TransactionBuilder, 'fromXDR').mockReturnValue({ hash: () => new Uint8Array(32).fill(0xab) } as never);
    const adapter = new StellarX402Adapter({ network: 'pubnet' });
    expect((await adapter.transactionIdentity('XDR')).hash).toBe(HASH);
    spy.mockRestore();
  });
});
