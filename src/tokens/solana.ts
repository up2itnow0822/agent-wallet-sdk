/**
 * @module tokens/solana
 * Solana SPL token support for AgentWallet v6.
 *
 * Uses @solana/web3.js as an optional peer dependency.
 * All imports are done dynamically so EVM-only users pay zero overhead.
 *
 * Token addresses verified against:
 *   - Solana SPL Token Registry: https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json
 *   - USDC on Solana: https://developers.circle.com/stablecoins/usdc-contract-addresses
 *   - Raydium: https://docs.raydium.io/raydium/token-pairs-and-liquidity
 */

import { parseExactAmount, assertTokenDecimals } from './decimals.js';

// ─── Well-known Solana token mint addresses ───────────────────────────────────
//
// All addresses are base-58 encoded Solana public keys.
// Sources: Solana token registry + Circle USDC docs

export const SOLANA_TOKENS = {
  // Native SOL (special: no mint address, use null or SystemProgram)
  SOL:  null as null, // native, not a mint

  // USDC on Solana mainnet — Circle official
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',

  // USDT on Solana — Tether official
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',

  // Raydium
  RAY:  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',

  // Serum (now Openbook predecessor token)
  SRM:  'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt',

  // Bonk memecoin
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',

  // JitoSOL — Jito staked SOL
  JITOSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',

  // mSOL — Marinade staked SOL
  MSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',

  // Wrapped BTC on Solana (Portal/Wormhole)
  WBTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',

  // Wrapped ETH on Solana (Portal/Wormhole)
  WETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
} as const;

export type SolanaTokenSymbol = keyof typeof SOLANA_TOKENS;

export interface SolanaTokenInfo {
  symbol: SolanaTokenSymbol;
  mint: string | null; // null for native SOL
  decimals: number;
  name: string;
}

/** Known decimals for Solana tokens */
export const SOLANA_TOKEN_DECIMALS: Record<SolanaTokenSymbol, number> = {
  SOL:     9,
  USDC:    6,
  USDT:    6,
  RAY:     6,
  SRM:     6,
  BONK:    5,
  JITOSOL: 9,
  MSOL:    9,
  WBTC:    8,
  WETH:    8,
};

/** Mainnet mint → pinned decimals. RPC mint data is compared against this, never trusted over it. */
const PINNED_MAINNET_MINT_DECIMALS: ReadonlyMap<string, number> = new Map(
  (Object.keys(SOLANA_TOKENS) as SolanaTokenSymbol[])
    .filter(symbol => SOLANA_TOKENS[symbol] !== null)
    .map(symbol => [SOLANA_TOKENS[symbol] as string, SOLANA_TOKEN_DECIMALS[symbol]] as const),
);

/** Genesis hashes that identify public Solana clusters. */
export const SOLANA_CLUSTER_GENESIS_HASHES = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
} as const;

export type SolanaCluster = keyof typeof SOLANA_CLUSTER_GENESIS_HASHES;

/** Minimal @solana/web3.js Connection surface used to sign and submit. */
interface SolanaSendConnection {
  getLatestBlockhash(commitment?: string): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getGenesisHash(): Promise<string>;
  sendRawTransaction(raw: unknown): Promise<string>;
  confirmTransaction(
    strategy: { signature: string; blockhash: string; lastValidBlockHeight: number },
    commitment?: string,
  ): Promise<{ value?: { err?: unknown } } | undefined>;
}

/** Minimal legacy Transaction surface used to sign and submit. */
interface SolanaSignableTransaction {
  recentBlockhash?: string;
  lastValidBlockHeight?: number;
  feePayer?: unknown;
  sign(...signers: unknown[]): void;
  serialize(): unknown;
}

/** Thrown before signing when a Solana transfer cannot be bound to a pinned scale or cluster. */
export class SolanaTransferSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SolanaTransferSafetyError';
  }
}

export interface SendSplTokenOptions {
  /**
   * Caller-pinned mint decimals. Required for string amounts of mints that are
   * not in SOLANA_TOKENS on mainnet-beta. Must match the mint account.
   */
  expectedDecimals?: number;
}

// ─── Dynamic import helper ────────────────────────────────────────────────────

// ─── Base58 decode (built-in, no extra dependency) ───────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function formatSolanaUnits(rawAmount: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = rawAmount / divisor;
  const fraction = rawAmount % divisor;

  if (decimals === 0 || fraction === 0n) {
    return whole.toString();
  }

  const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${fractionStr}`;
}

function base58Decode(str: string): Uint8Array {
  const bytes: number[] = [0];
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`base58Decode: invalid character "${char}"`);
    let carry = idx;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Add leading zeros for leading '1' chars
  for (const char of str) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSolanaWeb3(): Promise<any> {
  try {
    // @ts-ignore — @solana/web3.js is an optional peer dependency
    const mod = await import('@solana/web3.js');
    return mod;
  } catch {
    throw new Error(
      'SolanaWallet requires @solana/web3.js. Install it: npm install @solana/web3.js'
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSplToken(): Promise<any> {
  try {
    // @ts-expect-error — @solana/spl-token is an optional peer dependency
    const mod = await import('@solana/spl-token');
    return mod;
  } catch {
    throw new Error(
      'SolanaWallet SPL token operations require @solana/spl-token. Install it: npm install @solana/spl-token'
    );
  }
}

// ─── SolanaWallet class ───────────────────────────────────────────────────────

export interface SolanaWalletConfig {
  /** Solana RPC endpoint (default: mainnet) */
  rpcUrl?: string;
  /** Base-58 encoded private key for the signer */
  privateKeyBase58?: string;
  /** Keypair bytes (Uint8Array of 64 bytes) */
  keypairBytes?: Uint8Array;
  /**
   * Cluster the RPC must serve. Checked by genesis hash before every signed
   * transfer. Defaults to 'mainnet-beta'.
   */
  cluster?: SolanaCluster;
  /** Override for private/local clusters: the exact genesis hash the RPC must report. */
  expectedGenesisHash?: string;
}

export interface SolBalanceResult {
  rawBalance: bigint;  // lamports
  sol: string;         // human-readable SOL
}

export interface SplBalanceResult {
  mint: string;
  rawBalance: bigint;
  humanBalance: string;
  decimals: number;
}

export interface SolanaTxResult {
  signature: string;
}

/**
 * Solana wallet for native SOL and SPL token operations.
 * Uses @solana/web3.js (optional peer dependency, dynamically imported).
 */
export class SolanaWallet {
  private readonly rpcUrl: string;
  private readonly config: SolanaWalletConfig;

  // Lazily loaded modules and connection
  private _connection: any = null;
  private _keypair: any = null;

  constructor(config: SolanaWalletConfig = {}) {
    this.rpcUrl = config.rpcUrl ?? 'https://api.mainnet-beta.solana.com';
    this.config = config;
  }

  private async getConnection() {
    if (this._connection) return this._connection;
    const { Connection } = await loadSolanaWeb3();
    this._connection = new Connection(this.rpcUrl, 'confirmed');
    return this._connection;
  }

  /** The cluster this wallet is bound to. */
  get cluster(): SolanaCluster | 'custom' {
    return this.config.expectedGenesisHash ? 'custom' : (this.config.cluster ?? 'mainnet-beta');
  }

  private expectedGenesisHash(): string {
    if (this.config.expectedGenesisHash) return this.config.expectedGenesisHash;
    const cluster = this.config.cluster ?? 'mainnet-beta';
    const hash = SOLANA_CLUSTER_GENESIS_HASHES[cluster];
    if (!hash) throw new SolanaTransferSafetyError(`unknown Solana cluster "${String(cluster)}"`);
    return hash;
  }

  /**
   * Verify the RPC serves the configured cluster before EVERY signed transfer.
   * Never cached: the transaction signs over the blockhash this RPC returns,
   * so an endpoint that later serves another cluster must be caught each time.
   */
  private async assertCluster(connection: any): Promise<void> {
    const expected = this.expectedGenesisHash();
    let actual: unknown;
    try {
      actual = await connection.getGenesisHash();
    } catch (err) {
      throw new SolanaTransferSafetyError(`could not verify Solana cluster: ${(err as Error).message}`);
    }
    if (actual !== expected) {
      throw new SolanaTransferSafetyError(
        `Solana RPC genesis hash ${String(actual)} does not match the configured cluster (${expected})`,
      );
    }
  }

  private async getKeypair() {
    if (this._keypair) return this._keypair;
    const { Keypair } = await loadSolanaWeb3();

    if (this.config.keypairBytes) {
      this._keypair = Keypair.fromSecretKey(this.config.keypairBytes);
    } else if (this.config.privateKeyBase58) {
      // bs58 decode — use the solana web3 module's bundled bs58 or a custom decode
      const solWeb3 = await loadSolanaWeb3();
      let decoded: Uint8Array;
      if (solWeb3.bs58) {
        decoded = solWeb3.bs58.decode(this.config.privateKeyBase58);
      } else {
        // Fallback: manually decode base58 (no external dep needed)
        decoded = base58Decode(this.config.privateKeyBase58);
      }
      this._keypair = Keypair.fromSecretKey(decoded);
    } else {
      throw new Error('SolanaWallet: no private key provided. Set keypairBytes or privateKeyBase58 in config.');
    }

    return this._keypair;
  }

  /** Get signer's public key as base-58 string */
  async getPublicKey(): Promise<string> {
    const kp = await this.getKeypair();
    return kp.publicKey.toBase58();
  }

  /**
   * Get native SOL balance.
   * @param address - Optional base-58 public key to check (defaults to wallet's key)
   */
  async getSolBalance(address?: string): Promise<SolBalanceResult> {
    const { PublicKey } = await loadSolanaWeb3();
    const connection = await this.getConnection();

    let pubkey: any;
    if (address) {
      pubkey = new PublicKey(address);
    } else {
      const kp = await this.getKeypair();
      pubkey = kp.publicKey;
    }

    const lamports = await connection.getBalance(pubkey);
    const rawBalance = BigInt(lamports);
    const sol = (lamports / 1e9).toFixed(9).replace(/\.?0+$/, '');

    return { rawBalance, sol };
  }

  /**
   * Get SPL token balance for a given mint.
   * @param mintAddress - SPL token mint address (base-58)
   * @param owner - Optional owner address (defaults to wallet's key)
   */
  async getSplTokenBalance(
    mintAddress: string,
    owner?: string,
  ): Promise<SplBalanceResult> {
    const { PublicKey } = await loadSolanaWeb3();
    const splToken = await loadSplToken();
    const connection = await this.getConnection();

    let ownerPubkey: any;
    if (owner) {
      ownerPubkey = new PublicKey(owner);
    } else {
      const kp = await this.getKeypair();
      ownerPubkey = kp.publicKey;
    }

    const mintPubkey = new PublicKey(mintAddress);

    // Get associated token account
    const ata = await splToken.getAssociatedTokenAddress(mintPubkey, ownerPubkey);

    let rawBalance = 0n;
    let decimals = 9;

    try {
      const accountInfo = await splToken.getAccount(connection, ata);
      rawBalance = accountInfo.amount;

      // Get mint info for decimals
      const mintInfo = await splToken.getMint(connection, mintPubkey);
      decimals = mintInfo.decimals;
    } catch {
      // Token account doesn't exist — balance is 0
    }

    const humanBalance = formatSolanaUnits(rawBalance, decimals);

    return { mint: mintAddress, rawBalance, humanBalance, decimals };
  }

  /**
   * Send native SOL to a recipient.
   * @param to - Recipient base-58 public key
   * @param amount - Lamports (bigint) OR SOL amount as string (e.g. "1.5")
   */
  async sendSol(to: string, amount: string | bigint): Promise<SolanaTxResult> {
    let lamports: bigint;
    try {
      lamports = parseExactAmount(amount, 9);
    } catch (err) {
      throw new SolanaTransferSafetyError(`SolanaWallet: ${(err as Error).message}`);
    }

    const { PublicKey, SystemProgram, Transaction } = await loadSolanaWeb3();
    const connection = await this.getConnection();
    await this.assertCluster(connection);
    const keypair = await this.getKeypair();

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: new PublicKey(to),
        lamports,
      })
    );

    return { signature: await this.signAndSend(connection, transaction, keypair) };
  }

  /**
   * Send SPL tokens to a recipient.
   * Creates the recipient's associated token account if it doesn't exist.
   *
   * @param to - Recipient base-58 public key
   * @param amount - Raw token units (bigint) OR human-readable string
   * @param mintAddress - SPL token mint address (base-58)
   */
  async sendSplToken(
    to: string,
    amount: string | bigint,
    mintAddress: string,
    options: SendSplTokenOptions = {},
  ): Promise<SolanaTxResult> {
    // 1. Pin the token scale without consulting the RPC.
    const pinned = this.pinnedDecimals(mintAddress, options);

    // 2. Convert/validate the amount against the pinned scale before any network call.
    let rawAmount: bigint;
    try {
      if (typeof amount === 'bigint') {
        rawAmount = parseExactAmount(amount, pinned ?? 0);
      } else {
        if (pinned === undefined || pinned === null) {
          throw new Error(
            'string amounts for this mint require options.expectedDecimals ' +
              '(or pass raw base units as a bigint); RPC mint decimals never choose the scale',
          );
        }
        rawAmount = parseExactAmount(amount, pinned);
      }
    } catch (err) {
      throw new SolanaTransferSafetyError(`SolanaWallet: ${(err as Error).message}`);
    }

    const { PublicKey } = await loadSolanaWeb3();
    const splToken = await loadSplToken();
    const connection = await this.getConnection();
    await this.assertCluster(connection);
    const keypair = await this.getKeypair();

    const mintPubkey = new PublicKey(mintAddress);
    const toPubkey = new PublicKey(to);

    // 3. Compare the RPC's mint decimals with the pinned scale; mismatch fails closed.
    let mintDecimals: number;
    try {
      const mintInfo = await splToken.getMint(connection, mintPubkey);
      mintDecimals = assertTokenDecimals(mintInfo?.decimals, 'mint decimals');
    } catch (err) {
      throw new SolanaTransferSafetyError(`SolanaWallet: could not read mint: ${(err as Error).message}`);
    }
    if ((pinned !== undefined && pinned !== null) && mintDecimals !== pinned) {
      throw new SolanaTransferSafetyError(
        `SolanaWallet: mint reports ${mintDecimals} decimals but ${pinned} are pinned for this transfer`,
      );
    }
    const decimals = pinned ?? mintDecimals;

    // Get sender's associated token account
    const fromAta = await splToken.getAssociatedTokenAddress(
      mintPubkey,
      keypair.publicKey,
    );

    // Get or create recipient's associated token account
    const toAta = await splToken.getAssociatedTokenAddress(mintPubkey, toPubkey);

    // Build instructions
    const instructions: any[] = [];

    // Check if recipient ATA exists
    const toAtaInfo = await connection.getAccountInfo(toAta);
    if (!toAtaInfo) {
      instructions.push(
        splToken.createAssociatedTokenAccountInstruction(
          keypair.publicKey, // payer
          toAta,
          toPubkey,
          mintPubkey,
        )
      );
    }

    // TransferChecked makes the token program reject a decimals/mint mismatch on-chain.
    instructions.push(
      splToken.createTransferCheckedInstruction(
        fromAta,
        mintPubkey,
        toAta,
        keypair.publicKey,
        rawAmount,
        decimals,
      )
    );

    const { Transaction } = await loadSolanaWeb3();
    const transaction = new Transaction().add(...instructions);
    return { signature: await this.signAndSend(connection, transaction, keypair) };
  }

  /**
   * Bind the signed transfer to the configured cluster: fetch the recent
   * blockhash FIRST, then prove the cluster by genesis hash, then sign locally
   * with that blockhash and submit the raw bytes. A transaction signed over a
   * blockhash from the configured cluster cannot execute on any other cluster,
   * so an endpoint that switches clusters at any point cannot redirect it.
   */
  private async signAndSend(
    connection: SolanaSendConnection,
    transaction: SolanaSignableTransaction,
    keypair: { publicKey: unknown },
  ): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    if (typeof blockhash !== 'string' || blockhash.length === 0) {
      throw new SolanaTransferSafetyError('Solana RPC returned no recent blockhash');
    }
    await this.assertCluster(connection);
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
    transaction.feePayer = keypair.publicKey;
    transaction.sign(keypair);
    const signature: string = await connection.sendRawTransaction(transaction.serialize());
    const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (confirmation?.value?.err) {
      throw Object.assign(
        new Error(`Solana transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`),
        { signature },
      );
    }
    return signature;
  }

  private pinnedDecimals(mintAddress: string, options: SendSplTokenOptions): number | undefined {
    const expected =
      (options.expectedDecimals !== undefined && options.expectedDecimals !== null)
        ? assertTokenDecimals(options.expectedDecimals, 'expectedDecimals')
        : undefined;
    const known =
      this.cluster === 'mainnet-beta' ? PINNED_MAINNET_MINT_DECIMALS.get(mintAddress) : undefined;
    if ((known !== undefined && known !== null) && (expected !== undefined && expected !== null) && known !== expected) {
      throw new SolanaTransferSafetyError(
        `SolanaWallet: expectedDecimals ${expected} does not match pinned decimals ${known} for ${mintAddress}`,
      );
    }
    return known ?? expected;
  }

  /**
   * List all SPL token accounts for the wallet.
   */
  async listSplTokenAccounts(): Promise<Array<{ mint: string; amount: bigint; decimals: number }>> {
    const splToken = await loadSplToken();
    const connection = await this.getConnection();
    const keypair = await this.getKeypair();

    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      keypair.publicKey,
      { programId: splToken.TOKEN_PROGRAM_ID }
    );

    return tokenAccounts.value.map((acc: any) => {
      const info = acc.account.data.parsed.info;
      return {
        mint: info.mint,
        amount: BigInt(info.tokenAmount.amount),
        decimals: info.tokenAmount.decimals,
      };
    });
  }
}

/**
 * Create a SolanaWallet instance.
 */
export function createSolanaWallet(config: SolanaWalletConfig): SolanaWallet {
  return new SolanaWallet(config);
}
