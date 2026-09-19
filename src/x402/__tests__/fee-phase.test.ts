import { afterEach, describe, expect, it, vi } from 'vitest';
import { X402Client, X402SettlementRevertedError } from '../client.js';

const FEE_COLLECTOR = '0xff86829393C6C26A4EC122bE0Cc3E466Ef876AdD';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x1111111111111111111111111111111111111111';
const URL = 'https://api.example.com/premium/data';

const { transfer, onChainBudget } = vi.hoisted(() => ({
  transfer: vi.fn(),
  onChainBudget: vi.fn(),
}));

vi.mock('../../index.js', () => ({
  agentTransferToken: (...args: unknown[]) => transfer(...args),
  checkBudget: (...args: unknown[]) => onChainBudget(...args),
}));

function hash(byte: string): `0x${string}` {
  return `0x${byte.repeat(32)}` as `0x${string}`;
}

function isFeeTransfer(args: { to: string }): boolean {
  return args.to.toLowerCase() === FEE_COLLECTOR.toLowerCase();
}

function paymentRequired(extra: Record<string, string> = { nonce: 'intent-fee' }) {
  return {
    x402Version: 1,
    resource: { url: '/premium/data', description: 'Data API', mimeType: 'application/json' },
    accepts: [
      {
        scheme: 'exact',
        network: 'base:8453',
        asset: USDC,
        amount: '1000000',
        payTo: PAY_TO,
        maxTimeoutSeconds: 30,
        extra,
      },
    ],
  };
}

function mock402ThenPaid(extra?: Record<string, string> | null) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const headers = new Headers(init?.headers);
    if (headers.get('X-PAYMENT')) {
      return new Response('paid', { status: 200 });
    }
    const challenge = extra === null
      ? paymentRequiredUnkeyed()
      : paymentRequired(extra);
    return new Response(null, {
      status: 402,
      headers: { 'payment-required': btoa(JSON.stringify(challenge)) },
    });
  });
}

function paymentRequiredUnkeyed() {
  const required = paymentRequired();
  delete (required.accepts[0] as { extra?: unknown }).extra;
  return required;
}

describe('X402Client protocol-fee phase (#50)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    transfer.mockReset();
    onChainBudget.mockReset();
  });

  function setupTransfers(opts: {
    feeReceipts: Array<'success' | 'reverted'>;
    payeeReceipts: Array<'success' | 'reverted'>;
  }) {
    const feeHashes = opts.feeReceipts.map((_, i) => hash((10 + i).toString(16).padStart(2, '0')));
    const payeeHashes = opts.payeeReceipts.map((_, i) => hash((20 + i).toString(16).padStart(2, '0')));
    const receiptByHash = new Map<string, 'success' | 'reverted'>();
    opts.feeReceipts.forEach((status, i) => receiptByHash.set(feeHashes[i], status));
    opts.payeeReceipts.forEach((status, i) => receiptByHash.set(payeeHashes[i], status));

    const remainingFee = [...feeHashes];
    const remainingPayee = [...payeeHashes];
    transfer.mockImplementation(async (_wallet: unknown, args: { to: string }) => {
      if (isFeeTransfer(args)) {
        const next = remainingFee.shift();
        if (!next) throw new Error('unexpected extra fee transfer');
        return next;
      }
      const next = remainingPayee.shift();
      if (!next) throw new Error('unexpected extra payee transfer');
      return next;
    });
    onChainBudget.mockResolvedValue({
      perTxLimit: 10n ** 18n,
      remainingInPeriod: 10n ** 18n,
    });
    const wallet = {
      publicClient: {
        waitForTransactionReceipt: async ({ hash: txHash }: { hash: string }) => {
          const status = receiptByHash.get(txHash);
          if (!status) throw new Error(`missing receipt for ${txHash}`);
          return { status };
        },
      },
    };
    mock402ThenPaid();
    return { wallet, feeHashes, payeeHashes };
  }

  it('does not re-charge the protocol fee after a payee revert on the same explicit intent', async () => {
    const { wallet, feeHashes, payeeHashes } = setupTransfers({
      feeReceipts: ['success'],
      payeeReceipts: ['reverted', 'success'],
    });
    const client = new X402Client(wallet as any);

    await expect(client.fetch(URL, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementRevertedError,
    );
    expect(transfer.mock.calls).toHaveLength(2);
    expect(isFeeTransfer(transfer.mock.calls[0][1])).toBe(true);
    expect(isFeeTransfer(transfer.mock.calls[1][1])).toBe(false);
    expect(transfer.mock.calls[0][1].token).toBe(USDC);
    expect(transfer.mock.calls[0][1].amount).toBe(7700n);
    expect(transfer.mock.calls[1][1].token).toBe(USDC);
    expect(transfer.mock.calls[1][1].amount).toBe(1000000n);

    const retry = await client.fetch(URL, { method: 'POST' });
    expect(retry.status).toBe(200);
    expect(transfer.mock.calls).toHaveLength(3);
    expect(isFeeTransfer(transfer.mock.calls[2][1])).toBe(false);
    expect(transfer.mock.calls[2][1].amount).toBe(1000000n);
    expect(feeHashes).toEqual([hash('0a')]);
    expect(payeeHashes).toEqual([hash('14'), hash('15')]);
  });

  it('retries the protocol fee after a fee revert and then pays the payee once', async () => {
    const { wallet } = setupTransfers({
      feeReceipts: ['reverted', 'success'],
      payeeReceipts: ['success'],
    });
    const client = new X402Client(wallet as any);

    await expect(client.fetch(URL, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementRevertedError,
    );
    expect(transfer.mock.calls).toHaveLength(1);
    expect(isFeeTransfer(transfer.mock.calls[0][1])).toBe(true);

    const retry = await client.fetch(URL, { method: 'POST' });
    expect(retry.status).toBe(200);
    expect(transfer.mock.calls).toHaveLength(3);
    expect(isFeeTransfer(transfer.mock.calls[1][1])).toBe(true);
    expect(isFeeTransfer(transfer.mock.calls[2][1])).toBe(false);
    expect(client.getTransactionLog()).toHaveLength(1);
    expect(client.getTransactionLog()[0].success).toBe(true);
  });

  it('charges the fee once when both transfers confirm, then replays', async () => {
    const { wallet } = setupTransfers({
      feeReceipts: ['success'],
      payeeReceipts: ['success'],
    });
    const client = new X402Client(wallet as any);

    expect((await client.fetch(URL, { method: 'POST' })).status).toBe(200);
    expect((await client.fetch(URL, { method: 'POST' })).status).toBe(200);
    expect(transfer.mock.calls).toHaveLength(2);
    expect(isFeeTransfer(transfer.mock.calls[0][1])).toBe(true);
    expect(isFeeTransfer(transfer.mock.calls[1][1])).toBe(false);
    const logs = client.getTransactionLog();
    expect(logs).toHaveLength(2);
    expect(logs[0].replayed).toBe(false);
    expect(logs[1].replayed).toBe(true);
    expect(client.getDailySpendSummary().global).toBe(1000000n);
  });

  it('retains an unknown fee submission and reconfirms it instead of transferring again', async () => {
    const { wallet, feeHashes } = setupTransfers({
      feeReceipts: ['success'],
      payeeReceipts: ['success'],
    });
    let feeReceiptAttempts = 0;
    const originalWait = wallet.publicClient.waitForTransactionReceipt;
    wallet.publicClient.waitForTransactionReceipt = async (
      args: { hash: string },
    ) => {
      if (args.hash === feeHashes[0]) {
        feeReceiptAttempts += 1;
        if (feeReceiptAttempts === 1) {
          throw new Error('rpc timeout');
        }
      }
      return originalWait(args);
    };
    const client = new X402Client(wallet as any);

    await expect(client.fetch(URL, { method: 'POST' })).rejects.toThrow('rpc timeout');
    expect(transfer.mock.calls).toHaveLength(1);
    expect(isFeeTransfer(transfer.mock.calls[0][1])).toBe(true);

    const retry = await client.fetch(URL, { method: 'POST' });
    expect(retry.status).toBe(200);
    expect(transfer.mock.calls).toHaveLength(2);
    expect(isFeeTransfer(transfer.mock.calls[1][1])).toBe(false);
    expect(feeReceiptAttempts).toBe(2);
    expect(client.getTransactionLog()).toHaveLength(1);
  });

  it('expires a confirmed fee phase with its completed settlement', async () => {
    const { wallet } = setupTransfers({
      feeReceipts: ['success', 'success'],
      payeeReceipts: ['success', 'success'],
    });
    const client = new X402Client(wallet as any);

    expect((await client.fetch(URL, { method: 'POST' })).status).toBe(200);
    expect((client as any).feePhases.size).toBe(1);
    expect((await client.fetch(URL, { method: 'POST' })).status).toBe(200);
    expect(transfer.mock.calls).toHaveLength(2);

    (client as any).pruneSettlements(Date.now() + 200_000);
    expect((client as any).feePhases.size).toBe(0);

    expect((await client.fetch(URL, { method: 'POST' })).status).toBe(200);
    expect(transfer.mock.calls.filter((call) => isFeeTransfer(call[1]))).toHaveLength(2);
    expect(transfer.mock.calls).toHaveLength(4);
  });
});

describe('X402Client unkeyed protocol-fee phase', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    transfer.mockReset();
    onChainBudget.mockReset();
  });

  function setupTransfers(opts: {
    feeReceipts: Array<'success' | 'reverted'>;
    payeeReceipts: Array<'success' | 'reverted'>;
  }) {
    const feeHashes = opts.feeReceipts.map((_, i) => hash((10 + i).toString(16).padStart(2, '0')));
    const payeeHashes = opts.payeeReceipts.map((_, i) => hash((20 + i).toString(16).padStart(2, '0')));
    const receiptByHash = new Map<string, 'success' | 'reverted'>();
    opts.feeReceipts.forEach((status, i) => receiptByHash.set(feeHashes[i], status));
    opts.payeeReceipts.forEach((status, i) => receiptByHash.set(payeeHashes[i], status));

    const remainingFee = [...feeHashes];
    const remainingPayee = [...payeeHashes];
    transfer.mockImplementation(async (_wallet: unknown, args: { to: string }) => {
      if (isFeeTransfer(args)) {
        const next = remainingFee.shift();
        if (!next) throw new Error('unexpected extra fee transfer');
        return next;
      }
      const next = remainingPayee.shift();
      if (!next) throw new Error('unexpected extra payee transfer');
      return next;
    });
    onChainBudget.mockResolvedValue({
      perTxLimit: 10n ** 18n,
      remainingInPeriod: 10n ** 18n,
    });
    const wallet = {
      publicClient: {
        waitForTransactionReceipt: async ({ hash: txHash }: { hash: string }) => {
          const status = receiptByHash.get(txHash);
          if (!status) throw new Error(`missing receipt for ${txHash}`);
          return { status };
        },
      },
    };
    mock402ThenPaid(null);
    return { wallet, feeHashes, payeeHashes };
  }

  it('retains an unknown unkeyed fee and reconfirms it instead of transferring again', async () => {
    const { wallet, feeHashes } = setupTransfers({
      feeReceipts: ['success'],
      payeeReceipts: ['success'],
    });
    let feeReceiptAttempts = 0;
    const originalWait = wallet.publicClient.waitForTransactionReceipt;
    wallet.publicClient.waitForTransactionReceipt = async (
      args: { hash: string },
    ) => {
      if (args.hash === feeHashes[0]) {
        feeReceiptAttempts += 1;
        if (feeReceiptAttempts === 1) {
          throw new Error('rpc timeout');
        }
      }
      return originalWait(args);
    };
    const client = new X402Client(wallet as any);

    await expect(client.fetch(URL, { method: 'POST' })).rejects.toThrow('rpc timeout');
    expect(transfer.mock.calls).toHaveLength(1);
    expect(isFeeTransfer(transfer.mock.calls[0][1])).toBe(true);

    const retry = await client.fetch(URL, { method: 'POST' });
    expect(retry.status).toBe(200);
    expect(transfer.mock.calls).toHaveLength(2);
    expect(isFeeTransfer(transfer.mock.calls[1][1])).toBe(false);
    expect(feeReceiptAttempts).toBe(2);
    expect(client.getTransactionLog()).toHaveLength(1);
  });

  it('does not re-charge the unkeyed protocol fee after a payee revert on the same request', async () => {
    const { wallet, feeHashes, payeeHashes } = setupTransfers({
      feeReceipts: ['success'],
      payeeReceipts: ['reverted', 'success'],
    });
    const client = new X402Client(wallet as any);

    await expect(client.fetch(URL, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementRevertedError,
    );
    expect(transfer.mock.calls).toHaveLength(2);
    expect(isFeeTransfer(transfer.mock.calls[0][1])).toBe(true);
    expect(isFeeTransfer(transfer.mock.calls[1][1])).toBe(false);

    const retry = await client.fetch(URL, { method: 'POST' });
    expect(retry.status).toBe(200);
    expect(transfer.mock.calls).toHaveLength(3);
    expect(isFeeTransfer(transfer.mock.calls[2][1])).toBe(false);
    expect(feeHashes).toEqual([hash('0a')]);
    expect(payeeHashes).toEqual([hash('14'), hash('15')]);
  });

  it('charges the unkeyed fee again on the next successful purchase of the same resource', async () => {
    const { wallet } = setupTransfers({
      feeReceipts: ['success', 'success'],
      payeeReceipts: ['success', 'success'],
    });
    const client = new X402Client(wallet as any);

    expect((await client.fetch(URL, { method: 'POST' })).status).toBe(200);
    expect((client as any).feePhases.size).toBe(0);
    expect((await client.fetch(URL, { method: 'POST' })).status).toBe(200);
    expect(transfer.mock.calls.filter((call) => isFeeTransfer(call[1]))).toHaveLength(2);
    expect(transfer.mock.calls).toHaveLength(4);
    expect((client as any).feePhases.size).toBe(0);
    const logs = client.getTransactionLog();
    expect(logs).toHaveLength(2);
    expect(logs.every((log) => log.replayed === false)).toBe(true);
    expect(client.getDailySpendSummary().global).toBe(2000000n);
  });
});
