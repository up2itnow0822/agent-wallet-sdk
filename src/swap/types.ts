import type { Address, Hash } from 'viem';

/** Uniswap V3 fee tier options */
export type UniswapFeeTier = 100 | 500 | 3000 | 10000;

export interface SwapQuote {
  tokenIn: Address;
  tokenOut: Address;
  amountInRaw: bigint;
  amountInNet: bigint;
  feeAmount: bigint;
  amountOut: bigint;
  amountOutMinimum: bigint;
  poolFeeTier: UniswapFeeTier;
  effectiveRate: number;
  gasEstimate: bigint;
}

export interface SwapOptions {
  slippageBps?: number;
  feeTiers?: UniswapFeeTier[];
  deadlineSecs?: number;
  feeWallet?: Address;
}

export interface SwapResult {
  txHash: Hash;
  feeTxHash?: Hash;
  quote: SwapQuote;
  approvalRequired: boolean;
  approvalTxHash?: Hash;
}

export interface SwapModuleConfig {
  routerAddress: Address;
  quoterAddress: Address;
  feeBps: number;
  feeWallet: Address;
}

/** Well-known Base Mainnet token addresses */
export const BASE_TOKENS = {
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const,
  WETH: '0x4200000000000000000000000000000000000006' as const,
  cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22' as const,
  WNATIVE: '0x4200000000000000000000000000000000000006' as const,
};

/** Uniswap V3 contract addresses on Base Mainnet (chain 8453) */
export const UNISWAP_V3_BASE = {
  ROUTER: '0x2626664c2603336E57B271c5C0b26F421741e481' as const,
  QUOTER_V2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a' as const,
};

/** Protocol fee in bps — 0.875% */
export const PROTOCOL_FEE_BPS = 875;
/** Default slippage in bps — 0.5% */
export const DEFAULT_SLIPPAGE_BPS = 50;
