import { describe, expect, it } from 'vitest';
import { normalizeCircleAgentPaymentReceipt } from './providerReceipts.js';

describe('normalizeCircleAgentPaymentReceipt', () => {
  it('maps Circle Agent Wallet / USDC nanopayment fields into portable audit fields', () => {
    const receipt = normalizeCircleAgentPaymentReceipt({
      walletId: 'circle-wallet-123',
      agentId: 'agent-researcher-7',
      resource: 'mcp://pricing-feed/quote',
      maxAmount: '0.25',
      proof: 'circle-gateway-proof-abc',
      receiptId: 'circle-receipt-789',
      traceId: 'trace-456',
      expiresAt: '2026-05-13T08:00:00Z',
    });

    expect(receipt).toEqual({
      mandate_id: 'circle-wallet-123',
      payment_mode: 'machine_micropayment',
      wallet_provider: 'Circle Agent Wallet',
      agent_id: 'agent-researcher-7',
      resource: 'mcp://pricing-feed/quote',
      currency: 'USDC',
      max_amount: '0.25',
      expires_at: '2026-05-13T08:00:00Z',
      raw_credential_access: false,
      proof: 'circle-gateway-proof-abc',
      receipt_id: 'circle-receipt-789',
      trace_id: 'trace-456',
    });
  });

  it('rejects missing proof fields instead of fabricating receipts', () => {
    expect(() => normalizeCircleAgentPaymentReceipt({
      walletId: 'circle-wallet-123',
      agentId: 'agent-researcher-7',
      resource: 'mcp://pricing-feed/quote',
      maxAmount: 1,
      proof: '',
      receiptId: 'circle-receipt-789',
      traceId: 'trace-456',
    })).toThrow('Missing required Circle receipt field: proof');
  });
});
