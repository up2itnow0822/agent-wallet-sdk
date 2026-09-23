import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  X402Client,
  X402PaymentError,
  X402SettlementQueuedError,
  X402SettlementRevertedError,
  X402SettlementUnknownError,
  X402_TRANSACTION_QUEUED_TOPIC,
} from '../client.js';

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

function mock402ThenPaid(extra: Record<string, string> = { nonce: 'intent-fee' }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const headers = new Headers(init?.headers);
    if (headers.get('X-PAYMENT')) {
      return new Response('paid', { status: 200 });
    }
    return new Response(null, {
      status: 402,
      headers: { 'payment-required': btoa(JSON.stringify(paymentRequired(extra))) },
    });
  });
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
    unkeyed?: boolean;
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
    mock402ThenPaid(opts.unkeyed ? {} : undefined);
    return { wallet, feeHashes, payeeHashes };
  }

  it('refuses both transfers when remaining on-chain budget cannot cover amount plus protocol fee', async () => {
    const { wallet } = setupTransfers({
      feeReceipts: ['success'],
      payeeReceipts: ['success'],
    });
    onChainBudget.mockResolvedValue({
      perTxLimit: 10n ** 18n,
      remainingInPeriod: 1000000n,
    });
    const client = new X402Client(wallet);

    await expect(client.fetch(URL, { method: 'POST' })).rejects.toBeInstanceOf(
      X402PaymentError,
    );
    expect(transfer.mock.calls).toHaveLength(0);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
    expect(client.getTransactionLog()).toHaveLength(0);
  });

  it('allows a payment when remaining on-chain budget covers amount plus protocol fee', async () => {
    const { wallet } = setupTransfers({
      feeReceipts: ['success'],
      payeeReceipts: ['success'],
    });
    onChainBudget.mockResolvedValue({
      perTxLimit: 10n ** 18n,
      remainingInPeriod: 1_007_700n,
    });
    const client = new X402Client(wallet);

    expect((await client.fetch(URL, { method: 'POST' })).status).toBe(200);
    expect(transfer.mock.calls).toHaveLength(2);
    expect(isFeeTransfer(transfer.mock.calls[0][1])).toBe(true);
    expect(isFeeTransfer(transfer.mock.calls[1][1])).toBe(false);
  });

  it('refuses a client daily limit that covers principal but not protocol fee', async () => {
    const { wallet } = setupTransfers({
      feeReceipts: ['success'],
      payeeReceipts: ['success'],
    });
    const client = new X402Client(wallet, { globalDailyLimit: 1_000_000n });

    await expect(client.fetch(URL, { method: 'POST' })).rejects.toThrow(/global daily limit/);
    expect(transfer.mock.calls).toHaveLength(0);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
    expect(client.getDailySpendSummary().global).toBe(0n);
  });

  it('counts protocol fee against client daily limits and fail-closes the next intent', async () => {
    const { wallet } = setupTransfers({
      feeReceipts: ['success'],
      payeeReceipts: ['success'],
    });
    mock402ThenPaid({ nonce: 'intent-daily-a' });
    const client = new X402Client(wallet, { globalDailyLimit: 1_007_700n });

    expect((await client.fetch(URL, { method: 'POST' })).status).toBe(200);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
    expect(client.getTransactionLog()[0].amount).toBe(1_000_000n);

    mock402ThenPaid({ nonce: 'intent-daily-b' });
    await expect(client.fetch(URL, { method: 'POST' })).rejects.toThrow(/global daily limit/);
    expect(transfer.mock.calls).toHaveLength(2);
  });

  it('does not re-charge the protocol fee after a payee revert on the same explicit intent', async () => {
    const { wallet, feeHashes, payeeHashes } = setupTransfers({
      feeReceipts: ['success'],
      payeeReceipts: ['reverted', 'success'],
    });
    const client = new X402Client(wallet);

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
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
    expect(client.getDailySpendSummary().global).toBe(7_700n);

    const retry = await client.fetch(URL, { method: 'POST' });
    expect(retry.status).toBe(200);
    expect(transfer.mock.calls).toHaveLength(3);
    expect(isFeeTransfer(transfer.mock.calls[2][1])).toBe(false);
    expect(transfer.mock.calls[2][1].amount).toBe(1000000n);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
    expect(feeHashes).toEqual([hash('0a')]);
    expect(payeeHashes).toEqual([hash('14'), hash('15')]);
  });

  it('keeps a stranded protocol fee inside the client daily limit', async () => {
    const { wallet } = setupTransfers({
      feeReceipts: ['success'],
      payeeReceipts: ['reverted', 'success'],
    });
    mock402ThenPaid({ nonce: 'intent-strand-a' });
    const client = new X402Client(wallet, { globalDailyLimit: 1_007_700n });

    await expect(client.fetch(URL, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementRevertedError,
    );
    expect(transfer.mock.calls).toHaveLength(2);
    expect(isFeeTransfer(transfer.mock.calls[0][1])).toBe(true);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
    expect(client.getDailySpendSummary().global).toBe(7_700n);

    mock402ThenPaid({ nonce: 'intent-strand-b' });
    await expect(client.fetch(URL, { method: 'POST' })).rejects.toThrow(/global daily limit/);
    expect(transfer.mock.calls).toHaveLength(2);

    mock402ThenPaid({ nonce: 'intent-strand-a' });
    expect((await client.fetch(URL, { method: 'POST' })).status).toBe(200);
    expect(transfer.mock.calls).toHaveLength(3);
    expect(isFeeTransfer(transfer.mock.calls[2][1])).toBe(false);
    expect(transfer.mock.calls[2][1].amount).toBe(1000000n);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
  });

  it('keeps the protocol fee when a delayed payee receipt reverts', async () => {
    const { wallet, payeeHashes } = setupTransfers({
      feeReceipts: ['success'],
      payeeReceipts: ['reverted', 'success'],
    });
    let payeeAttempts = 0;
    const originalWait = wallet.publicClient.waitForTransactionReceipt;
    wallet.publicClient.waitForTransactionReceipt = async (args: { hash: string }) => {
      if (args.hash === payeeHashes[0]) {
        payeeAttempts += 1;
        if (payeeAttempts === 1) {
          throw new Error('payee receipt timeout');
        }
      }
      return originalWait(args);
    };
    mock402ThenPaid({ nonce: 'intent-delay-a' });
    const client = new X402Client(wallet, { globalDailyLimit: 1_007_700n });

    await expect(client.fetch(URL, { method: 'POST' })).rejects.toThrow('payee receipt timeout');
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);

    await expect(client.fetch(URL, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementRevertedError,
    );
    expect(client.getDailySpendSummary().global).toBe(7_700n);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
    expect(transfer.mock.calls.filter((call) => isFeeTransfer(call[1]))).toHaveLength(1);

    mock402ThenPaid({ nonce: 'intent-delay-b' });
    await expect(client.fetch(URL, { method: 'POST' })).rejects.toThrow(/global daily limit/);
    expect(transfer.mock.calls.filter((call) => isFeeTransfer(call[1]))).toHaveLength(1);

    mock402ThenPaid({ nonce: 'intent-delay-a' });
    expect((await client.fetch(URL, { method: 'POST' })).status).toBe(200);
    expect(transfer.mock.calls.filter((call) => isFeeTransfer(call[1]))).toHaveLength(1);
    expect(transfer.mock.calls.filter((call) => !isFeeTransfer(call[1]))).toHaveLength(2);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
  });

  it('retries the protocol fee after a fee revert and then pays the payee once', async () => {
    const { wallet } = setupTransfers({
      feeReceipts: ['reverted', 'success'],
      payeeReceipts: ['success'],
    });
    const client = new X402Client(wallet);

    await expect(client.fetch(URL, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementRevertedError,
    );
    expect(transfer.mock.calls).toHaveLength(1);
    expect(isFeeTransfer(transfer.mock.calls[0][1])).toBe(true);
    expect(client.getDailySpendSummary().global).toBe(0n);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);

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
    const client = new X402Client(wallet);

    expect((await client.fetch(URL, { method: 'POST' })).status).toBe(200);
    expect((await client.fetch(URL, { method: 'POST' })).status).toBe(200);
    expect(transfer.mock.calls).toHaveLength(2);
    expect(isFeeTransfer(transfer.mock.calls[0][1])).toBe(true);
    expect(isFeeTransfer(transfer.mock.calls[1][1])).toBe(false);
    const logs = client.getTransactionLog();
    expect(logs).toHaveLength(2);
    expect(logs[0].replayed).toBe(false);
    expect(logs[1].replayed).toBe(true);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
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
    const client = new X402Client(wallet);

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

  it('resumes an unkeyed fee confirmation without a second fee or reservation', async () => {
    const { wallet, feeHashes } = setupTransfers({
      feeReceipts: ['success'],
      payeeReceipts: ['success'],
      unkeyed: true,
    });
    let feeReceiptAttempts = 0;
    const originalWait = wallet.publicClient.waitForTransactionReceipt;
    wallet.publicClient.waitForTransactionReceipt = async (args: { hash: string }) => {
      if (args.hash === feeHashes[0]) {
        feeReceiptAttempts += 1;
        if (feeReceiptAttempts === 1) {
          throw new Error('rpc timeout');
        }
      }
      return originalWait(args);
    };
    const client = new X402Client(wallet);

    await expect(client.fetch(URL, { method: 'POST' })).rejects.toThrow('rpc timeout');
    expect(transfer.mock.calls).toHaveLength(1);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);

    const retry = await client.fetch(URL, { method: 'POST' });
    expect(retry.status).toBe(200);
    expect(transfer.mock.calls).toHaveLength(2);
    expect(transfer.mock.calls.filter((call) => isFeeTransfer(call[1]))).toHaveLength(1);
    expect(feeReceiptAttempts).toBe(2);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
    expect(client.getTransactionLog()).toHaveLength(1);
    expect(client.getTransactionLog()[0].replayed).toBe(false);
  });

  it('single-flights concurrent retries while an unkeyed fee receipt is pending', async () => {
    const { wallet, feeHashes } = setupTransfers({
      feeReceipts: ['success'],
      payeeReceipts: ['success'],
      unkeyed: true,
    });
    let feeReceiptAttempts = 0;
    let releaseFeeReceipt: (receipt: { status: 'success' | 'reverted' }) => void = () => {};
    const delayedFeeReceipt = new Promise<{ status: 'success' | 'reverted' }>((resolve) => {
      releaseFeeReceipt = resolve;
    });
    const originalWait = wallet.publicClient.waitForTransactionReceipt;
    wallet.publicClient.waitForTransactionReceipt = async (args: { hash: string }) => {
      if (args.hash === feeHashes[0]) {
        feeReceiptAttempts += 1;
        if (feeReceiptAttempts === 1) {
          throw new Error('rpc timeout');
        }
        if (feeReceiptAttempts === 2) {
          return delayedFeeReceipt;
        }
      }
      return originalWait(args);
    };
    const client = new X402Client(wallet);

    await expect(client.fetch(URL, { method: 'POST' })).rejects.toThrow('rpc timeout');
    const retries = Promise.all([
      client.fetch(URL, { method: 'POST' }),
      client.fetch(URL, { method: 'POST' }),
    ]);
    await vi.waitFor(() => expect(feeReceiptAttempts).toBe(2));
    releaseFeeReceipt({ status: 'success' });

    const responses = await retries;
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(feeReceiptAttempts).toBe(2);
    expect(transfer.mock.calls.filter((call) => isFeeTransfer(call[1]))).toHaveLength(1);
    expect(transfer.mock.calls.filter((call) => !isFeeTransfer(call[1]))).toHaveLength(1);
    const logs = client.getTransactionLog();
    expect(logs).toHaveLength(2);
    expect(logs.filter((log) => log.replayed)).toHaveLength(1);
  });

  it('keeps a replaced fee reserved and never presents it as payment proof', async () => {
    const { wallet, feeHashes } = setupTransfers({
      feeReceipts: ['success'],
      payeeReceipts: ['success'],
    });
    const replacementHash = hash('55');
    const originalWait = wallet.publicClient.waitForTransactionReceipt;
    wallet.publicClient.waitForTransactionReceipt = async ({
      hash: txHash,
      onReplaced,
    }: {
      hash: string;
      onReplaced?: (event: { reason: string; transactionReceipt: { status: string; transactionHash: string } }) => void;
    }) => {
      if (txHash === feeHashes[0]) {
        onReplaced?.({
          reason: 'replaced',
          transactionReceipt: { status: 'success', transactionHash: replacementHash },
        });
        return { status: 'success', transactionHash: replacementHash };
      }
      return originalWait({ hash: txHash });
    };
    const client = new X402Client(wallet);

    await expect(client.fetch(URL, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementUnknownError,
    );
    await expect(client.fetch(URL, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementUnknownError,
    );

    expect(transfer.mock.calls).toHaveLength(1);
    expect(isFeeTransfer(transfer.mock.calls[0][1])).toBe(true);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);
    expect(client.getTransactionLog()).toHaveLength(0);
  });

  it('keeps a queued fee blocked instead of inferring a payee confirmation', async () => {
    const { wallet, feeHashes } = setupTransfers({
      feeReceipts: ['success'],
      payeeReceipts: ['success'],
    });
    const originalWait = wallet.publicClient.waitForTransactionReceipt;
    wallet.publicClient.waitForTransactionReceipt = async ({ hash: txHash }: { hash: string }) => {
      if (txHash === feeHashes[0]) {
        return { status: 'success', logs: [{ topics: [X402_TRANSACTION_QUEUED_TOPIC] }] };
      }
      return originalWait({ hash: txHash });
    };
    const client = new X402Client(wallet);

    await expect(client.fetch(URL, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementQueuedError,
    );
    await expect(client.fetch(URL, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementQueuedError,
    );

    expect(transfer.mock.calls).toHaveLength(1);
    expect(isFeeTransfer(transfer.mock.calls[0][1])).toBe(true);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);
    expect(client.getTransactionLog()).toHaveLength(0);
  });

  it('clears an unkeyed fee phase after delayed payee confirmation', async () => {
    const { wallet, payeeHashes } = setupTransfers({
      feeReceipts: ['success', 'success'],
      payeeReceipts: ['success', 'success'],
      unkeyed: true,
    });
    let firstPayeeReceipt = true;
    const originalWait = wallet.publicClient.waitForTransactionReceipt;
    wallet.publicClient.waitForTransactionReceipt = async (args: { hash: string }) => {
      if (args.hash === payeeHashes[0] && firstPayeeReceipt) {
        firstPayeeReceipt = false;
        throw new Error('payee receipt timeout');
      }
      return originalWait(args);
    };
    const client = new X402Client(wallet);

    await expect(client.fetch(URL, { method: 'POST' })).rejects.toThrow('payee receipt timeout');
    expect((await client.fetch(URL, { method: 'POST' })).status).toBe(200);
    expect((await client.fetch(URL, { method: 'POST' })).status).toBe(200);

    expect(transfer.mock.calls.filter((call) => isFeeTransfer(call[1]))).toHaveLength(2);
    expect(transfer.mock.calls.filter((call) => !isFeeTransfer(call[1]))).toHaveLength(2);
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
