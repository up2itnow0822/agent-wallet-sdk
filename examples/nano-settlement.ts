/**
 * Multi-Rail x402 Settlement — USDC (via AgentWallet SDK) + Nano (XNO, feeless)
 *
 * An agent that pays a merchant whose 402 `accepts[]` offers BOTH the existing
 * EVM USDC rails and a feeless Nano (XNO) exact-scheme rail on `nano:mainnet`.
 *
 * This is a *documented adapter*: one payment loop chooses a rail per payment.
 * When the merchant offers Nano it settles on the Nano rail — zero fee,
 * one-block finality, no gas — and falls back to the AgentWallet SDK's EVM
 * path otherwise. It reuses the published Nano x402 packages (@x402nano/exact,
 * @x402nano/helper); it does not reimplement Nano signing.
 *
 * Requirements
 *   npm i agent-wallet-sdk viem @x402nano/exact @x402nano/helper
 *   NANO_SEED   — 64-hex Nano private key, the Nano rail only
 *   AGENT_PRIVATE_KEY / AGENT_ACCOUNT_ADDRESS — the EVM (USDC) rail only
 *
 * This illustration validates rail selection deterministically and documents
 * the Nano signer wiring. In production wrap the chosen `accepts[]` entry in
 * the same fail-closed budget checks the SDK applies to its EVM path.
 */

import { X402Client, selectNanoRail, type NanoRailSelection } from '../src/index.js';
import { Helper } from '@x402nano/helper';
import { ExactNanoScheme } from '@x402nano/exact';
import type { X402PaymentRequired } from '../src/x402/types.js';

// ─── Config ───
const NANO_SEED = process.env.NANO_SEED; // 64-hex Nano private key
const NANO_RPC_URL = process.env.NANO_RPC_URL ?? 'https://rpc.nano.to';

/** Nano's divisibility: 10^30 raw per XNO (Nano protocol constant). */
const RAW_PER_XNO = 10n ** 30n;

/**
 * A Nano settlement leg via the published exact-scheme client.
 *
 * `ExactNanoScheme.createPaymentPayload(version, { payTo, amount })` signs a
 * Nano send block for the request (payTo + amount) and returns the protocol
 * payload the seller verifies — the same `payload` shape the EVM path sends
 * back in the X-PAYMENT header. The helper talks to the Nano node over RPC.
 * The rail itself is chosen by the SDK's dependency-free `selectNanoRail`.
 */
async function settleOnNano(
  nanoRail: NanoRailSelection,
): Promise<Record<string, unknown>> {
  if (!NANO_SEED) {
    throw new Error('NANO_SEED is required to settle the Nano rail');
  }
  const helper = new Helper({
    NANO_RPC_URL,
    NANO_ACCOUNT_PRIVATE_KEY: NANO_SEED,
  });
  const nanoClient = new ExactNanoScheme(helper);
  // The exact scheme reads payTo + amount; provide the full V2 requirement
  // shape so the call is type-correct against @x402/core's PaymentRequirements.
  const payload = await nanoClient.createPaymentPayload(1, {
    scheme: 'exact',
    network: 'nano:mainnet',
    amount: nanoRail.raw.toString(),
    asset: 'XNO',
    payTo: nanoRail.payTo,
    maxTimeoutSeconds: nanoRail.maxTimeoutSeconds,
    extra: {},
  });
  return payload.payload as Record<string, unknown>;
}

/**
 * One agent payment loop across both rails.
 *
 * Probes the endpoint; on a 402 it reads the offered rails, prefers the Nano
 * exact-scheme rail when offered, otherwise falls back to the SDK's
 * budget-checked EVM path. Returns the unlocked 200 response.
 */
export async function payMultiRail(url: string, init?: RequestInit): Promise<Response> {
  // 1. Probe the endpoint.
  const probe = await fetch(url, init);
  if (probe.status !== 402) return probe;

  // 2. Read the 402 requirements.
  const body = (await probe.json()) as X402PaymentRequired;
  const accepts = body.accepts;

  // 3. Prefer the feeless Nano rail when the merchant offers it.
  const nanoRail = selectNanoRail(accepts);
  if (nanoRail) {
    const payload = await settleOnNano(nanoRail);
    const proof = Buffer.from(JSON.stringify(payload)).toString('base64');
    return fetch(url, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        'X-PAYMENT': proof,
      },
    });
  }

  // 4. Fall back to the SDK's EVM path (budget-checked USDC).
  //    Emitted only for completeness: constructing the wallet is the caller's job.
  const client = new X402Client(undefined as never, {
    globalPerRequestMax: 10_000_000n,
    globalDailyLimit: 100_000_000n,
  });
  return client.fetch(url, init);
}

// ─── Usage ───
// const response = await payMultiRail('https://paid-api.example.com/data', {
//   method: 'POST',
//   body: JSON.stringify({ query: 'hello' }),
// });
// const data = await response.json();
//
// RAW_PER_XNO is exported so callers can display human XNO: number(raw) / 1e30.
export { RAW_PER_XNO };
