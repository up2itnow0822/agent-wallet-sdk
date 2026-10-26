import type { Hex } from 'viem';
import { boundedFetch, parseBoundedJson, BoundedFetchError } from '../net/bounded-fetch.js';

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

/** Disambiguates identical burns batched in one transaction. */
export interface AttestationSelector {
  /** Circle eventNonce of the wanted message (hex or decimal). */
  eventNonce?: string;
  /** Index among identical matching messages, in Circle's response order. */
  index?: number;
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
  select?: AttestationSelector,
): CctpAttestedMessage | 'pending' {
  const all = body.messages ?? [];
  if (all.length === 0) return 'pending';
  if (!expectedMessage) {
    // Never accept an attestation that is not bound to a known source message:
    // a single unrelated (but validly signed) message would otherwise be minted.
    const anyComplete = all.some((x) => x.status === 'complete');
    if (all.length === 1 && all[0].status === 'error') onError(body.error ?? 'Circle reported an attestation error');
    if (anyComplete || all.length > 1) {
      onError('the source message is required to select and bind a CCTP attestation');
    }
    return 'pending';
  }
  let m = all[0];
  // Terminal errors win over matching: never poll to timeout on a failed attestation.
  if (all.length === 1 && m.status === 'error') onError(body.error ?? 'Circle reported an attestation error');
  const want = expectedMessage ? stableFields(expectedMessage) : null;
  if (expectedMessage && !want) onError('source messageBytes is not a valid CCTP V2 message');
  if (all.length > 1 && !want) {
    onError(`transaction has ${all.length} CCTP messages; the source message is required to select one`);
  }
  if (want) {
    // Always match against the caller's burn (also catches a stale/wrong tx).
    const ready = all.filter((x) => typeof x.message === 'string' && x.message.length > 2 && x.message !== '0x');
    const hits = ready.filter((x) => stableFields(x.message as string) === want);
    const nonceOf = (x: { eventNonce?: string }) => toNonceHex(x.eventNonce);
    const wantNonce = select?.eventNonce ? toNonceHex(select.eventNonce) : undefined;
    const nonceHit = wantNonce ? hits.filter((x) => nonceOf(x) === wantNonce) : [];
    if (nonceHit.length === 1) { m = nonceHit[0]; }
    else if (all.length > 1 && all.some((x) => !ready.includes(x) && x.status !== 'error')) {
      // Some entries are not ready yet: a sole ready hit may be a different identical burn.
      return 'pending';
    }
    else if (wantNonce && hits.length >= 1) onError('no CCTP message with the requested eventNonce in this transaction');
    else if (hits.length === 1) m = hits[0];
    else if (hits.length > 1) {
      // Identical batched burns: needs an explicit discriminator.
      const byNonce = select?.eventNonce
        ? hits.filter((x) => toNonceHex(x.eventNonce) === toNonceHex(select.eventNonce))
        : [];
      if (byNonce.length === 1) m = byNonce[0];
      else if (select?.index !== undefined && Number.isInteger(select.index) && select.index >= 0 && select.index < hits.length) m = hits[select.index];
      else onError(`${hits.length} identical CCTP messages in this transaction; pass eventNonce or messageIndex to choose one`);
    }
    else if (ready.length < all.length) {
      if (all.every((x) => x.status === 'error')) onError(body.error ?? 'Circle reported an attestation error');
      return 'pending';
    }
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

/**
 * True only when a depositForBurn write error proves nothing was broadcast
 * (the wallet or user rejected the request). Any other failure may have reached
 * the RPC node, so the burn could exist on-chain without a known tx hash.
 */
export function isDefinitelyNotBroadcast(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 6 && e && typeof e === 'object'; i++) {
    const o = e as { name?: unknown; code?: unknown; cause?: unknown };
    if (o.name === 'UserRejectedRequestError' || o.code === 4001) return true;
    e = o.cause;
  }
  return false;
}

export const BURN_SUBMISSION_UNKNOWN_HINT =
  'The burn may have been broadcast even though no tx hash was returned. Do NOT retry: check the sender account nonce and recent transactions for a depositForBurn first, then resume with that tx hash.';


// ─── CCTP V2 message decoding ───────────────────────────────────────────────

/** Fields of a CCTP V2 message + BurnMessageV2 body (offsets per stableFields). */
export interface DecodedCctpV2Message {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: Hex;
  sender: Hex;
  recipient: Hex;
  destinationCaller: Hex;
  minFinalityThreshold: number;
  bodyVersion: number;
  burnToken: Hex;
  mintRecipient: Hex;
  amount: bigint;
  messageSender: Hex;
  maxFee: bigint;
  feeExecuted: bigint;
}

/** Strictly decode a CCTP V2 burn message. Throws on malformed input. */
export function decodeCctpV2Message(message: Hex): DecodedCctpV2Message {
  if (typeof message !== 'string' || !/^0x[0-9a-fA-F]*$/.test(message)) {
    throw new Error('CCTP message must be a hex string');
  }
  const h = message.slice(2).toLowerCase();
  if (h.length % 2 !== 0 || h.length < 376 * 2) {
    throw new Error('CCTP message is too short to be a V2 burn message');
  }
  const b = (a: number, z: number) => h.slice(a * 2, z * 2);
  const word = (a: number, z: number) => ('0x' + b(a, z)) as Hex;
  const int = (a: number, z: number) => parseInt(b(a, z), 16);
  return {
    version: int(0, 4),
    sourceDomain: int(4, 8),
    destinationDomain: int(8, 12),
    nonce: word(12, 44),
    sender: word(44, 76),
    recipient: word(76, 108),
    destinationCaller: word(108, 140),
    minFinalityThreshold: int(140, 144),
    bodyVersion: int(148, 152),
    burnToken: word(152, 184),
    mintRecipient: word(184, 216),
    amount: BigInt('0x' + b(216, 248)),
    messageSender: word(248, 280),
    maxFee: BigInt('0x' + b(280, 312)),
    feeExecuted: BigInt('0x' + b(312, 344)),
  };
}

/** Left-pad a 20-byte EVM address (or 32-byte value) to a lowercase bytes32 hex. */
export function toBytes32(value: string): Hex {
  const h = value.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{1,64}$/.test(h)) throw new Error(`invalid bytes32 value ${value}`);
  return ('0x' + h.padStart(64, '0')) as Hex;
}

export interface ExpectedBurnTerms {
  sourceDomain?: number;
  destinationDomain?: number;
  burnToken?: string;
  mintRecipient?: string;
  amount?: bigint;
  sender?: string;
}

/** Throw unless every supplied term matches the decoded message. */
export function assertBurnTerms(message: Hex, terms: ExpectedBurnTerms): DecodedCctpV2Message {
  const d = decodeCctpV2Message(message);
  const mismatch = (field: string, got: unknown, want: unknown) => {
    throw new Error(`CCTP message ${field} ${String(got)} does not match expected ${String(want)}`);
  };
  if (terms.sourceDomain !== undefined && d.sourceDomain !== terms.sourceDomain) mismatch('sourceDomain', d.sourceDomain, terms.sourceDomain);
  if (terms.destinationDomain !== undefined && d.destinationDomain !== terms.destinationDomain) mismatch('destinationDomain', d.destinationDomain, terms.destinationDomain);
  if (terms.burnToken !== undefined && d.burnToken !== toBytes32(terms.burnToken)) mismatch('burnToken', d.burnToken, terms.burnToken);
  if (terms.mintRecipient !== undefined && d.mintRecipient !== toBytes32(terms.mintRecipient)) mismatch('mintRecipient', d.mintRecipient, terms.mintRecipient);
  if (terms.amount !== undefined && d.amount !== terms.amount) mismatch('amount', d.amount, terms.amount);
  if (terms.sender !== undefined && d.sender !== toBytes32(terms.sender)) mismatch('sender', d.sender, terms.sender);
  return d;
}

// ─── Bounded Circle polling ─────────────────────────────────────────────────

/** Per-request deadline for one Circle attestation lookup. */
export const ATTESTATION_REQUEST_TIMEOUT_MS = 15_000;
/** Maximum Circle response body size. */
export const ATTESTATION_MAX_RESPONSE_BYTES = 256 * 1024;
/** Maximum messages accepted in one Circle response. */
export const ATTESTATION_MAX_MESSAGES = 16;
const MAX_MESSAGE_HEX = 2 + 2 * 32 * 1024;   // 32 KiB message bytes (incl. hookData)
const MAX_ATTESTATION_HEX = 2 + 2 * 4 * 1024; // 4 KiB of signatures
const MAX_SHORT_FIELD = 128;
const MAX_ERROR_TEXT = 512;

function shortString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

/** Validate an untrusted Circle body into a bounded, typed shape. */
export function validateCircleBody(raw: unknown): CircleV2MessagesResponse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Circle response is not an object');
  const obj = raw as Record<string, unknown>;
  const out: CircleV2MessagesResponse = {};
  if (obj.error !== undefined) out.error = shortString(obj.error, MAX_ERROR_TEXT) ?? 'Circle error';
  if (obj.messages === undefined) return out;
  if (!Array.isArray(obj.messages)) throw new Error('Circle messages is not an array');
  if (obj.messages.length > ATTESTATION_MAX_MESSAGES) {
    throw new Error(`Circle returned ${obj.messages.length} messages (limit ${ATTESTATION_MAX_MESSAGES})`);
  }
  out.messages = obj.messages.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Circle message ${i} is not an object`);
    const e = entry as Record<string, unknown>;
    const message = e.message;
    const attestation = e.attestation;
    if ((message !== undefined && message !== null) && (typeof message !== 'string' || message.length > MAX_MESSAGE_HEX)) {
      throw new Error(`Circle message ${i} has an invalid or oversized message`);
    }
    if ((attestation !== undefined && attestation !== null) && (typeof attestation !== 'string' || attestation.length > MAX_ATTESTATION_HEX)) {
      throw new Error(`Circle message ${i} has an invalid or oversized attestation`);
    }
    return {
      message: message as string | null | undefined,
      attestation: attestation as string | null | undefined,
      status: shortString(e.status, MAX_SHORT_FIELD),
      eventNonce: shortString(e.eventNonce, MAX_SHORT_FIELD),
    };
  });
  return out;
}

export interface PollAttestationParams {
  burnTx: string;
  sourceDomain: number;
  apiUrl: string;
  /** Required: the source message the attestation must match. */
  expectedMessage: Hex;
  select?: AttestationSelector;
  maxPolls: number;
  intervalMs: number;
  /** Overall deadline across all polls (ms). */
  totalTimeoutMs?: number;
  requestTimeoutMs?: number;
  sleep: (ms: number) => Promise<void>;
  /** Build the caller's error type. */
  makeError: (code: 'ATTESTATION_ERROR' | 'ATTESTATION_TIMEOUT', message: string) => Error;
  fetchImpl?: typeof fetch;
}

/** Poll Circle IRIS V2 with per-request deadlines, a body cap and strict validation. */
export async function pollCircleAttestation(p: PollAttestationParams): Promise<CctpAttestedMessage> {
  if (!p.expectedMessage) throw p.makeError('ATTESTATION_ERROR', 'source message is required to bind the attestation');
  const url = attestationUrl(p.apiUrl, p.sourceDomain, p.burnTx as Hex);
  const fail = (m: string): never => { throw p.makeError('ATTESTATION_ERROR', `Circle attestation failed: ${m}.`); };
  const started = Date.now();
  const total = p.totalTimeoutMs ?? p.maxPolls * (p.intervalMs + (p.requestTimeoutMs ?? ATTESTATION_REQUEST_TIMEOUT_MS));
  for (let attempt = 0; attempt < p.maxPolls; attempt++) {
    const remaining = total - (Date.now() - started);
    if (remaining <= 0) break;
    let res;
    try {
      res = await boundedFetch(url, { headers: { Accept: 'application/json' } }, {
        timeoutMs: Math.min(p.requestTimeoutMs ?? ATTESTATION_REQUEST_TIMEOUT_MS, remaining),
        maxBytes: ATTESTATION_MAX_RESPONSE_BYTES,
        fetchImpl: p.fetchImpl,
      });
    } catch (err: unknown) {
      if (err instanceof BoundedFetchError && err.code === 'TIMEOUT') { await p.sleep(p.intervalMs); continue; }
      const msg = err instanceof Error ? err.message : String(err);
      throw p.makeError('ATTESTATION_ERROR', `Failed to read Circle IRIS API: ${msg}.`);
    }
    if (!res.ok) {
      if (res.status === 404) { await p.sleep(p.intervalMs); continue; }
      throw p.makeError('ATTESTATION_ERROR', `Circle API returned HTTP ${res.status}: ${res.text.slice(0, MAX_ERROR_TEXT)}.`);
    }
    let body: CircleV2MessagesResponse;
    try {
      body = validateCircleBody(parseBoundedJson(res.text, 'Circle response'));
    } catch (err: unknown) {
      throw p.makeError('ATTESTATION_ERROR', `Invalid Circle IRIS response: ${(err as Error).message}.`);
    }
    const r = parseAttestationResponse(body, fail, p.expectedMessage, p.select);
    if (r !== 'pending') return r;
    await p.sleep(p.intervalMs);
  }
  throw p.makeError('ATTESTATION_TIMEOUT',
    `Attestation not received after ${p.maxPolls} attempts / ${total} ms. Burn tx: ${p.burnTx} (source domain ${p.sourceDomain}). Funds are not lost: resume with this burn transaction; never burn again.`);
}
