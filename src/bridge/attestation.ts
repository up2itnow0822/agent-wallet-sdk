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
): CctpAttestedMessage | 'pending' {
  const m = body.messages?.[0];
  if (!m) return 'pending';
  if (m.status === 'error') onError(body.error ?? 'Circle reported an attestation error');
  const att = m.attestation;
  const msg = m.message;
  if (
    m.status === 'complete' &&
    typeof att === 'string' && att.startsWith('0x') && att.length > 2 &&
    typeof msg === 'string' && msg.startsWith('0x') && msg.length > 2
  ) {
    return { message: msg as Hex, attestation: att as Hex };
  }
  return 'pending';
}
