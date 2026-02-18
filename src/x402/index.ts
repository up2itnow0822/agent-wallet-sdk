// [MAX-ADDED] x402 Protocol Module — HTTP 402 payment support for AgentWallet
export { X402Client, X402PaymentError, X402BudgetExceededError } from './client.js';
export { X402BudgetTracker } from './budget.js';
export { createX402Client, createX402Fetch, wrapWithX402 } from './middleware.js';
export type {
  X402PaymentRequired,
  X402PaymentRequirements,
  X402PaymentPayload,
  X402SettlementResponse,
  X402ResourceInfo,
  X402ServiceBudget,
  X402TransactionLog,
  X402ClientConfig,
} from './types.js';
export { USDC_ADDRESSES, DEFAULT_SUPPORTED_NETWORKS } from './types.js';
