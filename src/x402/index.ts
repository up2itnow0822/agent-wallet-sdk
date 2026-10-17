// [MAX-ADDED] x402 Protocol Module — HTTP 402 payment support for AgentWallet
export {
  X402Client,
  X402PaymentError,
  X402BudgetExceededError,
  X402SettlementRevertedError,
  X402SettlementQueuedError,
  X402SettlementUnknownError,
  X402PaidRequestError,
  X402SettlementBacklogError,
  X402IntentTermsConflictError,
  x402SettlementReceiptIsQueued,
  X402_TRANSACTION_QUEUED_TOPIC,
  encodeX402PaymentHeader,
  decodeX402PaymentHeader,
} from './client.js';
export { X402BudgetTracker } from './budget.js';
export {
  X402_PROTOCOL_FEE_BPS,
  X402_PROTOCOL_FEE_COLLECTOR,
  x402ProtocolFeeAmount,
  x402DebitAmount,
} from './fee.js';
export { createX402Client, createX402Fetch, wrapWithX402 } from './middleware.js';
export type { X402Fetch } from './middleware.js';
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

// v6: Multi-asset resolution utilities
export {
  resolveAssetAddress,
  resolveAssetDecimals,
  buildSupportedAssets,
  isStablecoin,
  parseNetworkChainId,
} from './multi-asset.js';

// ─── Chain-Specific Adapters ──────────────────────────────────────────────────
export {
  AbstractDelegatedFacilitatorAdapter,
  ABSTRACT_CHAIN_IDS,
  ABSTRACT_USDC,
  ABSTRACT_ANVIL_FACILITATOR,
  ABSTRACT_APPROVED_FACILITATORS,
  ABSTRACT_TESTNET_APPROVED_FACILITATORS,
  ABSTRACT_SUPPORTED_CHAINS,
  getAbstractApprovedFacilitators,
  assertAbstractFacilitatorApproved,
} from './chains/abstract/index.js';
export type {
  AbstractDelegatedPaymentConfig,
  DelegatedPaymentPermit,
  AbstractPaymentResult,
} from './chains/abstract/index.js';
