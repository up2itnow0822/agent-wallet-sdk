export type AgentPaymentMode = 'delegated_checkout' | 'machine_micropayment';

export interface PortableAgentPaymentReceipt {
  mandate_id: string;
  payment_mode: AgentPaymentMode;
  wallet_provider: string;
  agent_id: string;
  resource: string;
  currency: string;
  max_amount: string;
  expires_at?: string;
  raw_credential_access: false;
  proof: string;
  receipt_id: string;
  trace_id: string;
}

export interface CircleAgentPaymentInput {
  walletId: string;
  agentId: string;
  resource: string;
  maxAmount: string | number | bigint;
  proof: string;
  receiptId: string;
  traceId: string;
  expiresAt?: string;
  currency?: 'USDC' | string;
}

function requireNonEmpty(value: string | undefined, field: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required Circle receipt field: ${field}`);
  }
  return value;
}

/**
 * Normalize a Circle Agent Wallet / USDC nanopayment receipt into the
 * provider-neutral mandate and audit fields used by agentwallet logs.
 */
export function normalizeCircleAgentPaymentReceipt(
  input: CircleAgentPaymentInput
): PortableAgentPaymentReceipt {
  return {
    mandate_id: requireNonEmpty(input.walletId, 'walletId'),
    payment_mode: 'machine_micropayment',
    wallet_provider: 'Circle Agent Wallet',
    agent_id: requireNonEmpty(input.agentId, 'agentId'),
    resource: requireNonEmpty(input.resource, 'resource'),
    currency: input.currency ?? 'USDC',
    max_amount: input.maxAmount.toString(),
    expires_at: input.expiresAt,
    raw_credential_access: false,
    proof: requireNonEmpty(input.proof, 'proof'),
    receipt_id: requireNonEmpty(input.receiptId, 'receiptId'),
    trace_id: requireNonEmpty(input.traceId, 'traceId'),
  };
}
