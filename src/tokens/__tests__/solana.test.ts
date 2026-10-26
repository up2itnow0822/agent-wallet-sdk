import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSolanaWallet, formatSolanaUnits, SOLANA_TOKENS } from '../solana.js';

const solana = vi.hoisted(() => ({
  sent: [] as Array<{ instructions: Array<{ amount: bigint | number }> }>,
  getAccountInfo: vi.fn(),
  createAta: vi.fn(),
  transfer: vi.fn(),
  genesis: vi.fn(),
  mintDecimals: 6 as number,
  checkedDecimals: [] as number[],
}));

vi.mock('@solana/web3.js', () => {
  class PublicKey {
    constructor(readonly value: string) {}
    toBase58() { return this.value; }
  }
  return {
    PublicKey,
    Connection: class {
      getAccountInfo = solana.getAccountInfo;
      getGenesisHash = solana.genesis;
    },
    Keypair: { fromSecretKey: () => ({ publicKey: new PublicKey('sender') }) },
    Transaction: class {
      instructions: Array<{ amount: bigint | number }> = [];
      add(...instructions: Array<{ amount: bigint | number }>) {
        this.instructions.push(...instructions);
        return this;
      }
    },
    SystemProgram: { transfer: ({ lamports }: { lamports: bigint | number }) => ({ amount: lamports }) },
    sendAndConfirmTransaction: async (_connection: unknown, tx: { instructions: Array<{ amount: bigint | number }> }) => {
      solana.sent.push(tx);
      return 'test-signature';
    },
  };
});

vi.mock('@solana/spl-token', () => ({
  getMint: async () => ({ decimals: solana.mintDecimals }),
  getAssociatedTokenAddress: async (_mint: unknown, owner: { value: string }) => `ata:${owner.value}`,
  createAssociatedTokenAccountInstruction: solana.createAta,
  createTransferCheckedInstruction: (
    _from: unknown, _mint: unknown, _to: unknown, _owner: unknown, amount: bigint, decimals: number,
  ) => {
    solana.transfer(amount);
    solana.checkedDecimals.push(decimals);
    return { amount };
  },
}));

beforeEach(() => {
  solana.sent.length = 0;
  solana.getAccountInfo.mockReset().mockResolvedValue(null);
  solana.createAta.mockReset().mockReturnValue({ amount: 0n });
  solana.transfer.mockReset();
  solana.genesis.mockReset().mockResolvedValue('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
  solana.mintDecimals = 6;
  solana.checkedDecimals.length = 0;
});

describe('Solana transfer amount validation', () => {
  const invalidAmounts = ['-0.5', '-1.5', '0', '0.0000000001', '1.2.3', '1e3', 'abc', '', 0n, -1n];

  it.each(invalidAmounts)('rejects SOL amount %s before submitting a transaction', async amount => {
    const wallet = createSolanaWallet({ keypairBytes: new Uint8Array(64) });
    await expect(wallet.sendSol('recipient', amount)).rejects.toThrow();
    expect(solana.sent).toHaveLength(0);
  });

  it.each(invalidAmounts)('rejects SPL amount %s before ATA preflight or transfer creation', async amount => {
    const wallet = createSolanaWallet({ keypairBytes: new Uint8Array(64) });
    await expect(wallet.sendSplToken('recipient', amount, SOLANA_TOKENS.USDC)).rejects.toThrow();
    expect(solana.getAccountInfo).not.toHaveBeenCalled();
    expect(solana.createAta).not.toHaveBeenCalled();
    expect(solana.transfer).not.toHaveBeenCalled();
    expect(solana.sent).toHaveLength(0);
  });

  it.each([['0.5', 500_000_000n], ['1.5', 1_500_000_000n], ['9007199.254740993', 9_007_199_254_740_993n], [12n, 12n]] as const)(
    'submits the exact positive SOL amount %s', async (amount, expected) => {
      const wallet = createSolanaWallet({ keypairBytes: new Uint8Array(64) });
      await expect(wallet.sendSol('recipient', amount)).resolves.toEqual({ signature: 'test-signature' });
      expect(BigInt(solana.sent[0].instructions[0].amount)).toBe(expected);
    },
  );

  it.each([['0.5', 500_000n], ['1.5', 1_500_000n], [12n, 12n]] as const)(
    'submits the exact positive SPL amount %s', async (amount, expected) => {
      const wallet = createSolanaWallet({ keypairBytes: new Uint8Array(64) });
      await expect(wallet.sendSplToken('recipient', amount, SOLANA_TOKENS.USDC)).resolves.toEqual({ signature: 'test-signature' });
      const instructions = solana.sent[0].instructions;
      expect(instructions[instructions.length - 1]?.amount).toBe(expected);
    },
  );
});

describe('Solana SPL scale and cluster binding (finding 1)', () => {
  const UNKNOWN_MINT = 'So11111111111111111111111111111111111111112x';

  it('rejects a known mint when the RPC reports different decimals, before signing', async () => {
    solana.mintDecimals = 0; // adversarial RPC: "1" USDC would become 1e6x on a 6-dec scale
    const wallet = createSolanaWallet({ keypairBytes: new Uint8Array(64) });
    await expect(wallet.sendSplToken('recipient', '1', SOLANA_TOKENS.USDC)).rejects.toThrow(/pinned/);
    expect(solana.transfer).not.toHaveBeenCalled();
    expect(solana.sent).toHaveLength(0);
  });

  it('uses the pinned registry scale, never the RPC scale, for known mints', async () => {
    const wallet = createSolanaWallet({ keypairBytes: new Uint8Array(64) });
    await wallet.sendSplToken('recipient', '2', SOLANA_TOKENS.USDC);
    expect(solana.transfer).toHaveBeenCalledWith(2_000_000n);
    expect(solana.checkedDecimals).toEqual([6]);
  });

  it('requires expectedDecimals for string amounts of unknown mints', async () => {
    const wallet = createSolanaWallet({ keypairBytes: new Uint8Array(64) });
    await expect(wallet.sendSplToken('recipient', '1', UNKNOWN_MINT)).rejects.toThrow(/expectedDecimals/);
    expect(solana.sent).toHaveLength(0);
  });

  it('rejects an unknown mint whose RPC decimals differ from expectedDecimals', async () => {
    solana.mintDecimals = 18;
    const wallet = createSolanaWallet({ keypairBytes: new Uint8Array(64) });
    await expect(
      wallet.sendSplToken('recipient', '1', UNKNOWN_MINT, { expectedDecimals: 9 }),
    ).rejects.toThrow(/pinned/);
    expect(solana.sent).toHaveLength(0);
  });

  it('rejects expectedDecimals that contradict the pinned table', async () => {
    const wallet = createSolanaWallet({ keypairBytes: new Uint8Array(64) });
    await expect(
      wallet.sendSplToken('recipient', '1', SOLANA_TOKENS.USDC, { expectedDecimals: 9 }),
    ).rejects.toThrow(/does not match/);
  });

  it('refuses to sign when the RPC serves a different cluster', async () => {
    solana.genesis.mockResolvedValue('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
    const wallet = createSolanaWallet({ keypairBytes: new Uint8Array(64) });
    await expect(wallet.sendSplToken('recipient', '1', SOLANA_TOKENS.USDC)).rejects.toThrow(/genesis/);
    await expect(wallet.sendSol('recipient', '1')).rejects.toThrow(/genesis/);
    expect(solana.sent).toHaveLength(0);
  });

  it('accepts an explicitly configured devnet cluster', async () => {
    solana.genesis.mockResolvedValue('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
    const wallet = createSolanaWallet({ keypairBytes: new Uint8Array(64), cluster: 'devnet' });
    await expect(wallet.sendSol('recipient', '1')).resolves.toEqual({ signature: 'test-signature' });
  });
});

describe('formatSolanaUnits', () => {
  it('formats balances without converting through Number', () => {
    expect(formatSolanaUnits(1234567890123456789012345n, 6)).toBe(
      '1234567890123456789.012345'
    );
  });

  it('trims trailing fractional zeros', () => {
    expect(formatSolanaUnits(1500000n, 6)).toBe('1.5');
    expect(formatSolanaUnits(1000000n, 6)).toBe('1');
  });

  it('preserves small fractional balances', () => {
    expect(formatSolanaUnits(1n, 9)).toBe('0.000000001');
  });
});
