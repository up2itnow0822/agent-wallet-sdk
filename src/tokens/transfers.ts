/**
 * @module tokens/transfers
 * Multi-token transfer utilities for AgentWallet v6.
 *
 * Provides send/balance functions for any ERC-20 token or native gas token,
 * with flexible amount input (raw bigint or human-readable string).
 *
 * All transfer functions go through viem's wallet client — they do NOT
 * route through the AgentAccountV2 contract (use agentTransferToken for that).
 * These are direct EOA/smart-wallet operations for wallets that hold the key.
 */

import {
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
  zeroAddress,
} from 'viem';
import { getGlobalRegistry } from './registry.js';
import { parseExactAmount, assertTokenDecimals, toHuman, formatBalance } from './decimals.js';


// ─── ERC20 ABI (minimal) ─────────────────────────────────────────────────────

const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TransferOptions {
  /** Gas price override */
  gasPrice?: bigint;
  /** Max fee per gas (EIP-1559) */
  maxFeePerGas?: bigint;
  /** Max priority fee per gas (EIP-1559) */
  maxPriorityFeePerGas?: bigint;
  /** Gas limit override */
  gas?: bigint;
  /** Chain ID for multi-chain operations */
  chainId?: number;
  /**
   * Caller-pinned token decimals. Required when a human-readable string amount
   * is sent for a token that is not in the registry for the bound chain.
   * When the token IS in the registry this must match the registry value.
   * RPC-reported decimals are only ever compared against a pinned value;
   * they never choose the signed scale.
   */
  expectedDecimals?: number;
}

/** Thrown when a token transfer would sign with an unpinned or mismatched scale or chain. */
export class TokenTransferSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenTransferSafetyError';
  }
}

export interface TokenBalanceResult {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  rawBalance: bigint;
  humanBalance: string;
  formatted: string;
}

export interface NativeBalanceResult {
  symbol: string;
  decimals: number;
  rawBalance: bigint;
  humanBalance: string;
}

// ─── Transfer context ─────────────────────────────────────────────────────────

export interface TransferContext {
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** Caller's address (used as from address) */
  account: Address;
  /** Chain ID for registry lookups */
  chainId?: number;
}

// ─── Core transfer functions ──────────────────────────────────────────────────

/**
 * Send any ERC-20 token.
 *
 * @param ctx - Public + wallet clients and account
 * @param to - Recipient address
 * @param amount - Amount as raw bigint OR human-readable string (requires tokenAddress decimals lookup)
 * @param tokenAddress - ERC-20 contract address
 * @param options - Optional gas overrides
 */
export async function sendToken(
  ctx: TransferContext,
  to: Address,
  amount: string | bigint,
  tokenAddress: Address,
  options: TransferOptions = {},
): Promise<Hash> {
  const chainId = resolveBoundChainId(ctx, options);
  let rawAmount: bigint;

  if (typeof amount === 'string') {
    const decimals = await resolvePinnedDecimals(ctx, tokenAddress, chainId, options);
    try {
      rawAmount = parseExactAmount(amount, decimals);
    } catch (err) {
      throw new TokenTransferSafetyError((err as Error).message);
    }
  } else {
    if (typeof amount !== 'bigint' || amount <= 0n) {
      throw new TokenTransferSafetyError('raw token amount must be a positive bigint');
    }
    rawAmount = amount;
  }

  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [to, rawAmount],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (ctx.walletClient as any).sendTransaction({
    account: ctx.account,
    to: tokenAddress,
    data,
    ...(ctx.walletClient.chain ? { chain: ctx.walletClient.chain } : {}),
    ...buildGasOptions(options),
  });
}

/**
 * Resolve the single chain a transfer is bound to and require that the signer,
 * the read client and the caller all agree on it. Never inferred from RPC data.
 */
function resolveBoundChainId(ctx: TransferContext, options: TransferOptions): number {
  const candidates: Array<[string, number | undefined]> = [
    ['ctx.chainId', ctx.chainId],
    ['options.chainId', options.chainId],
    ['walletClient.chain.id', ctx.walletClient?.chain?.id],
    ['publicClient.chain.id', ctx.publicClient?.chain?.id],
  ];
  let bound: number | undefined;
  for (const [label, id] of candidates) {
    if (id === undefined || id === null) continue;
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new TokenTransferSafetyError(`${label} is not a valid chain id`);
    }
    if (bound === undefined) bound = id;
    else if (bound !== id) {
      throw new TokenTransferSafetyError(
        `chain mismatch: ${label}=${id} differs from bound chain ${bound}`,
      );
    }
  }
  // The signer itself must be bound to that chain, so viem asserts the
  // wallet's current chain before signing (never "whatever the RPC reports").
  const signerChain = ctx.walletClient?.chain?.id;
  if (signerChain === undefined || signerChain === null) {
    throw new TokenTransferSafetyError('walletClient must be bound to a chain (createWalletClient({ chain }))');
  }
  return bound as number;
}

/**
 * Choose the token scale for a human-readable amount from pinned sources only
 * (the registry for the bound chain, or the caller's expectedDecimals). Any RPC
 * decimals response is compared against the pinned scale and must match.
 */
async function resolvePinnedDecimals(
  ctx: TransferContext,
  tokenAddress: Address,
  chainId: number | undefined,
  options: TransferOptions,
): Promise<number> {
  const registryEntry =
    (chainId !== undefined && chainId !== null) ? getGlobalRegistry().getTokenByAddress(tokenAddress, chainId) : undefined;
  const expected =
    (options.expectedDecimals !== undefined && options.expectedDecimals !== null)
      ? assertTokenDecimals(options.expectedDecimals, 'expectedDecimals')
      : undefined;

  if (registryEntry) {
    const registryDecimals = assertTokenDecimals(registryEntry.decimals, 'registry decimals');
    if ((expected !== undefined && expected !== null) && expected !== registryDecimals) {
      throw new TokenTransferSafetyError(
        `expectedDecimals ${expected} does not match registry decimals ${registryDecimals}`,
      );
    }
    return registryDecimals;
  }

  if (expected === undefined || expected === null) {
    throw new TokenTransferSafetyError(
      'string amounts for tokens outside the registry require options.expectedDecimals ' +
        '(or pass a raw bigint amount); RPC-reported decimals are never trusted to choose the scale',
    );
  }

  let reported: number;
  try {
    reported = assertTokenDecimals(await fetchTokenDecimals(ctx.publicClient, tokenAddress), 'RPC decimals');
  } catch (err) {
    throw new TokenTransferSafetyError(`could not verify token decimals: ${(err as Error).message}`);
  }
  if (reported !== expected) {
    throw new TokenTransferSafetyError(
      `RPC-reported decimals ${reported} do not match expectedDecimals ${expected}`,
    );
  }
  return expected;
}

/**
 * Send native gas token (ETH, MATIC, AVAX, etc.).
 *
 * @param ctx - Transfer context
 * @param to - Recipient address
 * @param amount - Raw bigint OR human-readable string (18 decimals for ETH/MATIC/AVAX)
 * @param options - Optional gas overrides
 */
export async function sendNative(
  ctx: TransferContext,
  to: Address,
  amount: string | bigint,
  options: TransferOptions = {},
): Promise<Hash> {
  resolveBoundChainId(ctx, options);
  let rawAmount: bigint;
  try {
    rawAmount = parseExactAmount(amount, 18);
  } catch (err) {
    throw new TokenTransferSafetyError((err as Error).message);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (ctx.walletClient as any).sendTransaction({
    account: ctx.account,
    to,
    value: rawAmount,
    ...(ctx.walletClient.chain ? { chain: ctx.walletClient.chain } : {}),
    ...buildGasOptions(options),
  });
}

/**
 * Get the ERC-20 balance of the current account (or a specified address).
 *
 * @param ctx - Transfer context
 * @param tokenAddress - ERC-20 contract address
 * @param holder - Address to check (defaults to ctx.account)
 */
export async function getTokenBalance(
  ctx: TransferContext,
  tokenAddress: Address,
  holder?: Address,
): Promise<TokenBalanceResult> {
  const target = holder ?? ctx.account;

  // Batch read: balanceOf + decimals + symbol + name
  const [rawBalance, decimals, symbol, name] = await Promise.all([
    ctx.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [target],
    }) as Promise<bigint>,
    ctx.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'decimals',
    }) as Promise<number>,
    ctx.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'symbol',
    }) as Promise<string>,
    ctx.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'name',
    }) as Promise<string>,
  ]);

  const humanBalance = toHuman(rawBalance, decimals);
  const formatted = formatBalance(rawBalance, { symbol, decimals });

  return { address: tokenAddress, symbol, name, decimals, rawBalance, humanBalance, formatted };
}

/**
 * Get the native gas token balance of the current account (or a specified address).
 *
 * @param ctx - Transfer context
 * @param holder - Address to check (defaults to ctx.account)
 */
export async function getNativeBalance(
  ctx: TransferContext,
  holder?: Address,
): Promise<NativeBalanceResult> {
  const target = holder ?? ctx.account;
  const rawBalance = await ctx.publicClient.getBalance({ address: target });

  // Determine native token symbol from registry if chainId is known
  let symbol = 'ETH';
  if (ctx.chainId !== undefined && ctx.chainId !== null) {
    const native = getGlobalRegistry().getTokenByAddress(zeroAddress, ctx.chainId);
    symbol = native?.symbol ?? 'ETH';
  }

  const humanBalance = toHuman(rawBalance, 18);

  return { symbol, decimals: 18, rawBalance, humanBalance };
}

/**
 * Batch query balances for multiple ERC-20 tokens.
 *
 * @param ctx - Transfer context
 * @param tokenAddresses - List of ERC-20 addresses to query (or null/empty for all registry tokens)
 * @param holder - Address to check (defaults to ctx.account)
 */
export async function getBalances(
  ctx: TransferContext,
  tokenAddresses?: Address[],
  holder?: Address,
): Promise<TokenBalanceResult[]> {
  const target = holder ?? ctx.account;

  let addresses = tokenAddresses;

  // If no addresses provided and chainId is known, use all registry tokens
  if (!addresses || addresses.length === 0) {
    if (ctx.chainId !== undefined && ctx.chainId !== null) {
      const tokens = getGlobalRegistry().listTokens(ctx.chainId);
      addresses = tokens
        .filter(t => !t.isNative)
        .map(t => t.address);
    } else {
      return [];
    }
  }

  // Parallel balance fetches
  const results = await Promise.allSettled(
    addresses.map(addr => getTokenBalance(ctx, addr, target))
  );

  return results
    .filter((r): r is PromiseFulfilledResult<TokenBalanceResult> => r.status === 'fulfilled')
    .map(r => r.value);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchTokenDecimals(
  publicClient: PublicClient,
  tokenAddress: Address,
): Promise<number> {
  return publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'decimals',
  }) as Promise<number>;
}

function buildGasOptions(options: TransferOptions) {
  const gas: Record<string, bigint> = {};
  if (options.gas !== undefined && options.gas !== null)                gas.gas = options.gas;
  if (options.gasPrice !== undefined && options.gasPrice !== null)           gas.gasPrice = options.gasPrice;
  if (options.maxFeePerGas !== undefined && options.maxFeePerGas !== null)       gas.maxFeePerGas = options.maxFeePerGas;
  if (options.maxPriorityFeePerGas !== undefined && options.maxPriorityFeePerGas !== null) gas.maxPriorityFeePerGas = options.maxPriorityFeePerGas;
  return gas;
}

/**
 * Encode an ERC-20 transfer call as raw calldata.
 * Useful for building calldata for agentExecute() or multicall.
 */
export function encodeERC20Transfer(to: Address, amount: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [to, amount],
  });
}
