/**
 * Regression tests for bridge findings 5, 9, 12, 14, 22 and 24.
 * viem clients are mocked; no network, keys or funds are used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, keccak256, type Hex } from 'viem';

const h = vi.hoisted(() => ({
  receipt: vi.fn(),
  allowance: vi.fn(),
  approve: vi.fn(),
  depositForBurn: vi.fn(),
  receiveMessage: vi.fn(),
  usedNonces: vi.fn(),
  priorReceipt: vi.fn(),
  priorTx: vi.fn(),
}));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      waitForTransactionReceipt: (...a: unknown[]) => h.receipt(...a),
      getTransactionReceipt: (...a: unknown[]) => h.priorReceipt(...a),
      getTransaction: (...a: unknown[]) => h.priorTx(...a),
    }),
    getContract: () => ({
      read: {
        allowance: (...a: unknown[]) => h.allowance(...a),
        usedNonces: (...a: unknown[]) => h.usedNonces(...a),
      },
      write: {
        approve: (...a: unknown[]) => h.approve(...a),
        depositForBurn: (...a: unknown[]) => h.depositForBurn(...a),
        receiveMessage: (...a: unknown[]) => h.receiveMessage(...a),
      },
    }),
  };
});

const {
  bridgeEVMToSolana,
  resumeEVMToSolana,
  receiveFromSolanaOnEVM,
  resumeSolanaToEVM,
  verifySolanaUsdcTokenAccount,
  solanaPubkeyToBytes32,
  SolanaBridgeError,
  SOLANA_USDC_MINT,
  SOLANA_TOKEN_MESSENGER,
  SOLANA_MAINNET_GENESIS_HASH,
  SPL_TOKEN_PROGRAM_ID,
} = await import('../solana.js');
const { BridgeModule, BridgeError, MESSAGE_TRANSMITTER_V2, USDC_CONTRACT } = await import('../client.js');
const { MessageTransmitterV2Abi } = await import('../abis.js');
const { encodeFunctionData } = await import('viem');
const { pollCircleAttestation, decodeCctpV2Message, assertBurnTerms } = await import('../attestation.js');
const { CCTP_DOMAIN_IDS } = await import('../types.js');

const BURN_TX = ('0x' + 'b1'.repeat(32)) as Hex;
const MINT_TX = ('0x' + 'c1'.repeat(32)) as Hex;
const EVM_ME = ('0x' + '11'.repeat(20)) as `0x${string}`;
const EVM_OTHER = ('0x' + '22'.repeat(20)) as `0x${string}`;
const SOL_TOKEN_ACCOUNT = 'GtExoGjWpLGHHPSoXZB4cXN8Z8XbH8wGjq7KBF9Hm6dM';
const SOL_OWNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MESSAGE_SENT_TOPIC = '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036' as Hex;

const w32 = (hex: string) => hex.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const u32 = (n: number) => n.toString(16).padStart(8, '0');

function buildMessage(p: {
  src: number; dst: number; nonce?: string; sender: string; burnToken: string;
  mintRecipient: string; amount: bigint; feeExecuted?: bigint;
  /** Defaults match the SDK's request defaults (FINALITY_THRESHOLD.FAST = 0, maxFee 0). */
  minFinality?: number; maxFee?: bigint;
}): Hex {
  const header = u32(1) + u32(p.src) + u32(p.dst) + w32(p.nonce ?? '0') + w32(p.sender) +
    w32('0x' + 'aa'.repeat(32)) + w32('0') + u32(p.minFinality ?? 0) + u32(0);
  const body = u32(1) + w32(p.burnToken) + w32(p.mintRecipient) + w32(p.amount.toString(16)) +
    w32('0x' + 'ee'.repeat(20)) + w32((p.maxFee ?? 0n).toString(16)) + w32((p.feeExecuted ?? 0n).toString(16)) + w32('0');
  return ('0x' + header + body) as Hex;
}

const walletClient = { account: { address: EVM_ME } } as never;

function solanaRpcFetch(overrides: { genesis?: string; account?: unknown } = {}) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body ?? '{}'));
    const result = req.method === 'getGenesisHash'
      ? (overrides.genesis ?? SOLANA_MAINNET_GENESIS_HASH)
      : ('account' in overrides ? overrides.account : {
          value: {
            owner: SPL_TOKEN_PROGRAM_ID,
            data: { program: 'spl-token', parsed: { type: 'account', info: { mint: SOLANA_USDC_MINT, owner: SOL_OWNER, state: 'initialized' } } },
          },
        });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
  });
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.allowance.mockResolvedValue(10n ** 18n);
  h.usedNonces.mockResolvedValue(0n);
});
afterEach(() => vi.unstubAllGlobals());

// ── Finding 9 ─────────────────────────────────────────────────────────────
describe('EVM→Solana recipient verification (finding 9)', () => {
  it('accepts an initialized mainnet USDC token account', async () => {
    await expect(verifySolanaUsdcTokenAccount(SOL_TOKEN_ACCOUNT, { fetchImpl: solanaRpcFetch() as never, owner: SOL_OWNER }))
      .resolves.toBeUndefined();
  });

  it.each([
    ['a missing account', { account: { value: null } }, /does not exist/],
    ['a wallet (system-owned) account', { account: { value: { owner: '11111111111111111111111111111111', data: ['', 'base64'] } } }, /not an SPL Token/],
    ['a token account for another mint', { account: { value: { owner: SPL_TOKEN_PROGRAM_ID, data: { parsed: { type: 'account', info: { mint: SOL_OWNER, state: 'initialized', owner: SOL_OWNER } } } } } }, /not for USDC/],
    ['a frozen/uninitialized account', { account: { value: { owner: SPL_TOKEN_PROGRAM_ID, data: { parsed: { type: 'account', info: { mint: SOLANA_USDC_MINT, state: 'frozen', owner: SOL_OWNER } } } } } }, /not initialized/],
    ['a non-mainnet RPC', { genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' }, /not mainnet-beta/],
  ])('rejects %s', async (_label, overrides, pattern) => {
    await expect(verifySolanaUsdcTokenAccount(SOL_TOKEN_ACCOUNT, { fetchImpl: solanaRpcFetch(overrides) as never }))
      .rejects.toThrow(pattern);
  });

  it('rejects a token account owned by someone else', async () => {
    await expect(verifySolanaUsdcTokenAccount(SOL_TOKEN_ACCOUNT, { fetchImpl: solanaRpcFetch() as never, owner: SOL_TOKEN_ACCOUNT }))
      .rejects.toThrow(/not owned by/);
  });

  it('rejects non-canonical base58 encodings', () => {
    expect(() => solanaPubkeyToBytes32('1' + SOL_TOKEN_ACCOUNT)).toThrow();
  });

  it('never approves or burns when the recipient is a wallet, not a token account', async () => {
    vi.stubGlobal('fetch', solanaRpcFetch({ account: { value: { owner: '11111111111111111111111111111111', data: ['', 'base64'] } } }));
    const err = await bridgeEVMToSolana(walletClient, 1_000_000n, { solanaRecipient: SOL_OWNER }).catch((e) => e);
    expect(err).toBeInstanceOf(SolanaBridgeError);
    expect(err.code).toBe('INVALID_RECIPIENT');
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.depositForBurn).not.toHaveBeenCalled();
  });
});

// ── Finding 5 ─────────────────────────────────────────────────────────────
describe('EVM→Solana post-broadcast recovery (finding 5)', () => {
  const burnMessage = () => buildMessage({
    src: CCTP_DOMAIN_IDS.base, dst: 5, sender: '0x' + '28'.repeat(20),
    burnToken: USDC_CONTRACT.base, mintRecipient: solanaPubkeyToBytes32(SOL_TOKEN_ACCOUNT), amount: 1_000_000n,
  });
  const burnReceipt = () => ({
    status: 'success',
    logs: [{
      address: MESSAGE_TRANSMITTER_V2.base,
      topics: [MESSAGE_SENT_TOPIC],
      data: encodeAbiParameters([{ type: 'bytes' }], [burnMessage()]),
    }],
  });

  it('attaches immutable recovery to every post-hash failure and resumes without burning again', async () => {
    const rpc = solanaRpcFetch();
    let circleCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('iris')) {
        circleCalls += 1;
        return new Response('upstream exploded', { status: 500 });
      }
      return rpc(url, init);
    }));
    h.depositForBurn.mockResolvedValue(BURN_TX);
    h.receipt.mockRejectedValueOnce(new Error('rpc dropped'));

    const err = await bridgeEVMToSolana(walletClient, 1_000_000n, { solanaRecipient: SOL_TOKEN_ACCOUNT }).catch((e) => e);
    expect(err.code).toBe('BURN_UNCONFIRMED');
    expect(err.recovery).toMatchObject({ burnTxHash: BURN_TX, amount: 1_000_000n, destinationDomain: 5 });
    expect(Object.isFrozen(err.recovery)).toBe(true);
    expect(h.depositForBurn).toHaveBeenCalledTimes(1);

    // Attestation failure after a confirmed burn still carries recovery + message bytes.
    h.receipt.mockResolvedValue(burnReceipt());
    const err2 = await resumeEVMToSolana(err.recovery).catch((e) => e);
    expect(err2.code).toBe('ATTESTATION_ERROR');
    expect(err2.recovery.messageBytes).toBe(burnMessage());
    expect(circleCalls).toBe(1);

    // A successful resume uses only the known hash.
    const attested = burnMessage();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      messages: [{ status: 'complete', message: attested, attestation: '0x' + 'ab'.repeat(65) }],
    }), { status: 200 })));
    const done = await resumeEVMToSolana(err.recovery);
    expect(done.burnTxHash).toBe(BURN_TX);
    expect(h.depositForBurn).toHaveBeenCalledTimes(1);
  });

  it('rejects a burn receipt whose message does not match the requested terms', async () => {
    vi.stubGlobal('fetch', solanaRpcFetch());
    h.depositForBurn.mockResolvedValue(BURN_TX);
    const wrong = buildMessage({
      src: CCTP_DOMAIN_IDS.base, dst: 5, sender: '0x' + '28'.repeat(20),
      burnToken: USDC_CONTRACT.base, mintRecipient: solanaPubkeyToBytes32(SOL_OWNER), amount: 1_000_000n,
    });
    h.receipt.mockResolvedValue({ status: 'success', logs: [{
      address: MESSAGE_TRANSMITTER_V2.base, topics: [MESSAGE_SENT_TOPIC],
      data: encodeAbiParameters([{ type: 'bytes' }], [wrong]),
    }] });
    const err = await bridgeEVMToSolana(walletClient, 1_000_000n, { solanaRecipient: SOL_TOKEN_ACCOUNT }).catch((e) => e);
    expect(err.code).toBe('BURN_UNCONFIRMED');
    expect(err.message).toMatch(/mintRecipient/);
    expect(err.recovery.burnTxHash).toBe(BURN_TX);
  });

  it.each([
    ['maxFee', { maxFee: 5_000n }],
    ['minFinalityThreshold', { minFinality: 2000 }],
  ])('rejects a burn whose %s differs from the request (Codex round 7)', async (field, override) => {
    vi.stubGlobal('fetch', solanaRpcFetch());
    h.depositForBurn.mockResolvedValue(BURN_TX);
    const altered = buildMessage({
      src: CCTP_DOMAIN_IDS.base, dst: 5, sender: '0x' + '28'.repeat(20),
      burnToken: USDC_CONTRACT.base, mintRecipient: solanaPubkeyToBytes32(SOL_TOKEN_ACCOUNT), amount: 1_000_000n,
      ...override,
    });
    h.receipt.mockResolvedValue({ status: 'success', logs: [{
      address: MESSAGE_TRANSMITTER_V2.base, topics: [MESSAGE_SENT_TOPIC],
      data: encodeAbiParameters([{ type: 'bytes' }], [altered]),
    }] });
    const err = await bridgeEVMToSolana(walletClient, 1_000_000n, { solanaRecipient: SOL_TOKEN_ACCOUNT }).catch((e) => e);
    expect(err.code).toBe('BURN_UNCONFIRMED');
    expect(err.message).toContain(field);
    expect(err.recovery).toMatchObject({ maxFee: 0n, minFinalityThreshold: 0 });
  });

  it('ignores MessageSent logs from contracts other than the CCTP transmitter', async () => {
    vi.stubGlobal('fetch', solanaRpcFetch());
    h.depositForBurn.mockResolvedValue(BURN_TX);
    h.receipt.mockResolvedValue({ status: 'success', logs: [{
      address: EVM_OTHER, topics: [MESSAGE_SENT_TOPIC],
      data: encodeAbiParameters([{ type: 'bytes' }], [burnMessage()]),
    }] });
    const err = await bridgeEVMToSolana(walletClient, 1_000_000n, { solanaRecipient: SOL_TOKEN_ACCOUNT }).catch((e) => e);
    expect(err.code).toBe('BURN_UNCONFIRMED');
  });
});

// ── Findings 22 and 24 ────────────────────────────────────────────────────
describe('Solana→EVM receive binding and mint ambiguity (findings 22, 24)', () => {
  const source = (recipient = EVM_ME, amount = 5_000_000n) => buildMessage({
    src: 5, dst: CCTP_DOMAIN_IDS.arbitrum, sender: solanaPubkeyToBytes32(SOLANA_TOKEN_MESSENGER),
    burnToken: solanaPubkeyToBytes32(SOLANA_USDC_MINT), mintRecipient: recipient, amount,
  });
  const attestedFor = (msg: Hex, feeExecuted = 0n) => {
    const d = decodeCctpV2Message(msg);
    return buildMessage({
      src: d.sourceDomain, dst: d.destinationDomain, nonce: '0x' + '77'.repeat(32), sender: d.sender,
      burnToken: d.burnToken, mintRecipient: d.mintRecipient, amount: d.amount, feeExecuted,
    });
  };
  const params = (msg: Hex) => ({
    messageBytes: msg, messageHash: keccak256(msg), sourceDomain: 5, burnTxSignature: '5'.repeat(88),
  });
  const circle = (attested: Hex) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    messages: [{ status: 'complete', message: attested, attestation: '0x' + 'ab'.repeat(65) }],
  }), { status: 200 })));

  it('refuses to report a recipient that differs from the message mintRecipient', async () => {
    const msg = source(EVM_ME);
    circle(attestedFor(msg));
    const err = await receiveFromSolanaOnEVM(walletClient, params(msg), { toChain: 'arbitrum', evmRecipient: EVM_OTHER }).catch((e) => e);
    expect(err.code).toBe('INVALID_RECIPIENT');
    expect(h.receiveMessage).not.toHaveBeenCalled();
  });

  it('rejects a messageHash that does not commit to the message bytes', async () => {
    const msg = source();
    const err = await receiveFromSolanaOnEVM(walletClient, { ...params(msg), messageHash: ('0x' + '00'.repeat(32)) as Hex }, { toChain: 'arbitrum' }).catch((e) => e);
    expect(err.code).toBe('ATTESTATION_ERROR');
    expect(h.receiveMessage).not.toHaveBeenCalled();
  });

  it('rejects a message for another destination domain', async () => {
    const msg = source();
    const err = await receiveFromSolanaOnEVM(walletClient, params(msg), { toChain: 'base' }).catch((e) => e);
    expect(err.code).toBe('INVALID_RECIPIENT');
  });

  it('derives the returned recipient and amount from the attested bytes', async () => {
    const msg = source(EVM_ME, 5_000_000n);
    circle(attestedFor(msg, 1_000n));
    h.receiveMessage.mockResolvedValue(MINT_TX);
    h.receipt.mockResolvedValue({ status: 'success', logs: [] });
    const r = await receiveFromSolanaOnEVM(walletClient, params(msg), { toChain: 'arbitrum' });
    expect(r).toMatchObject({ mintTxHash: MINT_TX, recipient: EVM_ME, amount: 4_999_000n });
  });

  it('classifies an ambiguous receiveMessage error as MINT_SUBMISSION_UNKNOWN with recovery', async () => {
    const msg = source();
    circle(attestedFor(msg));
    h.receiveMessage.mockRejectedValue(new Error('socket hang up'));
    const err = await receiveFromSolanaOnEVM(walletClient, params(msg), { toChain: 'arbitrum' }).catch((e) => e);
    expect(err.code).toBe('MINT_SUBMISSION_UNKNOWN');
    expect(err.mintRecovery).toMatchObject({ toChain: 'arbitrum', nonce: '0x' + '77'.repeat(32) });
  });

  it('keeps the mint hash when the receipt cannot be read', async () => {
    const msg = source();
    circle(attestedFor(msg));
    h.receiveMessage.mockResolvedValue(MINT_TX);
    h.receipt.mockRejectedValue(new Error('timeout'));
    const err = await receiveFromSolanaOnEVM(walletClient, params(msg), { toChain: 'arbitrum' }).catch((e) => e);
    expect(err.code).toBe('MINT_UNCONFIRMED');
    expect(err.mintRecovery.mintTxHash).toBe(MINT_TX);
  });

  it('does not resubmit a mint whose nonce is already used', async () => {
    const msg = source();
    circle(attestedFor(msg));
    h.usedNonces.mockResolvedValue(1n);
    const err = await receiveFromSolanaOnEVM(walletClient, params(msg), { toChain: 'arbitrum' }).catch((e) => e);
    expect(err.code).toBe('MINT_ALREADY_RECEIVED');
    expect(h.receiveMessage).not.toHaveBeenCalled();
  });

  describe('resumeSolanaToEVM reconciles a retained mint before any new write (Codex round 4)', () => {
    async function unconfirmed() {
      const msg = source(EVM_ME, 5_000_000n);
      circle(attestedFor(msg, 1_000n));
      h.receiveMessage.mockResolvedValue(MINT_TX);
      h.receipt.mockRejectedValue(new Error('timeout'));
      const err = await receiveFromSolanaOnEVM(walletClient, params(msg), { toChain: 'arbitrum' }).catch((e) => e);
      expect(err.code).toBe('MINT_UNCONFIRMED');
      h.receiveMessage.mockClear();
      return err.mintRecovery;
    }

    it('does not resubmit while the retained mint is still pending', async () => {
      const recovery = await unconfirmed();
      h.priorReceipt.mockRejectedValue(new Error('Transaction receipt could not be found'));
      const err = await resumeSolanaToEVM(walletClient, recovery).catch((e) => e);
      expect(err.code).toBe('MINT_UNCONFIRMED');
      expect(err.mintRecovery.mintTxHash).toBe(MINT_TX);
      expect(h.receiveMessage).not.toHaveBeenCalled();
    });

    const mintCall = (recovery: { attestedMessage: Hex; attestation: Hex }) => ({
      hash: MINT_TX,
      to: MESSAGE_TRANSMITTER_V2.arbitrum,
      input: encodeFunctionData({ abi: MessageTransmitterV2Abi, functionName: 'receiveMessage', args: [recovery.attestedMessage, recovery.attestation] }),
    });

    it('returns the retained mint once it succeeded and the nonce is consumed', async () => {
      const recovery = await unconfirmed();
      h.priorReceipt.mockResolvedValue({ transactionHash: MINT_TX, status: 'success' });
      h.priorTx.mockResolvedValue(mintCall(recovery));
      h.usedNonces.mockResolvedValue(1n);
      const r = await resumeSolanaToEVM(walletClient, recovery);
      expect(r).toMatchObject({ mintTxHash: MINT_TX, recipient: EVM_ME, amount: 4_999_000n, toChain: 'arbitrum' });
      expect(h.receiveMessage).not.toHaveBeenCalled();
    });

    it('refuses a retained hash that is not this message\'s receiveMessage (Codex round 8)', async () => {
      const recovery = await unconfirmed();
      h.priorReceipt.mockResolvedValue({ transactionHash: MINT_TX, status: 'success' });
      h.usedNonces.mockResolvedValue(1n); // consumed by someone else, e.g. a relayer
      for (const tx of [
        { ...mintCall(recovery), to: EVM_OTHER },
        mintCall({ ...recovery, attestation: ('0x' + 'cd'.repeat(65)) as Hex }),
        { hash: MINT_TX, to: MESSAGE_TRANSMITTER_V2.arbitrum, input: '0xdeadbeef' as Hex },
      ]) {
        h.priorTx.mockResolvedValueOnce(tx);
        const err = await resumeSolanaToEVM(walletClient, recovery).catch((e) => e);
        expect(err.code).toBe('MINT_UNCONFIRMED');
      }
      expect(h.receiveMessage).not.toHaveBeenCalled();
    });

    describe('retained-mint evidence must be for the retained hash (Codex round 9)', () => {
      const OTHER_TX = ('0x' + 'e4'.repeat(32)) as Hex;

      it.each([
        ['a different hash', OTHER_TX],
        ['no hash', undefined],
      ])('refuses a successful receipt bound to %s', async (_label, transactionHash) => {
        const recovery = await unconfirmed();
        h.priorReceipt.mockResolvedValue({ transactionHash, status: 'success' });
        h.priorTx.mockResolvedValue(mintCall(recovery));
        h.usedNonces.mockResolvedValue(1n);
        const err = await resumeSolanaToEVM(walletClient, recovery).catch((e) => e);
        expect(err.code).toBe('MINT_UNCONFIRMED');
        expect(h.receiveMessage).not.toHaveBeenCalled();
      });

      it.each([
        ['a different hash', OTHER_TX],
        ['no hash', undefined],
      ])('refuses a receiveMessage body bound to %s', async (_label, hash) => {
        const recovery = await unconfirmed();
        h.priorReceipt.mockResolvedValue({ transactionHash: MINT_TX, status: 'success' });
        h.priorTx.mockResolvedValue({ ...mintCall(recovery), hash });
        h.usedNonces.mockResolvedValue(1n);
        const err = await resumeSolanaToEVM(walletClient, recovery).catch((e) => e);
        expect(err.code).toBe('MINT_UNCONFIRMED');
        expect(h.receiveMessage).not.toHaveBeenCalled();
      });

      it('does not treat another hash\'s revert as the retained mint reverting', async () => {
        const recovery = await unconfirmed();
        h.priorReceipt.mockResolvedValue({ transactionHash: OTHER_TX, status: 'reverted' });
        h.receiveMessage.mockResolvedValue(('0x' + 'c2'.repeat(32)) as Hex);
        const err = await resumeSolanaToEVM(walletClient, recovery).catch((e) => e);
        expect(err.code).toBe('MINT_UNCONFIRMED');
        expect(err.mintRecovery.mintTxHash).toBe(MINT_TX);
        expect(h.receiveMessage).not.toHaveBeenCalled();
      });
    });

    it('refuses a "successful" retained tx whose nonce was never consumed', async () => {
      const recovery = await unconfirmed();
      h.priorReceipt.mockResolvedValue({ transactionHash: MINT_TX, status: 'success' });
      h.priorTx.mockResolvedValue(mintCall(recovery));
      h.usedNonces.mockResolvedValue(0n);
      const err = await resumeSolanaToEVM(walletClient, recovery).catch((e) => e);
      expect(err.code).toBe('MINT_UNCONFIRMED');
      expect(h.receiveMessage).not.toHaveBeenCalled();
    });

    it('mints again only after the retained tx reverted and the nonce is unused', async () => {
      const recovery = await unconfirmed();
      const NEW_TX = ('0x' + 'c2'.repeat(32)) as Hex;
      h.priorReceipt.mockResolvedValue({ transactionHash: MINT_TX, status: 'reverted' });
      h.receiveMessage.mockResolvedValue(NEW_TX);
      h.receipt.mockReset().mockResolvedValue({ status: 'success', logs: [] });
      const r = await resumeSolanaToEVM(walletClient, recovery);
      expect(r.mintTxHash).toBe(NEW_TX);
      expect(h.receiveMessage).toHaveBeenCalledTimes(1);
    });

    it('keeps a hashless ambiguous mint locked until the caller reconciles it (Codex round 5)', async () => {
      const msg = source(EVM_ME, 5_000_000n);
      circle(attestedFor(msg, 1_000n));
      h.receiveMessage.mockRejectedValue(new Error('socket hang up'));
      const err = await receiveFromSolanaOnEVM(walletClient, params(msg), { toChain: 'arbitrum' }).catch((e) => e);
      expect(err.code).toBe('MINT_SUBMISSION_UNKNOWN');
      expect(err.mintRecovery.mintTxHash).toBeUndefined();
      h.receiveMessage.mockReset().mockResolvedValue(MINT_TX);
      h.receipt.mockReset().mockResolvedValue({ status: 'success', logs: [] });

      const held = await resumeSolanaToEVM(walletClient, err.mintRecovery).catch((e) => e);
      expect(held.code).toBe('MINT_SUBMISSION_UNKNOWN');
      expect(h.receiveMessage).not.toHaveBeenCalled();

      h.usedNonces.mockResolvedValueOnce(1n);
      const done = await resumeSolanaToEVM(walletClient, err.mintRecovery).catch((e) => e);
      expect(done.code).toBe('MINT_ALREADY_RECEIVED');
      expect(h.receiveMessage).not.toHaveBeenCalled();

      const r = await resumeSolanaToEVM(walletClient, err.mintRecovery, { originalSubmissionReconciled: true });
      expect(r.mintTxHash).toBe(MINT_TX);
      expect(h.receiveMessage).toHaveBeenCalledTimes(1);
    });

    it('rejects a tampered recovery before any read or write', async () => {
      const recovery = await unconfirmed();
      const err1 = await resumeSolanaToEVM(walletClient, { ...recovery, recipient: EVM_OTHER }).catch((e) => e);
      expect(err1.code).toBe('ATTESTATION_ERROR');
      const err2 = await resumeSolanaToEVM(walletClient, { ...recovery, nonce: ('0x' + '00'.repeat(32)) as Hex }).catch((e) => e);
      expect(err2.code).toBe('ATTESTATION_ERROR');
      const err3 = await resumeSolanaToEVM(walletClient, { ...recovery, toChain: 'base' }).catch((e) => e);
      expect(err3.code).toBe('ATTESTATION_ERROR');
      expect(h.priorReceipt).not.toHaveBeenCalled();
      expect(h.receiveMessage).not.toHaveBeenCalled();
    });
  });

  it('treats a wallet rejection as a definite (not ambiguous) failure', async () => {
    const msg = source();
    circle(attestedFor(msg));
    h.receiveMessage.mockRejectedValue(Object.assign(new Error('User rejected'), { name: 'UserRejectedRequestError' }));
    const err = await receiveFromSolanaOnEVM(walletClient, params(msg), { toChain: 'arbitrum' }).catch((e) => e);
    expect(err.code).toBe('MINT_FAILED');
  });
});

// ── Finding 14 ────────────────────────────────────────────────────────────
describe('waitForAttestation binds to the known burn (finding 14)', () => {
  const ours = () => buildMessage({
    src: CCTP_DOMAIN_IDS.base, dst: CCTP_DOMAIN_IDS.arbitrum, sender: '0x' + '28'.repeat(20),
    burnToken: USDC_CONTRACT.base, mintRecipient: EVM_ME, amount: 7n,
  });
  const unrelated = () => buildMessage({
    src: CCTP_DOMAIN_IDS.base, dst: CCTP_DOMAIN_IDS.arbitrum, nonce: '0x01', sender: '0x' + '28'.repeat(20),
    burnToken: USDC_CONTRACT.base, mintRecipient: EVM_OTHER, amount: 9_999n,
  });

  it('rejects a single unrelated attested message', async () => {
    h.receipt.mockResolvedValue({ status: 'success', logs: [{
      address: MESSAGE_TRANSMITTER_V2.base, topics: [MESSAGE_SENT_TOPIC],
      data: encodeAbiParameters([{ type: 'bytes' }], [ours()]),
    }] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      messages: [{ status: 'complete', message: unrelated(), attestation: '0xaa' }],
    }), { status: 200 })));
    const module = new BridgeModule(walletClient, 'base');
    const err = await module.waitForAttestation(BURN_TX).catch((e) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.message).toMatch(/no CCTP message matching/);
  });

  it('returns the attestation that matches the burn receipt', async () => {
    h.receipt.mockResolvedValue({ status: 'success', logs: [{
      address: MESSAGE_TRANSMITTER_V2.base, topics: [MESSAGE_SENT_TOPIC],
      data: encodeAbiParameters([{ type: 'bytes' }], [ours()]),
    }] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      messages: [{ status: 'complete', message: unrelated(), attestation: '0xaa' }, { status: 'complete', message: ours(), attestation: '0xbb' }],
    }), { status: 200 })));
    const module = new BridgeModule(walletClient, 'base');
    expect((await module.waitForAttestation(BURN_TX)).attestation).toBe('0xbb');
  });
});

// ── Finding 12 ────────────────────────────────────────────────────────────
describe('bounded attestation polling (finding 12)', () => {
  const base = {
    burnTx: BURN_TX, sourceDomain: 6, apiUrl: 'https://iris-api.circle.com',
    expectedMessage: buildMessage({ src: 6, dst: 3, sender: '0x01', burnToken: '0x02', mintRecipient: '0x03', amount: 1n }),
    maxPolls: 3, intervalMs: 1, sleep: async () => undefined,
    makeError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  };

  it('rejects an oversized response body', async () => {
    const huge = new Response('x'.repeat(300 * 1024), { status: 200 });
    const err = await pollCircleAttestation({ ...base, fetchImpl: (async () => huge) as never }).catch((e) => e);
    expect(err.code).toBe('ATTESTATION_ERROR');
    expect(err.message).toMatch(/exceeded|declares/);
  });

  it('bounds a body that never finishes and times out instead of hanging', async () => {
    const stalled = () => new Response(new ReadableStream({ start() { /* never enqueue or close */ } }), { status: 200 });
    const err = await pollCircleAttestation({ ...base, requestTimeoutMs: 20, fetchImpl: (async () => stalled()) as never }).catch((e) => e);
    expect(err.code).toBe('ATTESTATION_TIMEOUT');
  });

  it('rejects too many messages and oversized fields', async () => {
    const many = { messages: Array.from({ length: 40 }, () => ({ status: 'pending' })) };
    const err = await pollCircleAttestation({ ...base, fetchImpl: (async () => new Response(JSON.stringify(many))) as never }).catch((e) => e);
    expect(err.message).toMatch(/limit/);
    const fat = { messages: [{ status: 'complete', message: '0x' + 'ab'.repeat(40_000), attestation: '0x00' }] };
    const err2 = await pollCircleAttestation({ ...base, fetchImpl: (async () => new Response(JSON.stringify(fat))) as never }).catch((e) => e);
    expect(err2.message).toMatch(/oversized/);
  });
});

// ── Review follow-ups ─────────────────────────────────────────────────────
describe('review follow-ups', () => {
  it('EVM bridge: a successful burn without a transmitter MessageSent is BURN_UNCONFIRMED with recovery, never BURN_FAILED', async () => {
    h.depositForBurn.mockResolvedValue(BURN_TX);
    const msg = buildMessage({
      src: CCTP_DOMAIN_IDS.base, dst: CCTP_DOMAIN_IDS.arbitrum, sender: '0x' + '28'.repeat(20),
      burnToken: USDC_CONTRACT.base, mintRecipient: EVM_ME, amount: 5n,
    });
    h.receipt.mockResolvedValue({ status: 'success', logs: [{
      address: EVM_OTHER, topics: [MESSAGE_SENT_TOPIC], data: encodeAbiParameters([{ type: 'bytes' }], [msg]),
    }] });
    const err = await new BridgeModule(walletClient, 'base').bridge(5n, 'arbitrum').catch((e) => e);
    expect(err.code).toBe('BURN_UNCONFIRMED');
    expect(err.recovery?.burnTxHash).toBe(BURN_TX);
  });

  it('rejects non-hex completed Circle messages', async () => {
    const good = buildMessage({ src: 6, dst: 3, sender: '0x01', burnToken: '0x02', mintRecipient: '0x03', amount: 1n });
    const junk = good.slice(0, 2 + 24) + 'zz' + good.slice(2 + 26);
    const err = await pollCircleAttestation({
      burnTx: BURN_TX, sourceDomain: 6, apiUrl: 'https://iris-api.circle.com', expectedMessage: good,
      maxPolls: 1, intervalMs: 1, sleep: async () => undefined,
      makeError: (code: string, message: string) => Object.assign(new Error(message), { code }),
      fetchImpl: (async () => new Response(JSON.stringify({ messages: [{ status: 'complete', message: junk, attestation: '0xaa' }] }))) as never,
    }).catch((e) => e);
    expect(err.code).toBe('ATTESTATION_ERROR');
  });

  it('does not submit receiveMessage when usedNonces cannot be read', async () => {
    const msg = buildMessage({
      src: 5, dst: CCTP_DOMAIN_IDS.arbitrum, sender: solanaPubkeyToBytes32(SOLANA_TOKEN_MESSENGER),
      burnToken: solanaPubkeyToBytes32(SOLANA_USDC_MINT), mintRecipient: EVM_ME, amount: 5n,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      messages: [{ status: 'complete', message: msg, attestation: '0x' + 'ab'.repeat(65) }],
    }))));
    h.usedNonces.mockRejectedValue(new Error('rpc down'));
    const err = await receiveFromSolanaOnEVM(walletClient, {
      messageBytes: msg, messageHash: keccak256(msg), sourceDomain: 5, burnTxSignature: '5'.repeat(88),
    }, { toChain: 'arbitrum' }).catch((e) => e);
    expect(err.code).toBe('MINT_FAILED');
    expect(h.receiveMessage).not.toHaveBeenCalled();
  });
});

describe('assertBurnTerms covers fee and finality (Codex round 7)', () => {
  const msg = buildMessage({
    src: 6, dst: 5, sender: '0x' + '28'.repeat(20), burnToken: '0x' + '33'.repeat(20),
    mintRecipient: '0x' + '44'.repeat(32), amount: 10n, maxFee: 7n, minFinality: 1000,
  });
  it('accepts matching maxFee and minFinalityThreshold', () => {
    expect(assertBurnTerms(msg, { maxFee: 7n, minFinalityThreshold: 1000 }).maxFee).toBe(7n);
  });
  it('rejects a larger fee or weaker finality', () => {
    expect(() => assertBurnTerms(msg, { maxFee: 6n })).toThrow(/maxFee/);
    expect(() => assertBurnTerms(msg, { minFinalityThreshold: 2000 })).toThrow(/minFinalityThreshold/);
  });
});

describe('Solana recipient verification brackets the account read (Codex round 7)', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('rejects a recipient read while the RPC switched clusters, before any approve or burn', async () => {
    let genesisCalls = 0;
    const base = solanaRpcFetch();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body ?? '{}'));
      if (req.method === 'getGenesisHash') {
        genesisCalls += 1;
        const genesis = genesisCalls === 1 ? SOLANA_MAINNET_GENESIS_HASH : 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: genesis }), { status: 200 });
      }
      return base(url, init);
    }));
    await expect(verifySolanaUsdcTokenAccount(SOL_TOKEN_ACCOUNT)).rejects.toThrow(/after the recipient lookup/);
    const err = await bridgeEVMToSolana(walletClient, 1_000_000n, { solanaRecipient: SOL_TOKEN_ACCOUNT }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.depositForBurn).not.toHaveBeenCalled();
  });
});
