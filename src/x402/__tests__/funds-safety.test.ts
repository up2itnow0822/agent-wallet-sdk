import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData } from 'viem';
import { AgentAccountV2Abi } from '../../abi.js';
import {
  X402Client,
  X402SettlementUnknownError,
  X402_MAX_CACHED_SETTLEMENTS,
  X402_SETTLEMENT_RETRY_WINDOW_MS,
} from '../client.js';
import { X402_PROTOCOL_FEE_COLLECTOR } from '../fee.js';
import { createX402Fetch, wrapWithX402 } from '../middleware.js';
import { parseNetworkChainId } from '../multi-asset.js';
import { AgentWalletVerificationError } from '../../wallet-verification-error.js';

const URL = 'https://merchant.example/purchase';
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAYEE = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const FEE_HASH = `0x${'aa'.repeat(32)}` as const;
const PAYEE_HASH = `0x${'bb'.repeat(32)}` as const;
const { transfer, checkBudget } = vi.hoisted(() => ({
  transfer: vi.fn(),
  checkBudget: vi.fn(),
}));
vi.mock('../../index.js', () => ({
  submitAgentTransferToken: (...args: unknown[]) => transfer(...args),
  checkBudget: (...args: unknown[]) => checkBudget(...args),
}));

function challenge(unkeyed = true) {
  return {
    x402Version: 1,
    resource: { url: '/purchase', description: 'Purchase', mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact', network: 'base:8453', asset: TOKEN, amount: '1000000',
      payTo: PAYEE, maxTimeoutSeconds: 30, extra: unkeyed ? {} : { nonce: 'purchase-1' },
    }],
  };
}

function setup() {
  const debits: Array<{ to: string; amount: bigint; data: string }> = [];
  transfer.mockImplementation(async (_wallet, args) => {
    const data = encodeFunctionData({
      abi: AgentAccountV2Abi, functionName: 'agentTransferToken',
      args: [args.token, args.to, args.amount],
    });
    debits.push({ ...args, data });
    return args.to === X402_PROTOCOL_FEE_COLLECTOR ? FEE_HASH : PAYEE_HASH;
  });
  checkBudget.mockResolvedValue({ perTxLimit: 2n ** 256n - 1n, remainingInPeriod: 2n ** 256n - 1n });
  const wallet = {
    address: WALLET, chain: { id: 8453 },
    publicClient: {
      waitForTransactionReceipt: vi.fn(async (_args: { hash: string }) => ({ status: 'success' })),
      getTransaction: vi.fn(),
    },
  };
  return { wallet, debits };
}

function merchant(required: ReturnType<typeof challenge>, paidFailure?: Error) {
  const proofs: Array<Record<string, any>> = [];
  const fetchFn = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const header = new Headers(init?.headers).get('X-PAYMENT');
    if (header) {
      proofs.push(JSON.parse(Buffer.from(header, 'base64').toString('utf8')));
      if (paidFailure) throw paidFailure;
      return new Response('paid', { status: 200 });
    }
    // A well-formed challenge names the exact resource requested, query included.
    const search = typeof _input === 'string' ? new globalThis.URL(_input).search : '';
    const bound = { ...required, resource: { ...required.resource, url: required.resource.url + search } };
    return new Response(JSON.stringify(bound), { status: 402 });
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchFn);
  return { fetchFn, proofs };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  transfer.mockReset();
  checkBudget.mockReset();
});

describe('x402 funds-safety regressions', () => {
  it('sends UTF-8 proof for Unicode merchant metadata without a second charge', async () => {
    const { wallet, debits } = setup();
    const required = challenge(false);
    required.resource.description = '€ — 東京 🛒';
    const { proofs } = merchant(required);
    const client = new X402Client(wallet);

    expect((await client.fetch(URL)).status).toBe(200);
    expect((await client.fetch(URL)).status).toBe(200);
    expect(proofs.map(proof => proof.resource.description)).toEqual(['€ — 東京 🛒', '€ — 東京 🛒']);
    expect(proofs[0].payload.idempotencyKey).toBe(proofs[1].payload.idempotencyKey);
    expect(debits.map(debit => debit.amount)).toEqual([7700n, 1000000n]);
    expect(client.getDailySpendSummary().global).toBe(1007700n);
  });

  it('decodes UTF-8 PAYMENT-REQUIRED headers without corrupting Unicode', async () => {
    const { wallet } = setup();
    const required = challenge();
    required.resource.description = '€ 東京';
    const response = new Response(null, {
      status: 402,
      headers: { 'payment-required': Buffer.from(JSON.stringify(required), 'utf8').toString('base64') },
    });
    expect((await new X402Client(wallet).parse402Response(response))?.resource.description).toBe('€ 東京');
  });

  it.each(['not-an-address', '0x1234'])('rejects invalid payee %s before charging the fee', async payTo => {
    const { wallet, debits } = setup();
    const required = challenge();
    required.accepts[0].payTo = payTo;
    merchant(required);
    const client = new X402Client(wallet);
    expect((await client.fetch(URL)).status).toBe(402);
    expect(debits).toEqual([]);
    expect(client.getDailySpendSummary().global).toBe(0n);
  });

  it('rejects a uint256-overflow amount before charging the fee', async () => {
    const { wallet, debits } = setup();
    const required = challenge();
    required.accepts[0].amount = (2n ** 256n).toString();
    merchant(required);
    checkBudget.mockResolvedValue({ perTxLimit: 2n ** 260n, remainingInPeriod: 2n ** 260n });
    const client = new X402Client(wallet, { globalDailyLimit: 2n ** 260n, globalPerRequestMax: 2n ** 260n });
    expect((await client.fetch(URL)).status).toBe(402);
    expect(debits).toEqual([]);
  });

  it('prepares proof before approval can mutate merchant-controlled fields', async () => {
    const { wallet, debits } = setup();
    const { proofs } = merchant(challenge());
    const client = new X402Client(wallet, {
      onBeforePayment: req => {
        req.payTo = 'not-an-address';
        req.extra.loop = req.extra;
        return true;
      },
    });
    expect((await client.fetch(URL)).status).toBe(200);
    expect(debits[1].to).toBe(PAYEE);
    expect(proofs[0].accepted.payTo).toBe(PAYEE);
  });

  it('rejects unencodable proof before spending', async () => {
    const { wallet, debits } = setup();
    merchant(challenge());
    const client = new X402Client(wallet);
    const invalid = challenge();
    (invalid.accepts[0].extra as Record<string, unknown>).value = 1n;
    vi.spyOn(client, 'parse402Response').mockResolvedValue(invalid);
    await expect(client.fetch(URL)).rejects.toThrow();
    expect(debits).toEqual([]);
  });

  it.each(['fee', 'payee'] as const)('locks an accepted %s submission whose RPC response is lost', async phase => {
    const { wallet, debits } = setup();
    const send = transfer.getMockImplementation()!;
    transfer.mockImplementation(async (...args) => {
      const hash = await send(...args);
      const sentPhase = args[1].to === X402_PROTOCOL_FEE_COLLECTOR ? 'fee' : 'payee';
      if (sentPhase === phase) throw new TypeError('fetch failed');
      return hash;
    });
    const { proofs } = merchant(challenge(false));
    const client = new X402Client(wallet, { globalDailyLimit: 1007700n });
    const firstError = await client.fetch(URL).catch(error => error);
    expect(firstError).toBeInstanceOf(X402SettlementUnknownError);
    expect(firstError).toMatchObject({ phase, retrySafe: false });
    expect(client.budgetTracker.getReservedSummary().global).toBe(1007700n);
    const debitCount = debits.length;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86400000);
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(X402SettlementUnknownError);
    expect(debits).toHaveLength(debitCount);
    expect(proofs).toEqual([]);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1007700n);
  });

  it('keeps the same unkeyed request locked after a no-hash submission failure', async () => {
    const { wallet, debits } = setup();
    const send = transfer.getMockImplementation()!;
    transfer.mockImplementation(async (...args) => {
      await send(...args);
      throw new Error('HTTP request failed.');
    });
    merchant(challenge());
    const client = new X402Client(wallet);
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(X402SettlementUnknownError);
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(X402SettlementUnknownError);
    expect(debits).toHaveLength(1);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1007700n);
  });

  it('retains a malformed hash returned by submission as unknown', async () => {
    const { wallet } = setup();
    transfer.mockResolvedValue(undefined);
    merchant(challenge());
    const client = new X402Client(wallet);
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(X402SettlementUnknownError);
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(X402SettlementUnknownError);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1007700n);
    expect(wallet.publicClient.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('carries confirmed payment evidence when the paid HTTP retry fails', async () => {
    const { wallet, debits } = setup();
    merchant(challenge(), new TypeError('fetch failed'));
    const client = new X402Client(wallet);
    const error = await client.fetch(URL).catch(error => error);
    expect(error).toMatchObject({
      name: 'X402PaidRequestError', txHash: PAYEE_HASH, txHashes: [PAYEE_HASH, FEE_HASH],
      receipt: { status: 'success', transactionHash: PAYEE_HASH }, retrySafe: false,
    });
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 15, 12) + X402_SETTLEMENT_RETRY_WINDOW_MS + 1);
    await expect(client.fetch(URL)).rejects.toMatchObject({ name: 'X402PaidRequestError' });
    expect(debits).toHaveLength(2);
    expect(client.getDailySpendSummary().global).toBe(1007700n);
  });

  it.each(['http://merchant.example/purchase', 'http://127.0.0.1/purchase'])('refuses automatic payment over %s by default', async url => {
    const { wallet, debits } = setup();
    merchant(challenge());
    expect((await new X402Client(wallet).fetch(url)).status).toBe(402);
    expect(debits).toEqual([]);
  });

  it('requires the HTTP development opt-in to be loopback scoped', async () => {
    const { wallet, debits } = setup();
    const { fetchFn } = merchant(challenge());
    const config = { allowInsecureHttpForDevelopment: true } as any;
    expect((await new X402Client(wallet, config).fetch('http://127.0.0.1/purchase')).status).toBe(200);
    const wrapped = wrapWithX402(fetchFn as typeof fetch, wallet, config);
    expect((await wrapped('http://merchant.example/purchase')).status).toBe(402);
    expect(debits).toHaveLength(2);
  });

  it.each(['fee', 'payee'] as const)('reconciles a no-hash %s submission only after verifying the submitted call', async phase => {
    const { wallet, debits } = setup();
    const send = transfer.getMockImplementation()!;
    let loseResponse = true;
    transfer.mockImplementation(async (...args) => {
      const hash = await send(...args);
      if (loseResponse && (args[1].to === X402_PROTOCOL_FEE_COLLECTOR ? 'fee' : 'payee') === phase) {
        loseResponse = false;
        throw new Error('RPC response lost');
      }
      return hash;
    });
    merchant(challenge(false));
    const client = new X402Client(wallet);
    const error = await client.fetch(URL).catch(error => error);
    const txHash = phase === 'fee' ? FEE_HASH : PAYEE_HASH;
    wallet.publicClient.getTransaction.mockResolvedValue({
      hash: txHash, chainId: 8453, to: WALLET, input: debits[debits.length - 1].data, value: 0n,
    });
    expect(await (client as any).reconcileSubmission({ intentKey: error.intentKey, phase, txHash })).toBe('confirmed');
    expect((await client.fetch(URL)).status).toBe(200);
    expect(debits.map(debit => debit.amount)).toEqual([7700n, 1000000n]);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
    expect(client.getDailySpendSummary().global).toBe(1007700n);
  });

  it.each(['to', 'input', 'chainId', 'hash'] as const)('refuses reconciliation when transaction %s differs from the attempted call', async field => {
    const { wallet, debits } = setup();
    const send = transfer.getMockImplementation()!;
    transfer.mockImplementation(async (...args) => {
      await send(...args);
      throw new Error('RPC response lost');
    });
    const { proofs } = merchant(challenge(false));
    const client = new X402Client(wallet);
    const error = await client.fetch(URL).catch(error => error);
    const unrelated: Record<string, unknown> = {
      hash: FEE_HASH, chainId: 8453, to: WALLET, input: debits[0].data, value: 0n,
    };
    unrelated[field] = field === 'chainId' ? 1 : field === 'input' ? '0x' : PAYEE_HASH;
    wallet.publicClient.getTransaction.mockResolvedValue(unrelated);
    await expect((client as any).reconcileSubmission({
      intentKey: error.intentKey, phase: 'fee', txHash: FEE_HASH,
    })).rejects.toBeInstanceOf(X402SettlementUnknownError);
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(X402SettlementUnknownError);
    expect(debits).toHaveLength(1);
    expect(proofs).toEqual([]);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1007700n);
  });

  it('bounds confirmed request cache by refusing new intents without evicting live proofs', async () => {
    const { wallet, debits } = setup();
    merchant(challenge(false));
    const client = new X402Client(wallet);
    await client.fetch(URL);
    const entries = (client as any).paymentSettlements as Map<string, unknown>;
    const original = entries.values().next().value;
    for (let i = 1; i < X402_MAX_CACHED_SETTLEMENTS; i++) entries.set(`occupied-${i}`, original);
    await expect(client.fetch(`${URL}?new-purchase=1`)).rejects.toMatchObject({ name: 'X402SettlementBacklogError' });
    expect((await client.fetch(URL)).status).toBe(200);
    expect(debits).toHaveLength(2);
    expect(entries.size).toBe(X402_MAX_CACHED_SETTLEMENTS);
  });

  it('refuses an HTTPS challenge reached after an HTTP downgrade', async () => {
    const { wallet, debits } = setup();
    const downgraded = new Response(JSON.stringify(challenge()), { status: 402 });
    Object.defineProperty(downgraded, 'url', { value: URL.replace('https:', 'http:') });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(downgraded);
    expect(await new X402Client(wallet).fetch(URL, { redirect: 'follow' })).toBe(downgraded);
    expect(debits).toEqual([]);
  });

  it('never follows a redirect carrying payment proof even when unpaid requests opted into follow', async () => {
    const { wallet, debits } = setup();
    const destinations: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (!new Headers(init?.headers).has('X-PAYMENT')) {
        return new Response(JSON.stringify(challenge()), { status: 402 });
      }
      if (init?.redirect === 'error') throw new TypeError('redirect blocked');
      destinations.push('http://attacker.example');
      return new Response('stolen proof', { status: 200 });
    });
    const client = new X402Client(wallet);
    await expect(client.fetch(URL, { redirect: 'follow' })).rejects.toMatchObject({
      name: 'X402PaidRequestError', txHash: PAYEE_HASH,
    });
    expect(destinations).toEqual([]);
    expect(debits).toHaveLength(2);
  });

  it('releases an explicit budget-read failure before submission and allows a later attempt', async () => {
    const { wallet, debits } = setup();
    merchant(challenge(false));
    checkBudget.mockRejectedValueOnce(new TypeError('budget RPC unavailable'));
    const client = new X402Client(wallet);
    await expect(client.fetch(URL)).rejects.toMatchObject({ name: 'X402PaymentError' });
    expect(debits).toEqual([]);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
    expect((await client.fetch(URL)).status).toBe(200);
    expect(debits).toHaveLength(2);
  });

  it('releases the reservation when wallet verification fails before any write (Codex P2)', async () => {
    const { wallet, debits } = setup();
    merchant(challenge(false));
    transfer.mockImplementationOnce(async () => {
      throw new AgentWalletVerificationError('agent wallet: deployment identity required');
    });
    const client = new X402Client(wallet);
    const err = await client.fetch(URL).catch((e) => e);
    expect(err).toMatchObject({ name: 'X402PaymentError' });
    expect(err).not.toBeInstanceOf(X402SettlementUnknownError);
    expect(err.cause).toBeInstanceOf(AgentWalletVerificationError);
    expect(debits).toEqual([]);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
    // Nothing is left to reconcile: a corrected wallet can pay the same intent.
    expect((await client.fetch(URL)).status).toBe(200);
    expect(debits).toHaveLength(2);
  });

  it('still holds the reservation for an unclassified submission error', async () => {
    const { wallet } = setup();
    merchant(challenge(false));
    transfer.mockImplementationOnce(async () => { throw new Error('socket hang up'); });
    const client = new X402Client(wallet);
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(X402SettlementUnknownError);
    expect(client.budgetTracker.getReservedSummary().global).toBeGreaterThan(0n);
  });

  it('retains an unmatched receipt instead of trusting its reverted status to release the fee', async () => {
    const { wallet, debits } = setup();
    merchant(challenge(false));
    wallet.publicClient.waitForTransactionReceipt.mockResolvedValue({
      status: 'reverted', transactionHash: PAYEE_HASH,
    } as any);
    const client = new X402Client(wallet);
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(X402SettlementUnknownError);
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(X402SettlementUnknownError);
    expect(debits).toHaveLength(1);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1007700n);
  });

  it('retains a background-confirmed unkeyed payment until proof is actually delivered', async () => {
    const { wallet, debits } = setup();
    merchant(challenge());
    let firstPayee = true;
    wallet.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: any) => {
      if (hash === PAYEE_HASH && firstPayee) {
        firstPayee = false;
        throw new Error('receipt polling failed');
      }
      return { status: 'success' };
    });
    const client = new X402Client(wallet);
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(X402SettlementUnknownError);
    (client as any).pruneSettlements();
    await vi.waitFor(() => expect(client.budgetTracker.getReservedSummary().global).toBe(0n));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + X402_SETTLEMENT_RETRY_WINDOW_MS + 1);
    expect((await client.fetch(URL)).status).toBe(200);
    expect(debits).toHaveLength(2);
  });

  it.each(['base:8453oops', 'base:8453:extra', 'base:0', 'base:9007199254740992'])('rejects malformed chain id %s', network => {
    expect(parseNetworkChainId(network)).toBeNull();
  });

  it.each(['fee', 'payee'] as const)('keeps %s reconciliation terms private when a public error is mutated', async phase => {
    const { wallet, debits } = setup();
    const send = transfer.getMockImplementation()!;
    transfer.mockImplementation(async (...args) => {
      const hash = await send(...args);
      if ((args[1].to === X402_PROTOCOL_FEE_COLLECTOR ? 'fee' : 'payee') === phase) {
        throw new Error('RPC response lost');
      }
      return hash;
    });
    merchant(challenge(false));
    const client = new X402Client(wallet);
    const error = await client.fetch(URL).catch(error => error);
    const unrelatedInput = encodeFunctionData({
      abi: AgentAccountV2Abi, functionName: 'agentTransferToken', args: [TOKEN, PAYEE, 2n],
    });
    try { error.transfer.input = unrelatedInput; } catch { /* A frozen diagnostic is also safe. */ }
    const txHash = phase === 'fee' ? FEE_HASH : PAYEE_HASH;
    wallet.publicClient.getTransaction.mockResolvedValue({
      hash: txHash, chainId: 8453, to: WALLET, input: unrelatedInput, value: 0n,
    });
    await expect(client.reconcileSubmission({ intentKey: error.intentKey, phase, txHash })).rejects.toBeInstanceOf(
      X402SettlementUnknownError,
    );
    expect(client.budgetTracker.getReservedSummary().global).toBe(1007700n);
    expect(debits).toHaveLength(phase === 'fee' ? 1 : 2);
  });

  it.each(['unknown', 'fee-only'] as const)('rejects changed terms for the same unkeyed request after %s payment', async state => {
    const { wallet, debits } = setup();
    const required = challenge();
    merchant(required);
    if (state === 'unknown') {
      const send = transfer.getMockImplementation()!;
      transfer.mockImplementation(async (...args) => {
        await send(...args);
        throw new Error('RPC response lost');
      });
    } else {
      wallet.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: any) => ({
        status: hash === PAYEE_HASH ? 'reverted' : 'success',
      }));
    }
    const client = new X402Client(wallet);
    await expect(client.fetch(URL)).rejects.toThrow();
    const debitCount = debits.length;
    required.accepts[0].amount = '2000000';
    await expect(client.fetch(URL)).rejects.toMatchObject({ name: 'X402IntentTermsConflictError' });
    expect(debits).toHaveLength(debitCount);
  });

  it('extends an unresolved unkeyed payment window when the reissued challenge becomes longer', async () => {
    const { wallet, debits } = setup();
    const required = challenge();
    const { proofs } = merchant(required);
    const epoch = Date.UTC(2026, 9, 13);
    let elapsedMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => epoch + elapsedMs);
    const client = new X402Client(wallet);
    wallet.publicClient.waitForTransactionReceipt.mockRejectedValueOnce(new Error('receipt timeout'));
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(X402SettlementUnknownError);

    elapsedMs = 60_000;
    required.accepts[0].maxTimeoutSeconds = 300;
    expect((await client.fetch(URL)).status).toBe(200);
    expect(debits.map(debit => debit.amount)).toEqual([7700n, 1000000n]);
    expect(proofs[proofs.length - 1].payload.replayed).toBe(false);

    // After proof delivery, a later identical unkeyed request is a new purchase.
    elapsedMs = 181_000;
    required.accepts[0].maxTimeoutSeconds = 30;
    expect((await client.fetch(URL)).status).toBe(200);
    expect(debits.map(debit => debit.amount)).toEqual([7700n, 1000000n, 7700n, 1000000n]);
    expect(proofs[proofs.length - 1].payload.replayed).toBe(false);
  });

  it.each([
    ['createX402Fetch', 'fee'], ['createX402Fetch', 'payee'],
    ['wrapWithX402', 'fee'], ['wrapWithX402', 'payee'],
  ] as const)('%s reconciles its retained %s submission without duplicate transfers or resetting its budget', async (entrypoint, phase) => {
    const { wallet, debits } = setup();
    const send = transfer.getMockImplementation()!;
    let responseLost = false;
    transfer.mockImplementation(async (...args) => {
      const hash = await send(...args);
      if (!responseLost && (args[1].to === X402_PROTOCOL_FEE_COLLECTOR ? 'fee' : 'payee') === phase) {
        responseLost = true;
        throw new Error('RPC response lost');
      }
      return hash;
    });
    const required = challenge(false);
    const { fetchFn } = merchant(required);
    const config = { globalDailyLimit: 1007700n };
    const retainedFetch = entrypoint === 'createX402Fetch'
      ? createX402Fetch(wallet, config)
      : wrapWithX402(fetchFn as typeof fetch, wallet, config);
    const error = await retainedFetch(URL).catch(error => error);
    expect(error).toMatchObject({ name: 'X402SettlementUnknownError', phase });

    required.accepts[0].extra = { nonce: 'unrelated-intent' };
    await expect(retainedFetch(URL)).rejects.toThrow(/global daily limit/);
    expect(debits).toHaveLength(phase === 'fee' ? 1 : 2);

    const txHash = phase === 'fee' ? FEE_HASH : PAYEE_HASH;
    wallet.publicClient.getTransaction.mockResolvedValue({
      hash: txHash, chainId: 8453, to: WALLET, input: debits[debits.length - 1].data, value: 0n,
    });
    expect(await retainedFetch.reconcileSubmission({
      intentKey: error.intentKey, phase, txHash,
    })).toBe('confirmed');
    // Even recovery of the fee alone must retain the original full debit hold.
    await expect(retainedFetch(URL)).rejects.toThrow(/global daily limit/);
    required.accepts[0].extra = { nonce: 'purchase-1' };
    expect((await retainedFetch(URL)).status).toBe(200);
    expect(debits.map(debit => debit.amount)).toEqual([7700n, 1000000n]);
    required.accepts[0].extra = { nonce: 'unrelated-intent' };
    await expect(retainedFetch(URL)).rejects.toThrow(/global daily limit/);
    expect(debits).toHaveLength(2);
  });
});
