import type { Address, Hash, Hex } from 'viem';

/** Supported bridge destination chains */
export type BridgeChain = 'ethereum' | 'optimism' | 'base' | 'arbitrum';

/** CCTP V2 domain IDs (Circle's internal chain identifiers) */
export const CCTP_DOMAIN_IDS: Record<BridgeChain, number> = {
  ethereum: 0,
  optimism: 2,
  arbitrum: 3,
  base: 6,
};

/** EVM chain IDs for supported bridge chains */
export const BRIDGE_CHAIN_IDS: Record<BridgeChain, number> = {
  ethereum: 1,
  optimism: 10,
  arbitrum: 42161,
  base: 8453,
};

/** USDC contract addresses per chain */
export const USDC_CONTRACT: Record<BridgeChain, Address> = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
};

/**
 * CCTP V2 TokenMessengerV2 addresses (source chain — where burn happens).
 */
export const TOKEN_MESSENGER_V2: Record<BridgeChain, Address> = {
  base: '0x8FD3bCdFd9987D7F3C86b67D2f25Dd4e82C80b2B',
  ethereum: '0xbd3fa81b58ba92a82136038b25adec7066af3155',
  optimism: '0x28Bc09B4EFdA1E348a97cA91F16CC43adFF2f50d',
  arbitrum: '0x19330d10D9Cc8751218eaf51E8885D058642E08A',
};

/** CCTP V2 MessageTransmitterV2 addresses (destination chain — where mint happens) */
export const MESSAGE_TRANSMITTER_V2: Record<BridgeChain, Address> = {
  base: '0xE737e5cEBEEBa77EFE7EcB0cd46C6b9c1Ce1e8b3',
  ethereum: '0xE737e5cEBEEBa77EFE7EcB0cd46C6b9c1Ce1e8b3',
  optimism: '0xE737e5cEBEEBa77EFE7EcB0cd46C6b9c1Ce1e8b3',
  arbitrum: '0xE737e5cEBEEBa77EFE7EcB0cd46C6b9c1Ce1e8b3',
};

/**
 * CCTP V2 minFinalityThreshold values.
 * - FAST (0): ~12 seconds. Circle fast attestation.
 * - FINALIZED (1000): Full on-chain finality.
 */
export const FINALITY_THRESHOLD = {
  FAST: 0,
  FINALIZED: 1000,
} as const;

/** Circle IRIS attestation API base URL */
export const CIRCLE_ATTESTATION_API = 'https://iris-api.circle.com';
/** Max attestation polling attempts before timeout */
export const MAX_ATTESTATION_POLLS = 60;
/** Polling interval for attestation (milliseconds) */
export const ATTESTATION_POLL_INTERVAL_MS = 5000;

/** Options for a bridge operation */
export interface BridgeOptions {
  minFinalityThreshold?: number;
  maxFee?: bigint;
  destinationAddress?: Address;
  destinationRpcUrl?: string;
  attestationApiUrl?: string;
}

/** Result of a bridge.burn() operation */
export interface BurnResult {
  burnTxHash: Hash;
  nonce: bigint;
  messageHash: Hex;
  messageBytes: Hex;
  sourceDomain: number;
  destinationDomain: number;
}

/** Circle attestation status */
export type AttestationStatus = 'pending_confirmations' | 'complete' | 'error';

/** Circle IRIS API response for an attestation */
export interface AttestationResponse {
  status: AttestationStatus;
  attestation: Hex | null;
  error?: string;
}

/** Result of the full bridge() operation */
export interface BridgeResult {
  burnTxHash: Hash;
  mintTxHash: Hash;
  amount: bigint;
  fromChain: BridgeChain;
  toChain: BridgeChain;
  recipient: Address;
  nonce: bigint;
  elapsedMs: number;
}

/** Error codes for actionable bridge error messages */
export type BridgeErrorCode =
  | 'UNSUPPORTED_CHAIN'
  | 'INSUFFICIENT_ALLOWANCE'
  | 'INSUFFICIENT_BALANCE'
  | 'BURN_FAILED'
  | 'ATTESTATION_TIMEOUT'
  | 'ATTESTATION_ERROR'
  | 'MINT_FAILED'
  | 'INVALID_AMOUNT'
  | 'NO_WALLET_CLIENT';
