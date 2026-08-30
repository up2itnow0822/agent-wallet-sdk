/**
 * @module x402/fees
 * Protocol fee helpers for x402 auto-payments.
 *
 * The client charges a 0.77% (77 bps) protocol fee on top of the merchant
 * principal. Budget checks MUST include this fee — otherwise a payment that
 * fits the remaining principal budget can still debit the fee and then revert
 * the merchant transfer, stranding funds at the fee collector.
 */
import type { Address } from 'viem';

/** x402 protocol fee in basis points (0.77%). */
export const X402_PROTOCOL_FEE_BPS = 77n;

/** Protocol fee collector (all EVM chains). */
export const X402_FEE_COLLECTOR =
  '0xff86829393C6C26A4EC122bE0Cc3E466Ef876AdD' as Address;

/** Floor(amount * 77 / 10000) protocol fee in token base units. */
export function x402ProtocolFee(amount: bigint): bigint {
  if (amount <= 0n) return 0n;
  return (amount * X402_PROTOCOL_FEE_BPS) / 10000n;
}

/** Principal plus protocol fee — the total wallet debit for an exact payment. */
export function x402TotalDebit(amount: bigint): bigint {
  return amount + x402ProtocolFee(amount);
}
