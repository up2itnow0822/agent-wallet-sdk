/**
 * @module swap/SwapModule
 * SwapModule — multi-chain Uniswap V3 token quotes and fee-free EOA swaps.
 *
 * Supports Base, Arbitrum, Optimism, and Polygon. Automatically selects the best
 * Uniswap V3 fee tier (0.01%, 0.05%, 0.3%, 1%) by quoting all tiers and choosing
 * the highest output. Execution requires feeBps: 0 until a reviewed atomic fee
 * route exists, and the signer must own accountAddress directly.
 *
 * For execution use `attachSwap(eoaWallet, { chain: 'arbitrum', feeBps: 0 })`.
 */
import {
  encodeFunctionData,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { UniswapV3RouterAbi, UniswapV3QuoterV2Abi, ERC20Abi } from './abi.js';
import {
  type SwapQuote,
  type SwapOptions,
  type SwapResult,
  type SwapModuleConfig,
  type SwapChain,
  type UniswapFeeTier,
  PROTOCOL_FEE_BPS,
  PROTOCOL_FEE_COLLECTOR,
  DEFAULT_SLIPPAGE_BPS,
  UNISWAP_V3_ADDRESSES,
} from './types.js';

const FEE_TIERS: UniswapFeeTier[] = [100, 500, 3000, 10000];
const MAX_UINT256 = (1n << 256n) - 1n;

function validateAmount(amount: bigint, name: string, allowZero = false): void {
  if (typeof amount !== 'bigint' || amount < (allowZero ? 0n : 1n) || amount > MAX_UINT256) {
    throw new Error(`SwapModule: ${name} must be ${allowZero ? 'a non-negative' : 'a positive'} uint256 amount`);
  }
}

function validateSlippage(slippageBps: number): void {
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10000) {
    throw new Error('SwapModule: slippageBps must be an integer between 0 and 9999');
  }
}

/** Calculate protocol fee: floor(amount * feeBps / 100_000) */
export function calcProtocolFee(amount: bigint, feeBps: number): bigint {
  validateAmount(amount, 'amount', true);
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > 100000) {
    throw new Error('SwapModule: feeBps must be an integer between 0 and 100000');
  }
  return (amount * BigInt(feeBps)) / 100000n;
}

/** Apply slippage: floor(amount * (10_000 - slippageBps) / 10_000) */
export function applySlippage(amount: bigint, slippageBps: number): bigint {
  validateAmount(amount, 'amount', true);
  validateSlippage(slippageBps);
  return (amount * BigInt(10000 - slippageBps)) / 10000n;
}

/** Encode local Unix time + deadlineSecs; the router checks this expiry on-chain. */
export function calcDeadline(deadlineSecs: number): bigint {
  const deadline = Math.floor(Date.now() / 1000) + deadlineSecs;
  if (!Number.isSafeInteger(deadlineSecs) || deadlineSecs <= 0 || !Number.isSafeInteger(deadline)) {
    throw new Error('SwapModule: deadlineSecs must be a positive integer with a safe Unix deadline');
  }
  return BigInt(deadline);
}

export class SwapModule {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly accountAddress: Address;
  private readonly config: SwapModuleConfig;

  constructor(
    publicClient: PublicClient,
    walletClient: WalletClient,
    accountAddress: Address,
    config?: Partial<SwapModuleConfig> & { chain?: SwapChain },
  ) {
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.accountAddress = accountAddress;
    const chain: SwapChain = config?.chain ?? 'base';
    const chainAddresses = UNISWAP_V3_ADDRESSES[chain];
    this.config = {
      routerAddress: chainAddresses.ROUTER,
      quoterAddress: chainAddresses.QUOTER_V2,
      feeBps: PROTOCOL_FEE_BPS,
      feeWallet: PROTOCOL_FEE_COLLECTOR,
      chain,
      ...config,
      // Re-apply chain-derived addresses if chain was specified but addresses were not
      ...(config?.routerAddress ? {} : { routerAddress: chainAddresses.ROUTER }),
      ...(config?.quoterAddress ? {} : { quoterAddress: chainAddresses.QUOTER_V2 }),
    };
  }

  async getQuote(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    options: Pick<SwapOptions, 'slippageBps' | 'feeTiers'> = {},
  ): Promise<SwapQuote> {
    validateAmount(amountIn, 'amountIn');
    const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    validateSlippage(slippageBps);
    const tiersToTry = options.feeTiers ?? FEE_TIERS;
    const feeAmount = calcProtocolFee(amountIn, this.config.feeBps);
    const amountInNet = amountIn - feeAmount;
    if (amountInNet <= 0n) {
      throw new Error(`SwapModule: amountIn (${amountIn}) is too small — fee (${feeAmount}) exceeds input`);
    }

    let bestQuote: { amountOut: bigint; gasEstimate: bigint; feeTier: UniswapFeeTier } | null = null;
    for (const fee of tiersToTry) {
      try {
        const result = await this.publicClient.readContract({
          address: this.config.quoterAddress,
          abi: UniswapV3QuoterV2Abi,
          functionName: 'quoteExactInputSingle',
          args: [{ tokenIn, tokenOut, amount: amountInNet, fee, sqrtPriceLimitX96: 0n }],
        });
        const [amountOut, , , gasEstimate] = result as [bigint, bigint, number, bigint];
        if (!bestQuote || amountOut > bestQuote.amountOut) {
          bestQuote = { amountOut, gasEstimate, feeTier: fee as UniswapFeeTier };
        }
      } catch {
        // Pool doesn't exist for this fee tier
      }
    }

    if (!bestQuote) {
      throw new Error(`SwapModule: No Uniswap V3 pool found for ${tokenIn} → ${tokenOut} on ${this.config.chain}.`);
    }

    const amountOutMinimum = applySlippage(bestQuote.amountOut, slippageBps);
    if (amountOutMinimum <= 0n) {
      throw new Error('SwapModule: minimum output must be positive; increase input or reduce slippage');
    }
    const effectiveRate = Number(bestQuote.amountOut) / Number(amountInNet);

    return {
      tokenIn, tokenOut, amountInRaw: amountIn, amountInNet, feeAmount,
      amountOut: bestQuote.amountOut, amountOutMinimum,
      poolFeeTier: bestQuote.feeTier, effectiveRate, gasEstimate: bestQuote.gasEstimate,
    };
  }

  async ensureApproval(token: Address, spender: Address, amount: bigint): Promise<Hash | undefined> {
    validateAmount(amount, 'approval amount');
    const account = this.executionAccount();
    const currentAllowance = (await this.publicClient.readContract({
      address: token, abi: ERC20Abi, functionName: 'allowance',
      args: [this.accountAddress, spender],
    })) as bigint;

    if (currentAllowance >= amount) return undefined;

    const approveData = encodeFunctionData({
      abi: ERC20Abi, functionName: 'approve', args: [spender, amount],
    });

    const hash = await this.walletClient.sendTransaction({
      account, to: token, data: approveData, chain: this.walletClient.chain ?? null,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error('SwapModule: approval reverted or was not confirmed successful');
    }
    const confirmedAllowance = (await this.publicClient.readContract({
      address: token, abi: ERC20Abi, functionName: 'allowance',
      args: [this.accountAddress, spender],
    })) as bigint;
    if (confirmedAllowance < amount) {
      throw new Error('SwapModule: confirmed allowance does not cover the swap input');
    }
    return hash;
  }

  private executionAccount() {
    const account = this.walletClient.account;
    if (!account) throw new Error('SwapModule: walletClient has no account');
    if (account.address.toLowerCase() !== this.accountAddress.toLowerCase()) {
      throw new Error('SwapModule: only direct EOA execution is supported; accountAddress must equal the signer address. AgentAccount/TBA execution requires a reviewed account route.');
    }
    return account;
  }

  async swap(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    options: SwapOptions = {},
  ): Promise<SwapResult> {
    validateAmount(amountIn, 'amountIn');
    const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    validateSlippage(slippageBps);
    const deadlineSecs = options.deadlineSecs ?? 300;
    calcDeadline(deadlineSecs); // Validate before an approval can be signed.
    if (this.config.feeBps !== 0) {
      throw new Error('SwapModule: fee-bearing swaps are disabled until a reviewed atomic fee route exists. Configure feeBps: 0 for fee-free EOA execution.');
    }
    const account = this.executionAccount();

    const quote = await this.getQuote(tokenIn, tokenOut, amountIn, { slippageBps, feeTiers: options.feeTiers });

    if (quote.gasEstimate > 2000000n) {
      console.warn(`SwapModule: High gas estimate (${quote.gasEstimate}). Pool may be illiquid.`);
    }

    const approvalTxHash = await this.ensureApproval(tokenIn, this.config.routerAddress, amountIn);
    const approvalRequired = approvalTxHash !== undefined;

    const exactInputData = encodeFunctionData({
      abi: UniswapV3RouterAbi,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn, tokenOut, fee: quote.poolFeeTier, recipient: this.accountAddress,
        amountIn: quote.amountInNet, amountOutMinimum: quote.amountOutMinimum, sqrtPriceLimitX96: 0n,
      }],
    });
    // SwapRouter02 exactInputSingle has no deadline field. Its deadline overload
    // of multicall enforces expiry before delegating to the inner swap.
    const swapData = encodeFunctionData({
      abi: UniswapV3RouterAbi,
      functionName: 'multicall',
      args: [calcDeadline(deadlineSecs), [exactInputData]],
    });

    const txHash = await this.walletClient.sendTransaction({
      account, to: this.config.routerAddress, data: swapData, chain: this.walletClient.chain ?? null,
    });

    return { txHash, quote, approvalRequired, approvalTxHash };
  }

  getConfig(): SwapModuleConfig {
    return { ...this.config };
  }

  setFeeWallet(address: Address): void {
    this.config.feeWallet = address;
  }
}

export function attachSwap(
  wallet: { address: Address; publicClient: PublicClient; walletClient: WalletClient },
  config?: Partial<SwapModuleConfig> & { chain?: SwapChain },
) {
  const swapModule = new SwapModule(wallet.publicClient, wallet.walletClient, wallet.address, config);
  return {
    ...wallet,
    swapModule,
    swap: swapModule.swap.bind(swapModule),
    getQuote: swapModule.getQuote.bind(swapModule),
  };
}
