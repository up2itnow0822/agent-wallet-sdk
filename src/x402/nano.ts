/**
 * @module x402/nano
 * Nano (XNO) exact-scheme rail selection for the x402 payment client.
 *
 * Additive, pure, and dependency-free: given a merchant's 402 `accepts[]`,
 * pick the feeless Nano exact-scheme option on `nano:mainnet` when one is
 * offered. Settling it uses the published @x402nano/* packages (see
 * examples/nano-settlement.ts); this module only makes the *choice* — the
 * same determinism the SDK applies to its EVM rail selection — so a client
 * can present `nano:mainnet` beside the USDC rails without touching the
 * EVM settlement path.
 */
import type { X402PaymentRequirements } from './types.js';

/** A selected Nano exact-scheme rail, fully parsed and validated. */
export interface NanoRailSelection {
  /** Raw XNO amount (Nano uses 10^30 raw per XNO). */
  raw: bigint;
  /** Destination Nano account (`nano_...`). */
  payTo: string;
  /** Seller's advertised settlement window, seconds. */
  maxTimeoutSeconds: number;
}

/** A Nano rail must name the mainnet network, the exact scheme. */
export function isNanoExactRail(req: X402PaymentRequirements): boolean {
  return (
    req.network === 'nano:mainnet' &&
    req.scheme === 'exact' &&
    req.asset.toUpperCase() === 'XNO'
  );
}

/**
 * Select the Nano exact-scheme rail from a merchant's 402 `accepts[]`.
 *
 * Returns the parsed raw-XNO amount, recipient, and timeout when a Nano
 * option is offered; otherwise `null` (the caller keeps the EVM path).
 * Pure and deterministic — unit-tested, no network or wallet involved.
 */
export function selectNanoRail(
  accepts: X402PaymentRequirements[],
): NanoRailSelection | null {
  const nano = accepts.find(isNanoExactRail);
  if (!nano) return null;
  return {
    raw: BigInt(nano.amount),
    payTo: nano.payTo,
    maxTimeoutSeconds: nano.maxTimeoutSeconds,
  };
}
