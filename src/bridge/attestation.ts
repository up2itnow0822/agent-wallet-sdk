import type { Hex } from 'viem';

/**
 * Circle CCTP V2 attestation lookup (fixes #44).
 *
 * Circle's V2 IRIS API is queried by source domain + burn transaction hash:
 *   GET {apiUrl}/v2/messages/{sourceDomain}?transactionHash={burnTxHash}
 * The old path `/v2/messages/{domain}/{messageHash}` is not served by Circle,
 * so bridge() burned USDC and then timed out. In V2 the attested `message`
 * returned by Circle (nonce filled in) must be used for receiveMessage.
 */
export interface CctpAttestedMessage {
  message: Hex;
  attestation: Hex;
  /** Circle-assigned 32-byte V2 event nonce (hex), when returned. */
  eventNonce?: Hex;
}

/**
 * Bytes of a CCTP V2 message that Circle does not rewrite on attestation.
 * Header (148 bytes): version|sourceDomain|destinationDomain [0,12),
 * nonce [12,44) (filled offchain, skipped), sender|recipient|destinationCaller|
 * minFinalityThreshold [44,144), finalityThresholdExecuted [144,148) (skipped).
 * BurnMessageV2 body at 148: version|burnToken|mintRecipient|amount|
 * messageSender|maxFee [148,312), feeExecuted|expirationBlock [312,376)
 * (filled offchain, skipped), hookData [376,...).
 */
function stableFields(msg: string): string | null {
  const h = msg.toLowerCase().replace(/^0x/, '');
  if (h.length < 148 * 2) return null;
  const b = (a: number, z?: number) => h.slice(a * 2, z === undefined ? undefined : z * 2);
  return b(0, 12) + b(44, 144) + '|' + b(148, 312) + '|' + b(376);
}

function toNonceHex(n: string | undefined): Hex | undefined {
  if (typeof n !== 'string' || n.length === 0) return undefined;
  try {
    const v = BigInt(n);
    return ('0x' + v.toString(16).padStart(64, '0')) as Hex;
  } catch { return undefined; }
}

export interface CircleV2MessagesResponse {
  messages?: Array<{
    message?: Hex | string | null;
    attestation?: Hex | string | null;
    status?: string;
    eventNonce?: string;
  }>;
  error?: string;
}

export function attestationUrl(apiUrl: string, sourceDomain: number, burnTxHash: Hex): string {
  const base = apiUrl.replace(/\/+$/, '');
  return `${base}/v2/messages/${sourceDomain}?transactionHash=${burnTxHash}`;
}

/**
 * Interpret one Circle V2 response body.
 * Returns the attested message when complete, 'pending' while waiting,
 * or throws via `onError` for a terminal error.
 */
export function parseAttestationResponse(
  body: CircleV2MessagesResponse,
  onError: (msg: string) => never,
  expectedMessage?: Hex,
): CctpAttestedMessage | 'pending' {
  const all = body.messages ?? [];
  if (all.length === 0) return 'pending';
  let m = all[0];
  const want = expectedMessage ? stableFields(expectedMessage) : null;
  if (all.length > 1 && !want) {
    onError(`transaction has ${all.length} CCTP messages; the source message is required to select one`);
  }
  if (want) {
    // Always match against the caller's burn (also catches a stale/wrong tx).
    const ready = all.filter((x) => typeof x.message === 'string' && x.message.length > 2 && x.message !== '0x');
    const hits = ready.filter((x) => stableFields(x.message as string) === want);
    if (hits.length === 1) m = hits[0];
    else if (hits.length > 1) onError(`could not uniquely match the burn message among ${all.length} CCTP messages`);
    else if (ready.length < all.length) return 'pending';
    else onError('Circle returned no CCTP message matching this burn (wrong or stale burn transaction?)');
  }
  if (m.status === 'error') onError(body.error ?? 'Circle reported an attestation error');
  const att = m.attestation;
  const msg = m.message;
  if (
    m.status === 'complete' &&
    typeof att === 'string' && att.startsWith('0x') && att.length > 2 &&
    typeof msg === 'string' && msg.startsWith('0x') && msg.length > 2
  ) {
    return { message: msg as Hex, attestation: att as Hex, eventNonce: toNonceHex(m.eventNonce) };
  }
  return 'pending';
}
