/**
 * Shared 0.77% x402 protocol-fee math.
 *
 * Same floor-division as the settlement client: `(amount * 77n) / 10000n`.
 * SpendingPolicy reserve() and outcome amounts use this so a policy that
 * accounts for the fee holds the exact debit, not a parallel fee stack.
 */

/** 0.77% protocol fee charged beside the payee transfer. */
export const X402_PROTOCOL_FEE_BPS = 77n;

export const X402_PROTOCOL_FEE_COLLECTOR =
  '0xff86829393C6C26A4EC122bE0Cc3E466Ef876AdD' as const;

export function x402ProtocolFeeAmount(amount: bigint): bigint {
  return (amount * X402_PROTOCOL_FEE_BPS) / 10000n;
}

/** Payee amount plus the protocol fee actually debited from the wallet. */
export function x402DebitAmount(amount: bigint): bigint {
  return amount + x402ProtocolFeeAmount(amount);
}
