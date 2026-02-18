// [MAX-ADDED] x402 protocol types — compatible with @x402/core spec
import type { Address, Hash } from 'viem';

// ─── x402 Protocol Types (from coinbase/x402 spec) ───

/** Resource information included in x402 responses */
export interface X402ResourceInfo {
  url: string;
  description: string;
  mimeType: string;
}

/** Payment requirements returned in 402 response PAYMENT-REQUIRED header */
export interface X402PaymentRequirements {
  scheme: string;           // e.g. "exact"
  network: string;          // e.g. "base:8453"
  asset: string;            // token contract address (e.g. USDC on Base)
  amount: string;           // amount in smallest unit (e.g. "1000000" = 1 USDC)
  payTo: string;            // recipient address
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

/** Full 402 response payload (base64-decoded from PAYMENT-REQUIRED header) */
export interface X402PaymentRequired {
  x402Version: number;
  error?: string;
  resource: X402ResourceInfo;
  accepts: X402PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

/** Payment payload sent back with PAYMENT-SIGNATURE header */
export interface X402PaymentPayload {
  x402Version: number;
  resource: X402ResourceInfo;
  accepted: X402PaymentRequirements;
  payload: Record<string, unknown>;  // scheme-specific (e.g. tx hash, signature)
  extensions?: Record<string, unknown>;
}

/** Settlement response returned in PAYMENT-RESPONSE header */
export interface X402SettlementResponse {
  success: boolean;
  txHash?: string;
  network?: string;
  error?: string;
}

// ─── AgentWallet x402 Client Types ───

/** Per-service spending cap configuration */
export interface X402ServiceBudget {
  /** Domain or URL pattern (e.g. "api.example.com" or "*") */
  service: string;
  /** Max spend per single request in token base units */
  maxPerRequest: bigint;
  /** Max total spend per day in token base units */
  dailyLimit: bigint;
}

/** Transaction log entry for x402 payments */
export interface X402TransactionLog {
  timestamp: number;
  service: string;
  url: string;
  amount: bigint;
  token: Address;
  recipient: Address;
  txHash: Hash;
  network: string;
  scheme: string;
  success: boolean;
  error?: string;
}

/** Configuration for the x402 client */
export interface X402ClientConfig {
  /** Service-level budget controls */
  serviceBudgets?: X402ServiceBudget[];
  /** Global daily spending limit (token base units, default: unlimited) */
  globalDailyLimit?: bigint;
  /** Global per-request max (token base units, default: unlimited) */
  globalPerRequestMax?: bigint;
  /** Supported networks (default: ["base:8453"]) */
  supportedNetworks?: string[];
  /** Supported assets by network (default: USDC on Base) */
  supportedAssets?: Record<string, Address[]>;
  /** Max retries after payment (default: 1) */
  maxRetries?: number;
  /** Custom facilitator URL (optional, for verify/settle) */
  facilitatorUrl?: string;
  /** Whether to auto-pay 402 responses (default: true) */
  autoPay?: boolean;
  /** Callback before payment — return false to reject */
  onBeforePayment?: (req: X402PaymentRequirements, url: string) => Promise<boolean> | boolean;
  /** Callback after payment */
  onPaymentComplete?: (log: X402TransactionLog) => void;
}

// ─── Well-known Assets ───

/** USDC contract addresses by network */
export const USDC_ADDRESSES: Record<string, Address> = {
  'base:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
} as const;

/** Default supported networks */
export const DEFAULT_SUPPORTED_NETWORKS = ['base:8453'] as const;
