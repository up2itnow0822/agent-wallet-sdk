import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, keccak256, pad, type Hex, type WalletClient } from 'viem';
import { BridgeModule } from '../client.js';
import { bridgeEVMToSolana, receiveFromSolanaOnEVM, SOLANA_TOKEN_MESSENGER, SOLANA_USDC_MINT } from '../solana.js';
import { FINALITY_THRESHOLD, MESSAGE_TRANSMITTER_V2, TOKEN_MESSENGER_V2, USDC_CONTRACT } from '../types.js';

const chain = vi.hoisted(() => ({
  burnCalls: [] as unknown[][],
  mintCalls: [] as unknown[][],
  approveCalls: [] as unknown[][],
  receipts: new Map<string, unknown>(),
  receiptError: undefined as Error | undefined,
}));

const BURN_TX = `0x${'aa'.repeat(32)}` as Hex;
const MINT_TX = `0x${'bb'.repeat(32)}` as Hex;
const ACCOUNT = `0x${'11'.repeat(20)}` as Hex;
const RECIPIENT = `0x${'22'.repeat(20)}` as Hex;
const OTHER_RECIPIENT = `0x${'33'.repeat(20)}` as Hex;
const SOLANA_TX = '4'.repeat(88);
const SOLANA_TOKEN_ACCOUNT = '11111111111111111111111111111112';
const SOLANA_RECIPIENT_BYTES = `0x${'0'.repeat(63)}1` as Hex;
const SIGNATURE = `0x${'cc'.repeat(65)}` as Hex;
const NONCE = (1n << 200n) + 123n;
const wallet = { account: { address: ACCOUNT } } as unknown as WalletClient;

vi.mock('viem', async importOriginal => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      waitForTransactionReceipt: async ({ hash }: { hash: string }) => {
        if (chain.receiptError) throw chain.receiptError;
        const receipt = chain.receipts.get(hash);
        if (!receipt) throw new Error(`Unexpected transaction ${hash}`);
        return receipt;
      },
    }),
    getContract: ({ abi }: { abi: Array<{ name?: string }> }) => {
      if (abi.some(entry => entry.name === 'depositForBurn')) {
        return { write: { depositForBurn: async (args: unknown[]) => {
          chain.burnCalls.push(args);
          return BURN_TX;
        } } };
      }
      if (abi.some(entry => entry.name === 'receiveMessage')) {
        return { write: { receiveMessage: async (args: unknown[]) => {
          chain.mintCalls.push(args);
          return MINT_TX;
        } } };
      }
      return {
        read: { allowance: async () => 1_000_000_000n },
        write: { approve: async (args: unknown[]) => {
          chain.approveCalls.push(args);
          throw new Error('Unexpected approval');
        } },
      };
    },
  };
});

function word(value: bigint | number, bytes = 32): string {
  return BigInt(value).toString(16).padStart(bytes * 2, '0');
}

function base58Bytes(address: string): Hex {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const char of address) value = value * 58n + BigInt(alphabet.indexOf(char));
  return `0x${word(value)}`;
}

type MessageFields = {
  sourceDomain: number; destinationDomain: number; nonce: bigint; sender: Hex; recipient: Hex;
  destinationCaller: Hex; minFinalityThreshold: number; finalityThresholdExecuted: number;
  burnToken: Hex; mintRecipient: Hex; amount: bigint; messageSender: Hex; maxFee: bigint;
  feeExecuted: bigint; expirationBlock: bigint; hookData: Hex;
};

function message(fields: Partial<MessageFields> = {}): Hex {
  const f: MessageFields = {
    sourceDomain: 6, destinationDomain: 0, nonce: 0n,
    sender: pad(TOKEN_MESSENGER_V2.base, { size: 32 }),
    recipient: pad(TOKEN_MESSENGER_V2.ethereum, { size: 32 }),
    destinationCaller: pad('0x00', { size: 32 }),
    minFinalityThreshold: 1000, finalityThresholdExecuted: 0,
    burnToken: pad(USDC_CONTRACT.base, { size: 32 }),
    mintRecipient: pad(RECIPIENT, { size: 32 }), amount: 1_000_000n,
    messageSender: pad(ACCOUNT, { size: 32 }), maxFee: 0n, feeExecuted: 0n, expirationBlock: 0n,
    hookData: '0x', ...fields,
  };
  return `0x${[
    word(1, 4), word(f.sourceDomain, 4), word(f.destinationDomain, 4), word(f.nonce),
    f.sender.slice(2), f.recipient.slice(2), f.destinationCaller.slice(2),
    word(f.minFinalityThreshold, 4), word(f.finalityThresholdExecuted, 4),
    word(1, 4), f.burnToken.slice(2), f.mintRecipient.slice(2), word(f.amount),
    f.messageSender.slice(2), word(f.maxFee), word(f.feeExecuted), word(f.expirationBlock), f.hookData.slice(2),
  ].join('')}`.toLowerCase() as Hex;
}

function burnReceipt(emittedMessage: Hex) {
  return {
    transactionHash: BURN_TX,
    status: 'success',
    logs: [{
      address: MESSAGE_TRANSMITTER_V2.base,
      topics: ['0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036'],
      data: encodeAbiParameters([{ type: 'bytes' }], [emittedMessage]),
    }],
  };
}

function circleResponse(attestedMessage: Hex, sourceTxHash: string = BURN_TX) {
  return { sourceTxHash, messages: [{ status: 'complete', cctpVersion: 2, message: attestedMessage, attestation: SIGNATURE }] };
}

function rpcAccount(valid = true) {
  return {
    jsonrpc: '2.0', id: 1,
    result: { value: {
      owner: valid ? 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' : '11111111111111111111111111111111',
      data: valid ? { program: 'spl-token', parsed: { type: 'account', info: { mint: SOLANA_USDC_MINT, state: 'initialized' } } } : ['', 'base64'],
    } },
  };
}

function stubFetch(payload: unknown) {
  return vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => new Response(
    JSON.stringify(init?.method === 'POST' ? rpcAccount() : payload),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )));
}

async function finish<T>(promise: Promise<T>): Promise<T> {
  const observed = promise.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const result = await observed;
  if ('error' in result) throw result.error;
  return result.value;
}

beforeEach(() => {
  vi.useFakeTimers();
  chain.burnCalls.length = 0;
  chain.mintCalls.length = 0;
  chain.approveCalls.length = 0;
  chain.receiptError = undefined;
  chain.receipts.clear();
  chain.receipts.set(BURN_TX, burnReceipt(message()));
  chain.receipts.set(MINT_TX, { transactionHash: MINT_TX, status: 'success', logs: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CCTP V2 EVM flow', () => {
  it('forwards the finalized threshold of 2000 to the actual burn call', async () => {
    chain.receipts.set(BURN_TX, burnReceipt(message({ minFinalityThreshold: 2000 })));
    const bridge = new BridgeModule(wallet);
    await bridge.burn(1_000_000n, 'ethereum', { destinationAddress: RECIPIENT, minFinalityThreshold: FINALITY_THRESHOLD.FINALIZED });
    expect(chain.burnCalls[0][6]).toBe(2000);
  });

  it('queries by burn transaction and mints the returned V2 message with its full nonce', async () => {
    const signedMessage = message({ nonce: NONCE, finalityThresholdExecuted: 1000, expirationBlock: 999n });
    stubFetch(circleResponse(signedMessage));
    const result = await finish(new BridgeModule(wallet).bridge(1_000_000n, 'ethereum', { destinationAddress: RECIPIENT }));
    expect(result).toMatchObject({ burnTxHash: BURN_TX, mintTxHash: MINT_TX, recipient: RECIPIENT, nonce: NONCE });
    expect(chain.burnCalls[0][6]).toBe(1000);
    expect(chain.mintCalls).toEqual([[signedMessage, SIGNATURE]]);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`https://iris-api.circle.com/v2/messages/6?transactionHash=${BURN_TX}`);
  });

  it('returns both the signed message and signature from public attestation lookup', async () => {
    const signedMessage = message({ nonce: NONCE, finalityThresholdExecuted: 2000 });
    stubFetch(circleResponse(signedMessage));
    const attested = await finish(new BridgeModule(wallet).waitForAttestation(BURN_TX));
    expect(attested).toMatchObject({ message: signedMessage, attestation: SIGNATURE, nonce: NONCE });
    expect(chain.burnCalls).toHaveLength(0);
    expect(chain.mintCalls).toHaveLength(0);
  });

  it('preserves the completed burn after an attestation HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 500 })));
    await expect(finish(new BridgeModule(wallet).bridge(1_000_000n, 'ethereum', { destinationAddress: RECIPIENT }))).rejects.toMatchObject({
      code: 'ATTESTATION_ERROR', recovery: { burnTxHash: BURN_TX, sourceDomain: 6, destinationDomain: 0, messageBytes: message() },
    });
    expect(chain.burnCalls).toHaveLength(1);
    expect(chain.mintCalls).toHaveLength(0);
  });

  it('preserves the burn on timeout and resumes it without a second burn or approval', async () => {
    stubFetch({ sourceTxHash: BURN_TX, messages: [{ status: 'pending_confirmations', cctpVersion: 2, message: message(), attestation: 'PENDING' }] });
    const bridge = new BridgeModule(wallet);
    await expect(finish(bridge.bridge(1_000_000n, 'ethereum', { destinationAddress: RECIPIENT }))).rejects.toMatchObject({
      code: 'ATTESTATION_TIMEOUT', recovery: { burnTxHash: BURN_TX },
    });
    const signedMessage = message({ nonce: NONCE, finalityThresholdExecuted: 2000 });
    stubFetch(circleResponse(signedMessage));
    const result = await finish(bridge.resume(BURN_TX, 'ethereum'));
    expect(result).toMatchObject({ amount: 1_000_000n, recipient: RECIPIENT, nonce: NONCE });
    expect(chain.burnCalls).toHaveLength(1);
    expect(chain.approveCalls).toHaveLength(0);
    expect(chain.mintCalls).toEqual([[signedMessage, SIGNATURE]]);
  });

  it('resumes the original burn after Circle indexing returns 404 then complete', async () => {
    const signedMessage = message({ nonce: NONCE, finalityThresholdExecuted: 2000 });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('not indexed', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(circleResponse(signedMessage)))));

    const result = await finish(new BridgeModule(wallet).resume(BURN_TX, 'ethereum'));

    expect(result).toMatchObject({ burnTxHash: BURN_TX, mintTxHash: MINT_TX, amount: 1_000_000n, recipient: RECIPIENT, nonce: NONCE });
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      `https://iris-api.circle.com/v2/messages/6?transactionHash=${BURN_TX}`,
      `https://iris-api.circle.com/v2/messages/6?transactionHash=${BURN_TX}`,
    ]);
    expect(chain.mintCalls).toEqual([[signedMessage, SIGNATURE]]);
    expect(chain.burnCalls).toHaveLength(0);
    expect(chain.approveCalls).toHaveLength(0);
  });

  it.each([undefined, '0x'])('resumes the original burn after pending message bytes %s become complete', async pendingMessage => {
    const signedMessage = message({ nonce: NONCE, finalityThresholdExecuted: 2000 });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sourceTxHash: BURN_TX,
        messages: [{ status: 'pending_confirmations', cctpVersion: 2, message: pendingMessage, attestation: 'PENDING' }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify(circleResponse(signedMessage)))));

    const result = await finish(new BridgeModule(wallet).resume(BURN_TX, 'ethereum'));

    expect(result).toMatchObject({ burnTxHash: BURN_TX, mintTxHash: MINT_TX, amount: 1_000_000n, recipient: RECIPIENT, nonce: NONCE });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(chain.mintCalls).toEqual([[signedMessage, SIGNATURE]]);
    expect(chain.burnCalls).toHaveLength(0);
    expect(chain.approveCalls).toHaveLength(0);
  });

  it('exposes the broadcast burn hash when receipt retrieval fails', async () => {
    chain.receiptError = new Error('RPC unavailable');
    await expect(new BridgeModule(wallet).burn(1_000_000n, 'ethereum')).rejects.toMatchObject({
      recovery: { burnTxHash: BURN_TX, sourceDomain: 6, destinationDomain: 0 },
    });
    expect(chain.burnCalls).toHaveLength(1);
  });

  it.each([
    { destinationDomain: 3, nonce: NONCE, finalityThresholdExecuted: 2000 },
    { recipient: pad(OTHER_RECIPIENT, { size: 32 }), nonce: NONCE, finalityThresholdExecuted: 2000 },
    { nonce: 0n, finalityThresholdExecuted: 0 },
  ])('rejects an unrelated destination or source-event message in public mint (case %#)', async changed => {
    await expect(new BridgeModule(wallet).mint(message(changed), SIGNATURE, 'ethereum')).rejects.toThrow();
    expect(chain.mintCalls).toHaveLength(0);
  });

  it.each([{ minFinalityThreshold: 2000 }, { maxFee: 123n }])('does not silently ignore explicit resume constraints (case %#)', async options => {
    stubFetch(circleResponse(message({ nonce: NONCE, finalityThresholdExecuted: 1000 })));
    await expect(finish(new BridgeModule(wallet).resume(BURN_TX, 'ethereum', options))).rejects.toMatchObject({ code: 'BURN_FAILED', recovery: { burnTxHash: BURN_TX } });
    expect(chain.mintCalls).toHaveLength(0);
    expect(chain.burnCalls).toHaveLength(0);
  });

  it.each([
    { nonce: 0n, finalityThresholdExecuted: 1000 },
    { nonce: NONCE, finalityThresholdExecuted: 0 },
    { nonce: NONCE, finalityThresholdExecuted: 999 },
    { nonce: NONCE, finalityThresholdExecuted: 1000, feeExecuted: 1n },
  ])('rejects invalid finalized fields in a completed attestation (case %#)', async changed => {
    stubFetch(circleResponse(message(changed)));
    await expect(finish(new BridgeModule(wallet).bridge(1_000_000n, 'ethereum', { destinationAddress: RECIPIENT }))).rejects.toMatchObject({ code: 'ATTESTATION_ERROR' });
    expect(chain.mintCalls).toHaveLength(0);
  });

  it('rejects confirmed attestation for a burn that requested full finality', async () => {
    chain.receipts.set(BURN_TX, burnReceipt(message({ minFinalityThreshold: 2000 })));
    stubFetch(circleResponse(message({ minFinalityThreshold: 2000, nonce: NONCE, finalityThresholdExecuted: 1000 })));
    await expect(finish(new BridgeModule(wallet).bridge(1_000_000n, 'ethereum', { destinationAddress: RECIPIENT, minFinalityThreshold: 2000 }))).rejects.toMatchObject({ code: 'ATTESTATION_ERROR' });
    expect(chain.mintCalls).toHaveLength(0);
  });

  it('retains the mint submission hash when its receipt is unavailable', async () => {
    const signedMessage = message({ nonce: NONCE, finalityThresholdExecuted: 1000 });
    stubFetch(circleResponse(signedMessage));
    chain.receipts.delete(MINT_TX);
    await expect(finish(new BridgeModule(wallet).bridge(1_000_000n, 'ethereum', { destinationAddress: RECIPIENT }))).rejects.toMatchObject({
      code: 'MINT_FAILED', recovery: { burnTxHash: BURN_TX, mintTxHash: MINT_TX },
    });
    expect(chain.mintCalls).toEqual([[signedMessage, SIGNATURE]]);
  });

  it.each([
    { sourceDomain: 3 }, { destinationDomain: 3 }, { mintRecipient: pad(OTHER_RECIPIENT, { size: 32 }) },
    { amount: 2_000_000n }, { burnToken: pad(OTHER_RECIPIENT, { size: 32 }) },
    { messageSender: pad(OTHER_RECIPIENT, { size: 32 }) }, { destinationCaller: pad(OTHER_RECIPIENT, { size: 32 }) },
    { minFinalityThreshold: 2000 }, { hookData: '0x01' as Hex },
  ])('rejects an attested message that changes the burned transfer (case %#)', async changed => {
    stubFetch(circleResponse(message({ nonce: NONCE, finalityThresholdExecuted: 2000, ...changed })));
    await expect(finish(new BridgeModule(wallet).bridge(1_000_000n, 'ethereum', { destinationAddress: RECIPIENT }))).rejects.toMatchObject({ code: 'ATTESTATION_ERROR' });
    expect(chain.mintCalls).toHaveLength(0);
  });

  it.each([
    {}, { status: 'complete', attestation: SIGNATURE },
    { sourceTxHash: MINT_TX, messages: [] },
    { sourceTxHash: BURN_TX, messages: [{ status: 'complete', cctpVersion: 2, message: '0x01', attestation: SIGNATURE }] },
    { sourceTxHash: BURN_TX, messages: [{ status: 'complete', cctpVersion: 2, message: message({ nonce: NONCE, finalityThresholdExecuted: 1000 }), attestation: '0x01' }] },
  ])('fails closed on a malformed or unrelated API response (case %#)', async payload => {
    stubFetch(payload);
    await expect(finish(new BridgeModule(wallet).bridge(1_000_000n, 'ethereum', { destinationAddress: RECIPIENT }))).rejects.toMatchObject({ code: 'ATTESTATION_ERROR' });
    expect(chain.mintCalls).toHaveLength(0);
  });

  it('rejects ambiguous duplicate matching messages', async () => {
    const payload = circleResponse(message({ nonce: NONCE, finalityThresholdExecuted: 2000 }));
    payload.messages.push(payload.messages[0]);
    stubFetch(payload);
    await expect(finish(new BridgeModule(wallet).bridge(1_000_000n, 'ethereum', { destinationAddress: RECIPIENT }))).rejects.toMatchObject({ code: 'ATTESTATION_ERROR' });
    expect(chain.mintCalls).toHaveLength(0);
  });

  it('selects the matching transfer among several messages in the source transaction', async () => {
    const signedMessage = message({ nonce: NONCE, finalityThresholdExecuted: 1000 });
    const payload = circleResponse(signedMessage);
    payload.messages.unshift({ ...payload.messages[0], message: message({ nonce: NONCE + 1n, finalityThresholdExecuted: 1000, amount: 3n }) });
    stubFetch(payload);
    await finish(new BridgeModule(wallet).bridge(1_000_000n, 'ethereum', { destinationAddress: RECIPIENT }));
    expect(chain.mintCalls).toEqual([[signedMessage, SIGNATURE]]);
  });

  it('ignores a MessageSent log from an unrelated emitter', async () => {
    const receipt = burnReceipt(message());
    receipt.logs[0].address = OTHER_RECIPIENT;
    chain.receipts.set(BURN_TX, receipt);
    await expect(new BridgeModule(wallet).burn(1_000_000n, 'ethereum')).rejects.toMatchObject({ code: 'BURN_FAILED', recovery: { burnTxHash: BURN_TX } });
    expect(chain.mintCalls).toHaveLength(0);
  });

  it.each(['mismatched transaction hash', 'reverted status', 'duplicate authenticated matching events'])(
    'rejects a burn receipt with %s before attestation or mint', async invalidReceipt => {
      const receipt = burnReceipt(message());
      if (invalidReceipt === 'mismatched transaction hash') receipt.transactionHash = MINT_TX;
      if (invalidReceipt === 'reverted status') receipt.status = 'reverted';
      if (invalidReceipt === 'duplicate authenticated matching events') receipt.logs.push({ ...receipt.logs[0] });
      chain.receipts.set(BURN_TX, receipt);
      stubFetch(circleResponse(message({ nonce: NONCE, finalityThresholdExecuted: 2000 })));

      await expect(finish(new BridgeModule(wallet).bridge(1_000_000n, 'ethereum', { destinationAddress: RECIPIENT }))).rejects.toMatchObject({
        code: 'BURN_FAILED', recovery: { burnTxHash: BURN_TX, sourceDomain: 6, destinationDomain: 0 },
      });

      expect(chain.burnCalls).toHaveLength(1);
      expect(chain.mintCalls).toHaveLength(0);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    },
  );
});

describe('CCTP V2 Solana flows', () => {
  const solanaFields: Partial<MessageFields> = {
    destinationDomain: 5, recipient: base58Bytes(SOLANA_TOKEN_MESSENGER), mintRecipient: SOLANA_RECIPIENT_BYTES,
  };

  it('forwards finalized 2000 in the EVM-to-Solana burn and returns the attested message', async () => {
    const emitted = message({ ...solanaFields, minFinalityThreshold: 2000 });
    const signedMessage = message({ ...solanaFields, minFinalityThreshold: 2000, nonce: NONCE, finalityThresholdExecuted: 2000 });
    chain.receipts.set(BURN_TX, burnReceipt(emitted));
    stubFetch(circleResponse(signedMessage));
    const resultPromise = finish(bridgeEVMToSolana(wallet, 1_000_000n, { solanaRecipient: SOLANA_TOKEN_ACCOUNT, minFinalityThreshold: FINALITY_THRESHOLD.FINALIZED }));
    const result = await resultPromise.catch(error => error);
    expect(chain.burnCalls[0][6]).toBe(2000);
    expect(chain.burnCalls[0][2]).toBe(SOLANA_RECIPIENT_BYTES);
    expect(result).toMatchObject({ messageBytes: signedMessage, attestation: SIGNATURE });
    expect(result.messageHash).toBe(keccak256(signedMessage));
  });

  it('rejects a Solana wallet owner address before approving or burning', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(rpcAccount(false)))));
    await expect(finish(bridgeEVMToSolana(wallet, 1_000_000n, { solanaRecipient: SOLANA_TOKEN_ACCOUNT }))).rejects.toMatchObject({ code: 'INVALID_RECIPIENT' });
    expect(chain.burnCalls).toHaveLength(0);
    expect(chain.approveCalls).toHaveLength(0);
  });

  it('rejects a short base58 address before querying accounts or burning', async () => {
    chain.receipts.set(BURN_TX, burnReceipt(message(solanaFields)));
    stubFetch(circleResponse(message({ ...solanaFields, nonce: NONCE, finalityThresholdExecuted: 1000 })));
    await expect(finish(bridgeEVMToSolana(wallet, 1_000_000n, { solanaRecipient: '2' }))).rejects.toMatchObject({ code: 'INVALID_RECIPIENT' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(chain.burnCalls).toHaveLength(0);
  });

  it('retains EVM-to-Solana burn details on polling timeout', async () => {
    const emitted = message(solanaFields);
    chain.receipts.set(BURN_TX, burnReceipt(emitted));
    stubFetch({ sourceTxHash: BURN_TX, messages: [{ status: 'pending_confirmations', cctpVersion: 2, message: emitted, attestation: 'PENDING' }] });
    await expect(finish(bridgeEVMToSolana(wallet, 1_000_000n, { solanaRecipient: SOLANA_TOKEN_ACCOUNT }))).rejects.toMatchObject({
      code: 'ATTESTATION_TIMEOUT', recovery: { burnTxHash: BURN_TX, sourceDomain: 6, destinationDomain: 5, messageBytes: emitted },
    });
    expect(chain.burnCalls).toHaveLength(1);
  });

  it('identifies an EVM-to-Solana burn receipt failure with its submitted hash', async () => {
    chain.receiptError = new Error('RPC unavailable');
    stubFetch({});
    await expect(finish(bridgeEVMToSolana(wallet, 1_000_000n, { solanaRecipient: SOLANA_TOKEN_ACCOUNT }))).rejects.toMatchObject({
      code: 'BURN_FAILED', recovery: { burnTxHash: BURN_TX, sourceDomain: 6, destinationDomain: 5 },
    });
    expect(chain.burnCalls).toHaveLength(1);
  });

  it('retains the known burn on a Solana resume preflight failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(rpcAccount(false)))));
    await expect(finish(bridgeEVMToSolana(wallet, 1_000_000n, { solanaRecipient: SOLANA_TOKEN_ACCOUNT, burnTxHash: BURN_TX }))).rejects.toMatchObject({
      code: 'INVALID_RECIPIENT', recovery: { burnTxHash: BURN_TX, sourceDomain: 6, destinationDomain: 5 },
    });
    expect(chain.burnCalls).toHaveLength(0);
  });

  it('can resume an EVM-to-Solana burn by transaction without burning again', async () => {
    const emitted = message(solanaFields);
    const signedMessage = message({ ...solanaFields, nonce: NONCE, finalityThresholdExecuted: 1000 });
    chain.receipts.set(BURN_TX, burnReceipt(emitted));
    stubFetch(circleResponse(signedMessage));
    const result = await finish(bridgeEVMToSolana(wallet, 1_000_000n, { solanaRecipient: SOLANA_TOKEN_ACCOUNT, burnTxHash: BURN_TX }));
    expect(result).toMatchObject({ burnTxHash: BURN_TX, messageBytes: signedMessage });
    expect(chain.burnCalls).toHaveLength(0);
    expect(chain.approveCalls).toHaveLength(0);
  });

  const fromSolanaFields: Partial<MessageFields> = {
    sourceDomain: 5, destinationDomain: 6, sender: base58Bytes(SOLANA_TOKEN_MESSENGER),
    burnToken: base58Bytes(SOLANA_USDC_MINT), messageSender: SOLANA_RECIPIENT_BYTES,
  };

  it('receives the signed Solana message and reports its actual recipient and net amount', async () => {
    const emitted = message({ ...fromSolanaFields, maxFee: 100n });
    const signedMessage = message({ ...fromSolanaFields, maxFee: 100n, feeExecuted: 25n, nonce: NONCE, finalityThresholdExecuted: 1000 });
    stubFetch(circleResponse(signedMessage, SOLANA_TX));
    const result = await finish(receiveFromSolanaOnEVM(wallet, { burnTxHash: SOLANA_TX, messageBytes: emitted, messageHash: keccak256(emitted), sourceDomain: 5 }, { toChain: 'base' }));
    expect(result).toMatchObject({ recipient: RECIPIENT, amount: 999_975n, mintTxHash: MINT_TX });
    expect(chain.mintCalls).toEqual([[signedMessage, SIGNATURE]]);
    const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
    expect(url.pathname).toBe('/v2/messages/5');
    expect(url.searchParams.get('transactionHash')).toBe(SOLANA_TX);
  });

  it.each(['receipt rejection', 'reverted receipt'])('retains both transaction identities after Solana-to-EVM mint %s', async failure => {
    const emitted = message(fromSolanaFields);
    const signedMessage = message({ ...fromSolanaFields, nonce: NONCE, finalityThresholdExecuted: 2000 });
    stubFetch(circleResponse(signedMessage, SOLANA_TX));
    if (failure === 'receipt rejection') chain.receiptError = new Error('Destination receipt RPC unavailable');
    else chain.receipts.set(MINT_TX, { transactionHash: MINT_TX, status: 'reverted', logs: [] });

    await expect(finish(receiveFromSolanaOnEVM(wallet, {
      burnTxHash: SOLANA_TX, messageBytes: emitted, messageHash: keccak256(emitted), sourceDomain: 5,
    }, { toChain: 'base' }))).rejects.toMatchObject({
      code: 'MINT_FAILED',
      recovery: { burnTxHash: SOLANA_TX, mintTxHash: MINT_TX, sourceDomain: 5, destinationDomain: 6, messageBytes: emitted, messageHash: keccak256(emitted) },
    });

    expect(chain.mintCalls).toEqual([[signedMessage, SIGNATURE]]);
    expect(chain.burnCalls).toHaveLength(0);
    expect(chain.approveCalls).toHaveLength(0);
  });

  it('rejects a caller-provided EVM recipient that differs from the burned recipient', async () => {
    const emitted = message(fromSolanaFields);
    stubFetch(circleResponse(message({ ...fromSolanaFields, nonce: NONCE, finalityThresholdExecuted: 2000 }), SOLANA_TX));
    await expect(finish(receiveFromSolanaOnEVM(wallet, { burnTxHash: SOLANA_TX, messageBytes: emitted, messageHash: keccak256(emitted), sourceDomain: 5 }, { toChain: 'base', evmRecipient: OTHER_RECIPIENT }))).rejects.toMatchObject({ code: 'INVALID_RECIPIENT' });
    expect(chain.mintCalls).toHaveLength(0);
  });
});
