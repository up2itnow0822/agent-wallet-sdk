/**
 * @module x402/client
 * x402 Payment Client — automatic HTTP 402 payment handling for AgentWallet.
 *
 * Wraps the standard fetch API to transparently handle 402 Payment Required
 * responses using the x402 protocol. Supports multi-chain, multi-asset payments
 * (USDC, USDT, DAI, WETH, and any token in the TokenRegistry) across all 11
 * mainnet chains configured in x402/types.ts.
 *
 * Flow: fetch → 402 detected → parse payment requirements → resolve asset address
 *       via TokenRegistry → budget check → execute ERC-20 transfer → retry with
 *       X-PAYMENT header.
 */
// x402 Client — automatic 402 payment handling for AgentWallet (v6: multi-asset)
import type { Address, Hash } from 'viem';
import { encodeFunctionData, isAddress, keccak256, toEventHash, toHex } from 'viem';
import type {
  X402PaymentRequired,
  X402PaymentRequirements,
  X402PaymentPayload,
  X402ClientConfig,
  X402TransactionLog,
} from './types.js';
import { DEFAULT_SUPPORTED_NETWORKS } from './types.js';
import { X402BudgetTracker } from './budget.js';
import {
  X402_PROTOCOL_FEE_COLLECTOR,
  x402DebitAmount,
  x402ProtocolFeeAmount,
} from './fee.js';
import { submitAgentTransferToken, checkBudget } from '../index.js';
import { AgentAccountV2Abi } from '../abi.js';
import { parseNetworkChainId, resolveAssetAddress } from './multi-asset.js';
import { toReplayableFetchArgs, withFailClosedRedirect } from './fetch-args.js';
import { readBoundedText } from '../net/bounded-fetch.js';
import { AgentWalletVerificationError } from '../wallet-verification-error.js';

/**
 * keccak256("TransactionQueued(uint256,address,uint256,address,uint256)").
 * Same topic `agentExecute` uses to distinguish a spend that only queued for
 * owner approval from one that actually moved tokens.
 */
export const X402_TRANSACTION_QUEUED_TOPIC = toEventHash({
  type: 'event',
  name: 'TransactionQueued',
  inputs: [
    { name: 'txId', type: 'uint256', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
    { name: 'token', type: 'address', indexed: false },
    { name: 'amount', type: 'uint256', indexed: false },
  ],
});

const MAX_PAYMENT_REQUIRED_HEADER_BYTES = 64 * 1024;
/** Maximum 402 JSON body read when no PAYMENT-REQUIRED header is present. */
const MAX_PAYMENT_REQUIRED_BODY_BYTES = 64 * 1024;
/** Deadline for reading a 402 challenge body. */
const X402_CHALLENGE_BODY_TIMEOUT_MS = 10_000;
/** Maximum payment options accepted from one challenge. */
const MAX_PAYMENT_OPTIONS = 16;
const MAX_UINT256 = (1n << 256n) - 1n;
const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** x402 wire JSON is base64 of UTF-8 bytes, including Unicode merchant metadata. */
export function encodeX402PaymentHeader(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeX402PaymentHeader(value: string): unknown {
  const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/**
 * Minimum window during which a successful settlement may be replayed for the
 * same intent. A settlement is retained for the longer of this and the
 * challenge's own `maxTimeoutSeconds`, so a retry inside the server's
 * advertised window can never miss the cache. The cache is bounded by
 * throughput × window until the fail-closed capacity ceiling is reached;
 * reaching that ceiling never evicts an unexpired intent.
 */
export const X402_SETTLEMENT_RETRY_WINDOW_MS = 120_000;
/**
 * Fail-closed ceiling on settlements that are not confirmed successful:
 * in-flight (submitted, receipt pending), unknown (receipt polling failed) and
 * reverted-but-unobserved tombstones all occupy this cap, and none of them is
 * ever evicted. Once this many are outstanding the client refuses to broadcast
 * new explicit-intent transfers until confirmations resume or the tombstoned
 * intents are observed. Retries of already-submitted intents are still served.
 */
export const X402_MAX_UNCONFIRMED_SETTLEMENTS = 1024;
/** Refuse new intents at this ceiling; never evict a protected payment to make room. */
export const X402_MAX_CACHED_SETTLEMENTS = 4096;
/** First delay before an `unknown` settlement is reconfirmed opportunistically again. */
export const X402_RECONFIRM_BACKOFF_MS = 5_000;
/** Cap on the opportunistic reconfirmation delay. */
export const X402_RECONFIRM_BACKOFF_MAX_MS = 300_000;

type SettlementConfirmation = 'confirmed' | 'unknown' | 'reverted' | 'queued';

type PaymentPhase = 'fee' | 'payee';
type PreparedTransfer = Readonly<{ token: Address; to: Address; amount: bigint; input: `0x${string}` }>;

type CachedFeePhase = {
  txHash?: Hash;
  termsFingerprint: string;
  /** Confirmed fee already debited from the wallet, in raw token units. */
  amount: bigint;
  /** unknown: broadcast receipt unverified; queued: owner approval required. */
  status: 'unknown' | 'queued' | 'confirmed';
  /** Retained even if submission accepted the transaction but returned no hash. */
  transfer?: PreparedTransfer;
};

type CachedSettlement = {
  promise: Promise<{ txHash: Hash }>;
  /** Canonical payment terms bound to this explicit intent. */
  termsFingerprint: string;
  /** How long a confirmed settlement is replayable: max(default window, challenge timeout). */
  retryWindowMs: number;
  /**
   * null until the receipt is confirmed and proof delivery succeeds; otherwise
   * epoch ms when the replay window ends. Unresolved entries never expire.
   */
  expiresAt: number | null;
  /**
   * in-flight: policy/broadcast/first receipt still pending.
   * unknown: broadcast, but receipt polling failed; retained (never evicted) and
   *          reconfirmed on later client activity so a revert can be released.
   * queued: AgentAccount parked the spend for owner approval; reservation stays
   *         held so a retry cannot queue a second live transfer.
   * confirmed: receipt observed with status success and tokens moved.
   * reverted: a delayed revert was found by background reconfirmation and no
   *           caller has observed it yet; retained until the next observation
   *           of this intent, which throws instead of silently paying again.
   */
  status: 'in-flight' | 'unknown' | 'queued' | 'confirmed' | 'reverted';
  /** Submitted transaction hash once execute() returned. */
  txHash?: Hash;
  /** Client-side budget reservation for this settlement; settled or released exactly once. */
  reservationId?: string;
  /**
   * True when `reservationId` counted principal plus protocol fee. A retry
   * after a confirmed fee reserves principal only, so a later payee failure
   * must not keep the fee a second time.
   */
  reservationIncludesFee?: boolean;
  /**
   * The success observation the original caller recorded while the receipt
   * was still unknown; a delayed revert appends a corrective entry from it.
   */
  log?: X402TransactionLog;
  /** Single-flight receipt reconfirmation for an `unknown` settlement. */
  confirming?: Promise<SettlementConfirmation>;
  /** Opportunistic reconfirmation is skipped before this time (exponential backoff). */
  nextReconfirmAt?: number;
  /** Consecutive reconfirmation attempts that still could not observe a receipt. */
  reconfirmFailures?: number;
  /** True when the nonce was reused with different calldata; never send as X-PAYMENT. */
  unverifiedReplacement?: boolean;
  /** Fee was submitted but its receipt is not final; it must never become payment proof. */
  feePhasePending?: boolean;
  /** Unkeyed calls require a confirmed receipt before emitting an X-PAYMENT proof. */
  unkeyed?: boolean;
  /** Shared proof identity for all callers coalesced into one unkeyed transfer. */
  paymentIdempotencyKey?: string;
  /** A lost submission response cannot be retried or inferred from a fee hash. */
  submissionUnknown?: { phase: PaymentPhase; transfer?: PreparedTransfer };
  /** Confirmed transfers remain pinned while delivery failed or is still in flight. */
  pendingDeliveries?: number;
  /**
   * Sticky success flag: `false` once any concurrent proof delivery succeeded.
   * A later failed or thrown delivery must not overwrite that success.
   */
  deliveryFailed?: boolean;
  reconciling?: { txHash: Hash; promise: Promise<SettlementConfirmation> };
};

type PaymentResult = {
  txHash: Hash;
  replayed: boolean;
  entry?: CachedSettlement;
  paymentIdempotencyKey?: string;
};

/** Internal: onBeforePayment returned false. Waiters must observe skip, not a second transfer. */
const X402_POLICY_SKIP = Symbol('x402-policy-skip');

/**
 * Budget authorization for one fresh transfer. Resolves with the reservation id
 * once limits are checked and the spend is reserved, or null when
 * onBeforePayment declined. Throws X402BudgetExceededError when limits refuse.
 */
type AuthorizeFreshTransfer = (feeAlreadySettled?: boolean) => Promise<string | null>;

/**
 * [MAX-ADDED] x402 Payment Client for AgentWallet.
 *
 * Handles the full x402 payment flow:
 * 1. Detects 402 Payment Required responses
 * 2. Parses payment instructions from PAYMENT-REQUIRED header
 * 3. Validates against budget controls
 * 4. Executes USDC payment via AgentWallet contract
 * 5. Retries original request with payment proof
 */
export function explicitX402PaymentIntentId(
  req: X402PaymentRequirements,
): string | null {
  const extra = req.extra ?? {};
  if (typeof extra.idempotencyKey === 'string' && extra.idempotencyKey.trim() !== '') {
    return extra.idempotencyKey;
  }
  if (typeof extra.nonce === 'string' && extra.nonce.trim() !== '') {
    return extra.nonce;
  }
  return null;
}

export function canonicalizeX402RequestUrl(url: string | URL): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return String(url);
  }
}

export function canonicalizeX402Amount(amount: string): string {
  if (!/^\d+$/.test(amount)) {
    return amount;
  }
  try {
    return BigInt(amount).toString();
  } catch {
    return amount;
  }
}

export function canonicalizeX402Asset(asset: string, network: string): string {
  return (resolveAssetAddress(asset, network) ?? asset).toLowerCase();
}

/** Length-prefix a field so `|` inside values cannot collide cache keys. */
export function encodeX402KeyField(value: string): string {
  return `${value.length}:${value}`;
}

export function buildX402PaymentIntentKey(
  method: string,
  url: string | URL,
  intentId: string,
): string {
  const normalizedMethod = method.trim().toUpperCase() || 'GET';
  return [
    encodeX402KeyField(normalizedMethod),
    encodeX402KeyField(canonicalizeX402RequestUrl(url)),
    encodeX402KeyField(intentId),
  ].join('|');
}

export function buildX402PaymentTermsFingerprint(req: X402PaymentRequirements): string {
  return [
    encodeX402KeyField(req.network),
    encodeX402KeyField(canonicalizeX402Asset(req.asset, req.network)),
    encodeX402KeyField(canonicalizeX402Amount(req.amount)),
    encodeX402KeyField(req.payTo.toLowerCase()),
    encodeX402KeyField(req.scheme),
  ].join('|');
}

/**
 * Synchronous content fingerprint for a fetch body. Returns undefined when the
 * body cannot be read without consuming it (Blob, FormData, ReadableStream).
 * Empty / missing bodies share one identity so a GET/POST retry still joins.
 */
export function fingerprintReadableX402RequestBody(
  body: BodyInit | null | undefined,
): string | undefined {
  if (body === null || body === undefined) {
    return '';
  }
  if (typeof body === 'string') {
    return `s:${body}`;
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return `q:${body.toString()}`;
  }
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) {
    return `b:${fingerprintX402RequestBytes(new Uint8Array(body))}`;
  }
  if (ArrayBuffer.isView(body)) {
    return `b:${fingerprintX402RequestBytes(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    )}`;
  }
  return undefined;
}

/** Keccak fingerprint keeps request and caller values out of in-memory cache keys. */
function fingerprintX402RequestBytes(bytes: Uint8Array): string {
  return `${bytes.length}:${keccak256(toHex(bytes))}`;
}

/**
 * Stable, order-insensitive caller identity for unkeyed requests. Values are
 * hashed so credentials never appear in a settlement key or diagnostics.
 */
export function fingerprintX402RequestHeaders(headers?: HeadersInit): string {
  const canonical = Array.from(new Headers(headers).entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${encodeX402KeyField(name)}${encodeX402KeyField(value)}`)
    .join('');
  return fingerprintX402RequestBytes(new TextEncoder().encode(canonical));
}

/**
 * Hash request options that can change the caller context the server sees.
 * Defaults are explicit so an omitted credential mode joins its equivalent
 * `same-origin` spelling, while ambient cookie contents remain outside the
 * client-visible RequestInit snapshot.
 */
function fingerprintX402RequestContext(init?: RequestInit): string {
  const canonical = [
    fingerprintX402RequestHeaders(init?.headers),
    init?.credentials ?? 'same-origin',
    init?.mode ?? 'cors',
    init?.referrer ?? 'about:client',
    init?.referrerPolicy ?? '',
  ].map(encodeX402KeyField).join('');
  return fingerprintX402RequestBytes(new TextEncoder().encode(canonical));
}

/**
 * Cache key for a 402 that carries no explicit intent id. Scoped to method +
 * URL + request identity so an unresolved unkeyed broadcast cannot be
 * reused as proof for a different resource, body, or caller context, and it
 * cannot block a later unrelated payment. Terms are checked against the cached
 * intent separately; changing an amount must not authorize another transfer.
 */
export function buildUnkeyedPendingKey(
  method: string,
  url: string | URL,
  _termsFingerprint: string,
  requestFingerprint: string = '',
): string {
  const normalizedMethod = method.trim().toUpperCase() || 'GET';
  return [
    'unkeyed',
    encodeX402KeyField(normalizedMethod),
    encodeX402KeyField(canonicalizeX402RequestUrl(url)),
    encodeX402KeyField(requestFingerprint),
  ].join('|');
}

type SettlementReceiptLog = {
  address?: string;
  topics?: readonly string[];
};

type SettlementReceipt = {
  status?: string;
  logs?: readonly SettlementReceiptLog[];
  transactionHash?: Hash;
};

type SettlementReplacementReason = 'repriced' | 'cancelled' | 'replaced';

type SettlementReplacementEvent = {
  reason?: string;
  transactionReceipt?: {
    status?: string;
    transactionHash?: Hash;
  };
};

/**
 * True when the agent wallet emitted TransactionQueued. The outer tx can still
 * be `success` — the spend was parked for owner approval and no tokens moved.
 */
export function x402SettlementReceiptIsQueued(
  receipt: SettlementReceipt | null | undefined,
  walletAddress?: string,
): boolean {
  const logs = receipt?.logs;
  if (!Array.isArray(logs) || logs.length === 0) {
    return false;
  }
  const walletAddr = typeof walletAddress === 'string' ? walletAddress.toLowerCase() : '';
  return logs.some((log) => {
    if (log?.topics?.[0] !== X402_TRANSACTION_QUEUED_TOPIC) {
      return false;
    }
    if (!walletAddr) {
      return true;
    }
    return typeof log.address === 'string' && log.address.toLowerCase() === walletAddr;
  });
}

/**
 * Key emitted in the X-PAYMENT payload and the transaction log. Every field is
 * length-prefixed (see encodeX402KeyField) so a `|` inside a scheme or intent
 * id cannot make two distinct payments advertise the same identifier.
 */
export function buildX402PaymentIdempotencyKey(
  method: string,
  url: string | URL,
  req: X402PaymentRequirements,
  uniqueFallback?: string,
): string {
  const extraKey = explicitX402PaymentIntentId(req) ?? uniqueFallback ?? '';
  const normalizedMethod = method.trim().toUpperCase() || 'GET';
  return [
    encodeX402KeyField(normalizedMethod),
    encodeX402KeyField(canonicalizeX402RequestUrl(url)),
    encodeX402KeyField(req.network),
    encodeX402KeyField(canonicalizeX402Asset(req.asset, req.network)),
    encodeX402KeyField(canonicalizeX402Amount(req.amount)),
    encodeX402KeyField(req.payTo.toLowerCase()),
    encodeX402KeyField(req.scheme),
    encodeX402KeyField(extraKey),
  ].join('|');
}

export class X402Client {
  private wallet: any; // ReturnType<typeof createWallet> — avoid circular import
  private config: X402ClientConfig;
  private budget: X402BudgetTracker;
  private supportedNetworks: Set<string>;
  private paymentSettlements = new Map<string, CachedSettlement>();
  /**
   * Protocol-fee hashes keyed by explicit intent or unkeyed pending key.
   * Survives payee-revert eviction so a retry does not charge 0.77% twice.
   * Unkeyed fees share the confirmed request's replay window. New purchases
   * must supply a distinct request identity or explicit merchant intent.
   */
  private feePhases = new Map<string, CachedFeePhase>();
  private unkeyedIntentSequence = 0;
  /** Object-identity fallback for bodies that cannot be fingerprinted synchronously. */
  private unreadableRequestIds = new WeakMap<object, string>();
  /** Immutable Blob/File values in a FormData snapshot retain one safe identity. */
  private formDataValueIds = new WeakMap<object, string>();

  constructor(wallet: any, config: X402ClientConfig = {}) {
    this.wallet = wallet;
    this.config = {
      autoPay: true,
      maxRetries: 1,
      supportedNetworks: [...DEFAULT_SUPPORTED_NETWORKS],
      ...config,
    };
    this.budget = new X402BudgetTracker(config);
    this.supportedNetworks = new Set(this.config.supportedNetworks);
  }

  /**
   * Make an x402-aware fetch request. Automatically handles 402 responses.
   *
   * Accepts the same `(input, init)` shape as native fetch, including `Request`.
   * Method, headers, and body are materialized before the first hop so a 402
   * retry cannot silently become a GET with an empty body.
   */
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const { url, init: replayInit } = await toReplayableFetchArgs(input, init);
    const requestInit = withFailClosedRedirect(this.snapshotRequestInit(replayInit), init);
    const requestUrl = url;
    const urlStr = canonicalizeX402RequestUrl(requestUrl);
    const response = await globalThis.fetch(requestUrl, requestInit);

    if (response.status !== 402) {
      return response;
    }

    if (!this.config.autoPay) {
      return response;
    }

    return this.complete402Payment(response, requestUrl, urlStr, requestInit, globalThis.fetch);
  }

  /**
   * Pay an already-received 402 challenge and retry with `X-PAYMENT`.
   *
   * Used by wrapWithX402 so the unpaid challenge is not fetched a second time
   * (a second hop that dropped Request method/body used to turn POST 402s into
   * unpaid GETs) and so the paid retry goes through the wrapped fetch.
   */
  async settle402AndRetry(
    response: Response,
    url: string,
    init?: RequestInit,
    fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<Response> {
    if (response.status !== 402) {
      return response;
    }
    if (!this.config.autoPay) {
      return response;
    }
    const requestInit = this.snapshotRequestInit(init);
    const requestUrl = url;
    const urlStr = canonicalizeX402RequestUrl(requestUrl);
    return this.complete402Payment(response, requestUrl, urlStr, requestInit, fetchImpl);
  }

  /**
   * Shared 402 settlement + paid retry. `requestInit` is already snapshotted.
   */
  private async complete402Payment(
    response: Response,
    requestUrl: string,
    urlStr: string,
    requestInit: RequestInit | undefined,
    fetchImpl: typeof globalThis.fetch,
  ): Promise<Response> {
    if (!this.isPaymentTransportAllowed(urlStr)) return response;
    const method = typeof requestInit?.method === 'string' && requestInit.method.trim() !== ''
      ? requestInit.method
      : 'GET';
    // Bind settlement identity and both requests to the same call-time values.
    const unkeyedRequestFingerprint = this.fingerprintUnkeyedRequest(requestInit);

    // Parse the 402 response
    const parsedPaymentRequired = await this.parse402Response(response);
    if (!parsedPaymentRequired) {
      return response; // Couldn't parse — return original 402
    }
    // Snapshot and serialize all merchant fields before policy callbacks or
    // transfers. The proof never reads a merchant/callback-owned object again.
    let paymentRequired: X402PaymentRequired;
    try {
      paymentRequired = JSON.parse(JSON.stringify(parsedPaymentRequired)) as X402PaymentRequired;
    } catch (err) {
      // Pathologically deep challenges overflow re-serialization: never pay
      // from them. Other serialization errors keep their existing failure.
      if (err instanceof RangeError) return response;
      throw err;
    }

    // Bind against the final response URL (after redirects). Refuse auto-pay when
    // fetch followed a cross-origin redirect — otherwise a 402 on the redirected
    // host with a relative resource.url matching the original path can siphon funds.
    const finalUrl = response.url && response.url.length > 0
      ? canonicalizeX402RequestUrl(response.url)
      : urlStr;
    if (!this.isPaymentTransportAllowed(finalUrl)) return response;
    if (!this.isSafePaymentResponseUrl(urlStr, finalUrl)) {
      return response;
    }

    if (!this.isResourceBoundToRequest(paymentRequired, finalUrl)) {
      return response;
    }

    // Find a compatible payment option
    const selected = this.selectPaymentOption(paymentRequired.accepts);
    if (!selected) {
      return response; // No compatible payment option
    }

    const amount = BigInt(selected.amount);
    const service = new URL(urlStr).hostname;
    const explicitIntent = explicitX402PaymentIntentId(selected);
    const idempotencyKey = buildX402PaymentIdempotencyKey(
      method,
      urlStr,
      selected,
      explicitIntent ?? this.nextUnkeyedIntentId(),
    );

    // Policy gate for one fresh transfer. Count the protocol fee in the client
    // daily/per-request limits so a principal-only check cannot pass, charge
    // 0.77%, then strand the payee against a limit the operator thought was
    // already full. The budget is checked before the (possibly slow,
    // human-facing) onBeforePayment callback so nobody is asked to approve a
    // payment the limits already refuse, then re-checked and reserved atomically
    // once approval is in hand. No await separates that final check from the
    // reservation, so two concurrent intents cannot both pass a daily limit that
    // only has room for one of them.
    const authorizeFreshTransfer: AuthorizeFreshTransfer = async (feeAlreadySettled = false) => {
      // A confirmed fee is already in the daily total. Reserving it again would
      // either block the payee retry or, if the first reservation was released,
      // forget the fee and let a later intent spend past the limit.
      const debit = feeAlreadySettled ? amount : x402DebitAmount(amount);
      const precheck = this.budget.checkBudget(service, debit);
      if (!precheck.allowed) {
        throw new X402BudgetExceededError(precheck.reason!, urlStr, selected);
      }
      if (this.config.onBeforePayment) {
        const proceed = await this.config.onBeforePayment(
          JSON.parse(JSON.stringify(selected)) as X402PaymentRequirements,
          urlStr,
        );
        if (!proceed) {
          return null;
        }
      }
      const reserved = this.budget.checkAndReserve(service, debit);
      if (!reserved.allowed) {
        throw new X402BudgetExceededError(reserved.reason, urlStr, selected);
      }
      return reserved.reservationId;
    };

    // Explicit merchant intent ids also bind the full call-time request identity
    // (body, headers, credentials/context), so a merchant cannot replay an old
    // proof for a different request body or caller: a mismatch is a terms
    // conflict, never a replay and never a second transfer.
    const termsFingerprint = explicitIntent
      ? `${buildX402PaymentTermsFingerprint(selected)}|${encodeX402KeyField(unkeyedRequestFingerprint)}`
      : buildX402PaymentTermsFingerprint(selected);
    const paymentKey = explicitIntent
      ? buildX402PaymentIntentKey(method, urlStr, explicitIntent)
      : buildUnkeyedPendingKey(method, urlStr, termsFingerprint, unkeyedRequestFingerprint);
    const retryWindowMs = Math.max(X402_SETTLEMENT_RETRY_WINDOW_MS, selected.maxTimeoutSeconds * 1000);
    const preparedPayload: X402PaymentPayload = {
      x402Version: paymentRequired.x402Version,
      resource: paymentRequired.resource,
      accepted: selected,
      payload: {},
    };
    // Check the complete wire encoding while no funds have moved yet.
    encodeX402PaymentHeader(preparedPayload);
    const retryHeaders = new Headers(requestInit?.headers);
    const paymentResult = explicitIntent
      ? await this.settlePayment(
          paymentKey,
          termsFingerprint,
          (intent) => this.executePayment(selected, intent),
          authorizeFreshTransfer,
          retryWindowMs,
        )
      : await this.executeUnkeyedPayment(
          paymentKey,
          termsFingerprint,
          (intent) => this.executePayment(selected, intent),
          authorizeFreshTransfer,
          idempotencyKey,
          retryWindowMs,
        );
    if (!paymentResult) {
      return response;
    }
    const replayed = paymentResult.replayed;
    const paymentIdempotencyKey = paymentResult.paymentIdempotencyKey ?? idempotencyKey;

    const paymentPayload: X402PaymentPayload = {
      ...preparedPayload,
      payload: {
        txHash: paymentResult.txHash,
        network: selected.network,
        idempotencyKey: paymentIdempotencyKey,
        replayed,
      },
    };

    const log: X402TransactionLog = {
      timestamp: Math.floor(Date.now() / 1000),
      service,
      url: urlStr,
      amount,
      // The settled contract address, not the challenge's spelling of it: a
      // replay of an address-form intent via its symbol must log the same token.
      token: (resolveAssetAddress(selected.asset, selected.network) ?? selected.asset) as Address,
      recipient: selected.payTo as Address,
      txHash: paymentResult.txHash,
      network: selected.network,
      scheme: selected.scheme,
      success: true,
      idempotencyKey: paymentIdempotencyKey,
      replayed,
    };
    // Fresh transfers were already counted by their budget reservation; the
    // settlement path settles or releases that reservation once the receipt
    // outcome is known. Replays never change totals.
    this.budget.recordPayment(log, { reserved: !replayed });
    if (paymentResult.entry && !replayed) {
      // Kept so a delayed revert can append a corrective observation.
      paymentResult.entry.log = log;
    }
    const entry = paymentResult.entry;
    if (entry) {
      entry.pendingDeliveries = (entry.pendingDeliveries ?? 0) + 1;
      entry.expiresAt = null;
    }
    try {
      this.config.onPaymentComplete?.({ ...log });
      retryHeaders.set('X-PAYMENT', encodeX402PaymentHeader(paymentPayload));
      const retryResponse = await fetchImpl(requestUrl, {
        ...requestInit,
        headers: retryHeaders,
        // Never forward proof to a redirect destination, including an HTTP
        // downgrade. Unpaid `follow` opt-in does not authorize proof forwarding.
        redirect: requestInit?.redirect === 'manual' ? 'manual' : 'error',
      });
      this.recordProofDelivery(entry, retryResponse.ok);
      return retryResponse;
    } catch (cause) {
      this.recordProofDelivery(entry, false);
      const fee = this.feePhases.get(paymentKey);
      throw new X402PaidRequestError(
        paymentResult.txHash,
        fee?.status === 'confirmed' ? fee.txHash : undefined,
        cause,
        paymentIdempotencyKey,
      );
    } finally {
      if (entry) {
        entry.pendingDeliveries = Math.max(0, (entry.pendingDeliveries ?? 1) - 1);
        if (!entry.deliveryFailed && !entry.pendingDeliveries) {
          if (entry.unkeyed) {
            // Delivered unkeyed proof completed this purchase. A later identical
            // request is a new pay-per-call, not a retry of the same intent.
            this.forgetSettlement(paymentKey, entry);
          } else {
            entry.expiresAt = Date.now() + entry.retryWindowMs;
          }
        }
      }
    }
  }

  private unkeyedProofDelivered(entry: CachedSettlement): boolean {
    return entry.unkeyed === true
      && entry.status === 'confirmed'
      && (entry.pendingDeliveries ?? 0) === 0
      && entry.deliveryFailed === false;
  }

  private forgetSettlement(key: string, entry: CachedSettlement): void {
    if (this.paymentSettlements.get(key) === entry) {
      this.paymentSettlements.delete(key);
    }
    this.feePhases.delete(key);
  }

  /**
   * Proof-delivery outcomes are monotonic: a recorded success is never
   * overwritten by a later non-2xx or thrown delivery of the same settlement.
   */
  private recordProofDelivery(entry: CachedSettlement | undefined, delivered: boolean): void {
    if (!entry) return;
    if (delivered) {
      entry.deliveryFailed = false;
      return;
    }
    if (entry.deliveryFailed !== false) {
      entry.deliveryFailed = true;
    }
  }

  /**
   * Public snapshot used by wrappers BEFORE their first network hop, so the
   * settled terms and the paid retry use the bytes that were challenged.
   */
  snapshotRequestInitForRetry(init?: RequestInit): RequestInit | undefined {
    return this.snapshotRequestInit(init);
  }

  /** Clone mutable request data so retry cannot observe caller-side mutation. */
  private snapshotRequestInit(init?: RequestInit): RequestInit | undefined {
    if (!init) {
      return init;
    }
    return {
      ...init,
      headers: new Headers(init.headers),
      body: this.snapshotRequestBody(init.body),
    };
  }

  /** Streams are intentionally retained by identity: consuming them to copy is unsafe. */
  private snapshotRequestBody(body?: BodyInit | null): BodyInit | null | undefined {
    if (
      body === undefined
      || body === null
      || typeof body === 'string'
      || (typeof Blob !== 'undefined' && body instanceof Blob)
    ) {
      return body;
    }
    if (body instanceof URLSearchParams) {
      return new URLSearchParams(body);
    }
    if (body instanceof ArrayBuffer) {
      return body.slice(0);
    }
    if (ArrayBuffer.isView(body)) {
      return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const snapshot = new FormData();
      for (const [name, value] of body.entries()) {
        snapshot.append(name, value);
      }
      return snapshot;
    }
    return body;
  }

  /**
   * Identity for an unkeyed settlement slot. Readable bodies compare by
   * content and normalized request headers bind proof to caller context.
   * Unsupported stream bodies use object identity because copying consumes them.
   */
  private fingerprintUnkeyedRequest(init?: RequestInit): string {
    const readable = fingerprintReadableX402RequestBody(init?.body);
    const context = fingerprintX402RequestContext(init);
    if (readable !== undefined) {
      return `${encodeX402KeyField(readable)}${encodeX402KeyField(context)}`;
    }
    const body = init?.body;
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      return `${encodeX402KeyField(this.fingerprintFormData(body))}${encodeX402KeyField(context)}`;
    }
    if (body === undefined || body === null || typeof body !== 'object') {
      return `${encodeX402KeyField('')}${encodeX402KeyField(context)}`;
    }
    const existing = this.unreadableRequestIds.get(body);
    if (existing) {
      return `${encodeX402KeyField(existing)}${encodeX402KeyField(context)}`;
    }
    const id = `o:${this.nextUnkeyedIntentId()}`;
    this.unreadableRequestIds.set(body, id);
    return `${encodeX402KeyField(id)}${encodeX402KeyField(context)}`;
  }

  /** Snapshot FormData entries before fetch can yield and callers can mutate them. */
  private fingerprintFormData(body: FormData): string {
    const entries = Array.from(body.entries()).map(([name, value]) => {
      if (typeof value === 'string') {
        return `s:${encodeX402KeyField(name)}${encodeX402KeyField(value)}`;
      }
      const blob = value as Blob;
      let id = this.formDataValueIds.get(blob);
      if (!id) {
        id = `o:${this.nextUnkeyedIntentId()}`;
        this.formDataValueIds.set(blob, id);
      }
      const fileName = typeof File !== 'undefined' && blob instanceof File ? blob.name : '';
      return [
        'b:',
        encodeX402KeyField(name),
        encodeX402KeyField(id),
        encodeX402KeyField(fileName),
        encodeX402KeyField(String(blob.size)),
        encodeX402KeyField(blob.type),
      ].join('');
    });
    return fingerprintX402RequestBytes(new TextEncoder().encode(entries.join('')));
  }

  /** Unique-per-client fallback for 402s that carry no explicit intent id. */
  private nextUnkeyedIntentId(): string {
    const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (typeof webCrypto?.randomUUID === 'function') {
      return webCrypto.randomUUID();
    }
    // Only uniqueness within this client instance is required; do not make a
    // runtime without Web Crypto (older Node/insecure browser contexts) fail.
    this.unkeyedIntentSequence += 1;
    return `${Date.now().toString(36)}-${this.unkeyedIntentSequence.toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  }

  /**
   * Everything that is not a confirmed success occupies the fail-closed
   * backlog cap: in-flight, unknown, and unobserved revert tombstones.
   */
  private unconfirmedSettlementCount(): number {
    let unconfirmed = 0;
    for (const entry of this.paymentSettlements.values()) {
      if (entry.status !== 'confirmed') {
        unconfirmed += 1;
      }
    }
    return unconfirmed;
  }

  private assertSettlementCapacity(key: string): void {
    const occupied = this.unconfirmedSettlementCount();
    if (occupied >= X402_MAX_UNCONFIRMED_SETTLEMENTS) {
      throw new X402SettlementBacklogError(occupied);
    }
    const keys = new Set([...this.paymentSettlements.keys(), ...this.feePhases.keys()]);
    if (!keys.has(key) && keys.size >= X402_MAX_CACHED_SETTLEMENTS) {
      throw new X402SettlementBacklogError(keys.size);
    }
  }

  /**
   * Drop confirmed settlements whose replay window has ended and reconfirm
   * unknown ones. Nothing else is ever evicted: a confirmed entry lives for its
   * full advertised window, an unknown hash is retained until its receipt is
   * observed, and a revert tombstone is retained until a caller observes it.
   * Returns the number of in-flight plus unknown settlements currently retained.
   */
  private pruneSettlements(now = Date.now()): number {
    for (const [key, entry] of this.paymentSettlements) {
      if (entry.status === 'unknown') {
        // Never evicted: dropping an unconfirmed hash is exactly the double-pay
        // hazard. Use this client activity to keep confirming it instead of
        // waiting for the same intent to be retried.
        this.reconfirmUnknownSettlement(key, entry, now);
        continue;
      }
      if (entry.status === 'confirmed' && entry.expiresAt !== null && entry.expiresAt <= now) {
        this.paymentSettlements.delete(key);
        this.feePhases.delete(key);
      }
    }
    return this.unconfirmedSettlementCount();
  }

  /**
   * Opportunistic (background) reconfirmation honours exponential backoff so a
   * sustained RPC outage does not turn every later payment into N extra receipt
   * requests. A retry of the same intent still reconfirms immediately.
   */
  private reconfirmUnknownSettlement(key: string, entry: CachedSettlement, now: number): void {
    if (entry.submissionUnknown || entry.feePhasePending || entry.confirming || !entry.txHash) {
      return;
    }
    if (entry.nextReconfirmAt !== undefined && now < entry.nextReconfirmAt) {
      return;
    }
    void this.confirmSubmittedSettlement(key, entry.txHash).catch(() => undefined);
  }

  private markSettlementQueued(entry: CachedSettlement): void {
    entry.status = 'queued';
    entry.expiresAt = null;
    entry.nextReconfirmAt = undefined;
  }

  private markSettlementConfirmed(entry: CachedSettlement): void {
    entry.status = 'confirmed';
    // Background confirmation cannot expire an undelivered proof and turn a
    // receipt-polling failure into another transfer on the later HTTP retry.
    entry.expiresAt = null;
    entry.nextReconfirmAt = undefined;
    entry.reconfirmFailures = undefined;
    entry.log = undefined;
    if (entry.reservationId) {
      this.budget.settle(entry.reservationId);
    }
  }

  /**
   * Record a delayed revert. The reservation is released here, exactly once,
   * except a protocol fee that already settled stays in the daily total.
   * The success observation the original caller recorded is corrected with a
   * `success: false` entry (log + onPaymentComplete); and the entry becomes a
   * tombstone, retained until the next observation of this intent throws
   * X402SettlementRevertedError instead of paying fresh.
   */
  private markSettlementReverted(key: string, entry: CachedSettlement): void {
    entry.status = 'reverted';
    entry.expiresAt = null;
    entry.nextReconfirmAt = undefined;
    this.releaseReservationAfterFailedPayee(key, entry);
    if (entry.log) {
      const correction: X402TransactionLog = {
        ...entry.log,
        timestamp: Math.floor(Date.now() / 1000),
        success: false,
        error: `x402 settlement transaction reverted (${entry.log.txHash})`,
        replayed: false,
      };
      entry.log = undefined;
      this.budget.recordPayment(correction, { reserved: true });
      this.config.onPaymentComplete?.(correction);
    }
  }

  /** The caller has now observed the revert; clear the tombstone and fail closed. */
  private throwObservedRevert(key: string, entry: CachedSettlement, txHash: Hash): never {
    if (this.paymentSettlements.get(key) === entry) {
      this.paymentSettlements.delete(key);
    }
    throw this.withConfirmedFeeEvidence(key, new X402SettlementRevertedError(txHash));
  }

  /** Queued spends stay cached and reserved; a retry must not submit a second transfer. */
  private throwObservedQueued(txHash: Hash): never {
    throw new X402SettlementQueuedError(txHash);
  }

  /**
   * Reserve principal plus fee, or principal only when this intent's protocol
   * fee is already confirmed. The flag tells a later payee failure whether
   * the fee portion of this reservation must stay in the daily total.
   */
  private async reserveSettlementBudget(
    key: string,
    entry: CachedSettlement,
    authorize: AuthorizeFreshTransfer,
  ): Promise<void> {
    const feeAlreadySettled = this.feePhases.get(key)?.status === 'confirmed';
    const reservationId = await authorize(feeAlreadySettled);
    if (reservationId === null) {
      throw X402_POLICY_SKIP;
    }
    entry.reservationId = reservationId;
    entry.reservationIncludesFee = !feeAlreadySettled;
  }

  /**
   * A confirmed protocol fee has already left the wallet. Releasing the whole
   * debit would let the next intent spend that fee again on top of the limit.
   * Principal that never moved is released. A fee that was not confirmed, or
   * a retry that reserved principal only, releases the entire reservation.
   */
  private releaseReservationAfterFailedPayee(key: string, entry: CachedSettlement): void {
    const reservationId = entry.reservationId;
    if (!reservationId) {
      return;
    }
    entry.reservationId = undefined;
    const fee = this.feePhases.get(key);
    if (
      fee?.status === 'confirmed'
      && entry.reservationIncludesFee
      && this.budget.releaseExcept(reservationId, fee.amount)
    ) {
      return;
    }
    this.budget.release(reservationId);
  }

  /** A fee receipt awaiting finality is payment state, never payee proof. */
  private pendingFeePhase(key: string): CachedFeePhase | undefined {
    const fee = this.feePhases.get(key);
    return fee && fee.status !== 'confirmed' ? fee : undefined;
  }

  /**
   * Run a payee transfer under an existing reservation. A failed fee
   * confirmation keeps the settlement and reservation under its own phase so
   * the fee hash cannot be reconfirmed as an X-PAYMENT transaction.
   */
  private async executeReservedSettlement(
    key: string,
    entry: CachedSettlement,
    execute: (intent: { key: string; termsFingerprint: string }) => Promise<{ txHash: Hash }>,
  ): Promise<{ txHash: Hash }> {
    let result: { txHash: Hash };
    try {
      result = await execute({ key, termsFingerprint: entry.termsFingerprint });
      entry.feePhasePending = false;
      entry.unverifiedReplacement = undefined;
    } catch (error) {
      const pendingFee = this.pendingFeePhase(key);
      if (pendingFee) {
        entry.txHash = pendingFee.txHash;
        entry.status = pendingFee.status === 'queued' ? 'queued' : 'unknown';
        entry.feePhasePending = true;
        if (!pendingFee.txHash) {
          entry.submissionUnknown = { phase: 'fee', transfer: pendingFee.transfer };
        }
        throw error;
      }
      if (error instanceof X402PaymentError || error instanceof X402SettlementRevertedError || error === X402_POLICY_SKIP) {
        this.releaseReservationAfterFailedPayee(key, entry);
        throw this.withConfirmedFeeEvidence(key, error);
      }
      entry.status = 'unknown';
      const unknown = error instanceof X402SettlementUnknownError ? error : new X402SettlementUnknownError(
        undefined,
        `x402 payee submission outcome unknown: ${error instanceof Error ? error.message : String(error)}`,
        { phase: 'payee', intentKey: key, cause: error },
      );
      entry.txHash = unknown.txHash;
      entry.submissionUnknown = { phase: 'payee', transfer: unknown.transfer };
      throw this.withConfirmedFeeEvidence(key, unknown);
    }

    entry.txHash = result.txHash;
    try {
      const settledHash = await this.waitForSettlementReceipt(result.txHash);
      entry.txHash = settledHash;
      result = { txHash: settledHash };
    } catch (receiptError) {
      if (receiptError instanceof X402SettlementRevertedError) {
        this.releaseReservationAfterFailedPayee(key, entry);
        throw this.withConfirmedFeeEvidence(key, receiptError);
      }
      if (receiptError instanceof X402SettlementQueuedError) {
        entry.txHash = receiptError.txHash;
        this.markSettlementQueued(entry);
        throw receiptError;
      }
      if (receiptError instanceof X402SettlementUnknownError) {
        entry.txHash = receiptError.txHash ?? entry.txHash;
        entry.status = 'unknown';
        entry.unverifiedReplacement = receiptError.replacement;
        throw this.withConfirmedFeeEvidence(key, receiptError);
      }
      entry.status = 'unknown';
      throw receiptError;
    }
    this.markSettlementConfirmed(entry);
    return result;
  }

  private async resumePendingFeeSettlement(
    key: string,
    entry: CachedSettlement,
    execute: (intent: { key: string; termsFingerprint: string }) => Promise<{ txHash: Hash }>,
  ): Promise<PaymentResult | null> {
    if (entry.status === 'in-flight') {
      const observed = await this.observeSettledPayment(entry.promise, true);
      return observed ? { ...observed, entry } : null;
    }
    entry.status = 'in-flight';
    const pending = (async () => {
      try {
        const result = await this.executeReservedSettlement(key, entry, execute);
        return result;
      } catch (error) {
        if (entry.status === 'queued' || entry.status === 'unknown') {
          throw error;
        }
        if (this.paymentSettlements.get(key) === entry) {
          this.paymentSettlements.delete(key);
        }
        throw error;
      }
    })();
    entry.promise = pending;
    const observed = await this.observeSettledPayment(pending, false);
    return observed ? { ...observed, entry } : null;
  }

  /**
   * A 402 without an explicit intent id shares an in-flight request settlement.
   * Install the in-flight slot before authorize/execute
   * so concurrent retries of the same request identity share one transfer.
   * Distinct POST bodies do not join. After a hash is broadcast, keep that hash
   * and its reservation under this request's unkeyed key until the receipt
   * resolves and proof is delivered so a later retry cannot pay again.
   * Once proof delivery succeeds, a later identical request is a new purchase.
   */
  private async executeUnkeyedPayment(
    key: string,
    termsFingerprint: string,
    execute: (intent: { key: string; termsFingerprint: string }) => Promise<{ txHash: Hash }>,
    authorize: AuthorizeFreshTransfer,
    paymentIdempotencyKey: string,
    retryWindowMs: number = X402_SETTLEMENT_RETRY_WINDOW_MS,
  ): Promise<PaymentResult | null> {
    this.pruneSettlements();
    const existingFee = this.feePhases.get(key);
    if (existingFee && existingFee.termsFingerprint !== termsFingerprint) {
      throw this.withConfirmedFeeEvidence(key, new X402IntentTermsConflictError(
        key, existingFee.termsFingerprint, termsFingerprint,
      ));
    }
    let existing = this.paymentSettlements.get(key);
    if (existing && this.unkeyedProofDelivered(existing)) {
      this.forgetSettlement(key, existing);
      existing = undefined;
    }
    if (existing) {
      if (existing.termsFingerprint !== termsFingerprint) {
        throw this.withConfirmedFeeEvidence(key, new X402IntentTermsConflictError(
          key, existing.termsFingerprint, termsFingerprint,
        ));
      }
      if (retryWindowMs > existing.retryWindowMs) {
        existing.retryWindowMs = retryWindowMs;
        if (existing.status === 'confirmed' && existing.expiresAt !== null) {
          existing.expiresAt = Math.max(existing.expiresAt, Date.now() + retryWindowMs);
        }
      }
      if (existing.submissionUnknown) this.throwUnknownSubmission(key, existing);
      if (existing.feePhasePending) {
        const fee = this.pendingFeePhase(key);
        if (fee?.status === 'queued' && existing.txHash) {
          this.throwObservedQueued(existing.txHash);
        }
        const resumed = await this.resumePendingFeeSettlement(key, existing, execute);
        return resumed ? {
          txHash: resumed.txHash,
          replayed: resumed.replayed,
          entry: existing,
          paymentIdempotencyKey: existing.paymentIdempotencyKey ?? paymentIdempotencyKey,
        } : null;
      }
      const joined = await this.joinUnkeyedSettlement(key, existing);
      if (joined !== undefined) {
        return joined ? {
          ...joined,
          paymentIdempotencyKey: existing.paymentIdempotencyKey ?? paymentIdempotencyKey,
        } : null;
      }
    }

    this.assertSettlementCapacity(key);

    // Reserve the slot before any await so a concurrent same-resource fetch
    // joins this flight instead of authorizing a second transfer.
    const entry = {
      termsFingerprint,
      retryWindowMs,
      expiresAt: null,
      status: 'in-flight',
      unkeyed: true,
      paymentIdempotencyKey,
    } as CachedSettlement;
    const pending = (async () => {
      try {
        await this.reserveSettlementBudget(key, entry, authorize);
        const result = await this.executeReservedSettlement(key, entry, execute);
        return result;
      } catch (error) {
        if (entry.status === 'queued' || entry.status === 'unknown') {
          throw error;
        }
        if (this.paymentSettlements.get(key) === entry) {
          this.paymentSettlements.delete(key);
        }
        throw error;
      }
    })();
    entry.promise = pending;
    this.paymentSettlements.set(key, entry);
    const observed = await this.observeSettledPayment(pending, false);
    return observed ? {
      txHash: observed.txHash,
      replayed: false,
      entry,
      paymentIdempotencyKey,
    } : null;
  }

  /**
   * Observe an already-submitted unkeyed settlement. Returns undefined when
   * a confirmed-revert tombstone was cleared so the caller may transfer again.
   */
  private async joinUnkeyedSettlement(
    key: string,
    existing: CachedSettlement,
  ): Promise<PaymentResult | null | undefined> {
    if (existing.status === 'queued' && existing.txHash) {
      this.throwObservedQueued(existing.txHash);
    }
    if (existing.status === 'confirmed' && existing.txHash) {
      return { txHash: existing.txHash, replayed: true, entry: existing };
    }
    if (existing.status === 'unknown' && existing.txHash) {
      const confirmation = await this.confirmSubmittedSettlement(
        key,
        existing.txHash,
      );
      if (confirmation === 'confirmed') {
        return { txHash: existing.txHash, replayed: false, entry: existing };
      }
      if (confirmation === 'queued') {
        this.throwObservedQueued(existing.txHash);
      }
      if (confirmation === 'reverted') {
        this.throwObservedRevert(key, existing, existing.txHash);
      }
      if (existing.unverifiedReplacement) {
        throw new X402SettlementUnknownError(
          existing.txHash,
          `x402 settlement was replaced by a different transaction (${existing.txHash}); outcome unknown, not a confirmed revert`,
        );
      }
      throw new X402SettlementUnknownError(existing.txHash,
        `x402 unkeyed settlement receipt not yet observed (${existing.txHash})`,
      );
    }
    if (existing.status === 'reverted') {
      if (this.paymentSettlements.get(key) === existing) {
        this.paymentSettlements.delete(key);
      }
      return undefined;
    }
    const observed = await this.observeSettledPayment(existing.promise, true);
    return observed ? { txHash: observed.txHash, replayed: true, entry: existing } : null;
  }

  private async settlePayment(
    key: string,
    termsFingerprint: string,
    execute: (intent: { key: string; termsFingerprint: string }) => Promise<{ txHash: Hash }>,
    authorize: AuthorizeFreshTransfer,
    retryWindowMs: number = X402_SETTLEMENT_RETRY_WINDOW_MS,
  ): Promise<PaymentResult | null> {
    this.pruneSettlements();
    const existingFee = this.feePhases.get(key);
    if (existingFee && existingFee.termsFingerprint !== termsFingerprint) {
      throw new X402IntentTermsConflictError(
        key,
        existingFee.termsFingerprint,
        termsFingerprint,
      );
    }
    const existing = this.paymentSettlements.get(key);
    if (existing) {
      if (existing.termsFingerprint !== termsFingerprint) {
        throw new X402IntentTermsConflictError(key, existing.termsFingerprint, termsFingerprint);
      }
      if (existing.submissionUnknown) this.throwUnknownSubmission(key, existing);
      // A re-issued challenge may advertise a longer window than the one the
      // settlement was cached under. Never let the cached deadline be shorter
      // than the newest window the server is still honouring.
      if (retryWindowMs > existing.retryWindowMs) {
        existing.retryWindowMs = retryWindowMs;
        if (existing.status === 'confirmed' && existing.expiresAt !== null) {
          existing.expiresAt = Math.max(existing.expiresAt, Date.now() + retryWindowMs);
        }
      }
      if (existing.feePhasePending) {
        const fee = this.pendingFeePhase(key);
        if (fee?.status === 'queued' && existing.txHash) {
          this.throwObservedQueued(existing.txHash);
        }
        return this.resumePendingFeeSettlement(key, existing, execute);
      }
      if (existing.status === 'queued' && existing.txHash) {
        this.throwObservedQueued(existing.txHash);
      }
      if (existing.status === 'confirmed' && existing.txHash) {
        return { txHash: existing.txHash, replayed: true, entry: existing };
      }
      if (existing.status === 'reverted' && existing.txHash) {
        this.throwObservedRevert(key, existing, existing.txHash);
      }
      if (existing.status === 'unknown' && existing.txHash) {
        // The first receipt wait may have rejected, so never await its rejected
        // promise here. Reconfirm the saved transaction hash before emitting
        // any proof for either explicit or unkeyed settlements.
        const confirmation = await this.confirmSubmittedSettlement(key, existing.txHash);
        if (confirmation === 'confirmed' && existing.txHash) {
          return { txHash: existing.txHash, replayed: true, entry: existing };
        }
        if (confirmation === 'queued' && existing.txHash) {
          this.throwObservedQueued(existing.txHash);
        }
        if (confirmation === 'reverted' && existing.txHash) {
          this.throwObservedRevert(key, existing, existing.txHash);
        }
        throw new X402SettlementUnknownError(existing.txHash);
      }
      const observed = await this.observeSettledPayment(existing.promise, true);
      if (!observed) {
        return null;
      }
      if (existing.status === 'queued' && existing.txHash) {
        this.throwObservedQueued(existing.txHash);
      }
      if (existing.status === 'reverted') {
        // The original broadcast definitively failed (found either by this
        // retry or by background reconfirmation). Its budget reservation was
        // released exactly once when the revert was recorded. Fail closed:
        // never auto-retry a confirmed revert. A later caller-initiated
        // attempt may resume the payee transfer without re-charging the fee.
        this.throwObservedRevert(key, existing, existing.txHash ?? observed.txHash);
      }
      return {
        txHash: existing.txHash ?? observed.txHash,
        replayed: observed.replayed,
        entry: existing,
      };
    }

    // Fail closed while receipts cannot be observed. Count every entry that is
    // not a confirmed success (in-flight, unknown, unobserved tombstones) at
    // the reservation point (after the existing-intent lookup, before
    // inserting a new slot) so concurrent first-time intents cannot all pass a
    // stale total and then broadcast, and so protected state stays bounded.
    this.assertSettlementCapacity(key);

    // Reserve the in-flight slot before any await so concurrent retries share
    // one policy check + budget reservation and cannot start a second
    // fee+payee transfer.
    // `promise` is assigned right after the closure below is created.
    const entry = {
      termsFingerprint,
      retryWindowMs,
      expiresAt: null,
      status: 'in-flight',
    } as CachedSettlement;
    const pending = (async () => {
      try {
        await this.reserveSettlementBudget(key, entry, authorize);
        const result = await this.executeReservedSettlement(key, entry, execute);
        if (entry.status === 'confirmed') {
          this.pruneSettlements();
        }
        return result;
      } catch (error) {
        if (entry.status === 'queued' || entry.status === 'unknown') {
          throw error;
        }
        if (this.paymentSettlements.get(key) === entry) {
          this.paymentSettlements.delete(key);
        }
        throw error;
      }
    })();
    entry.promise = pending;
    this.paymentSettlements.set(key, entry);
    const observed = await this.observeSettledPayment(pending, false);
    return observed ? { ...observed, entry } : null;
  }

  /**
   * After a polling error the submitted hash stays cached as `unknown`.
   * Every later observation (a retry of the same intent, or any other client
   * activity via pruneSettlements) shares one confirmation attempt, so a
   * delayed revert releases the reservation exactly once and leaves a
   * tombstone for the next observer, and a delayed success starts the replay
   * window.
   */
  private async confirmSubmittedSettlement(
    key: string,
    txHash: Hash,
  ): Promise<SettlementConfirmation> {
    const entry = this.paymentSettlements.get(key);
    if (!entry) {
      return 'reverted';
    }
    if (entry.status === 'confirmed') {
      return 'confirmed';
    }
    if (entry.status === 'reverted') {
      return 'reverted';
    }
    if (entry.status === 'queued') {
      return 'queued';
    }
    if (entry.confirming) {
      return entry.confirming;
    }
    const confirming = (async (): Promise<SettlementConfirmation> => {
      try {
        const settledHash = await this.waitForSettlementReceipt(txHash);
        if (this.paymentSettlements.get(key) === entry) {
          if (entry.log) {
            entry.log.txHash = settledHash;
          }
          entry.txHash = settledHash;
          this.markSettlementConfirmed(entry);
          this.pruneSettlements();
        }
        return 'confirmed';
      } catch (receiptError) {
        if (receiptError instanceof X402SettlementRevertedError) {
          entry.txHash = receiptError.txHash;
          if (entry.log) {
            entry.log.txHash = receiptError.txHash;
          }
          this.markSettlementReverted(key, entry);
          return 'reverted';
        }
        if (receiptError instanceof X402SettlementQueuedError) {
          entry.txHash = receiptError.txHash;
          this.markSettlementQueued(entry);
          return 'queued';
        }
        if (receiptError instanceof X402SettlementUnknownError) {
          entry.txHash = receiptError.txHash ?? entry.txHash;
          entry.status = 'unknown';
          entry.unverifiedReplacement = receiptError.replacement;
          const unknownFailures = (entry.reconfirmFailures ?? 0) + 1;
          entry.reconfirmFailures = unknownFailures;
          entry.nextReconfirmAt = Date.now() + Math.min(
            X402_RECONFIRM_BACKOFF_MS * 2 ** (unknownFailures - 1),
            X402_RECONFIRM_BACKOFF_MAX_MS,
          );
          return 'unknown';
        }
        const failures = (entry.reconfirmFailures ?? 0) + 1;
        entry.reconfirmFailures = failures;
        entry.nextReconfirmAt = Date.now() + Math.min(
          X402_RECONFIRM_BACKOFF_MS * 2 ** (failures - 1),
          X402_RECONFIRM_BACKOFF_MAX_MS,
        );
        return 'unknown';
      } finally {
        entry.confirming = undefined;
      }
    })();
    entry.confirming = confirming;
    return confirming;
  }

  private async observeSettledPayment(
    pending: Promise<{ txHash: Hash }>,
    replayed: boolean,
  ): Promise<{ txHash: Hash; replayed: boolean } | null> {
    try {
      const settled = await pending;
      return { txHash: settled.txHash, replayed };
    } catch (error) {
      if (error === X402_POLICY_SKIP) {
        return null;
      }
      throw error;
    }
  }

  /**
   * A submitted hash is not a completed settlement. Keep the cache entry
   * in-flight (expiresAt = null) until the receipt is final so a later retry
   * cannot broadcast a second fee+payee transfer.
   *
   * viem resolves a replaced nonce with the *replacement* receipt. A reprice
   * still paid the payee under a new hash -- adopt it. An explicit `cancelled`
   * is a confirmed non-payment. An explicit `replaced` only proves the nonce
   * was reused with different destination/value/data; that replacement can
   * still have transferred the requested token (for example via agentExecute).
   * Treat `replaced` as unknown so the reservation stays and a retry cannot
   * pay again. A hash mismatch without `onReplaced` is also unknown.
   */
  private async waitForSettlementReceipt(txHash: Hash): Promise<Hash> {
    if (!EVM_TX_HASH.test(txHash)) {
      throw new X402SettlementUnknownError(undefined, 'x402 submission did not return a valid transaction hash');
    }
    const publicClient = this.wallet?.publicClient;
    const wait = publicClient?.waitForTransactionReceipt;
    if (typeof wait !== 'function') {
      throw new X402SettlementUnknownError(txHash,
        'x402 settlement cannot be confirmed: wallet publicClient.waitForTransactionReceipt is missing',
      );
    }
    let replacementReason: SettlementReplacementReason | undefined;
    let replacementHash: Hash | undefined;
    let receipt: SettlementReceipt | null;
    try {
      receipt = await wait.call(publicClient, {
        hash: txHash,
        onReplaced: (event: SettlementReplacementEvent) => {
          const reason = event?.reason;
          if (reason !== 'repriced' && reason !== 'cancelled' && reason !== 'replaced') {
            return;
          }
          replacementReason = reason;
          const nextHash = event.transactionReceipt?.transactionHash;
          if (typeof nextHash === 'string' && EVM_TX_HASH.test(nextHash)) {
            replacementHash = nextHash;
          }
        },
      }) as SettlementReceipt | null;
    } catch (cause) {
      throw new X402SettlementUnknownError(
        txHash,
        `x402 settlement outcome unknown: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    const receiptHash = receipt?.transactionHash;
    if (typeof receiptHash === 'string' && (
      !EVM_TX_HASH.test(receiptHash)
      || (!replacementReason && receiptHash.toLowerCase() !== txHash.toLowerCase())
    )) {
      throw new X402SettlementUnknownError(txHash,
        `x402 settlement receipt hash mismatch without replacement signal (${txHash} -> ${receiptHash})`,
      );
    }
    const adoptedHash = replacementReason === 'repriced'
      ? (replacementHash ?? (typeof receiptHash === 'string' ? receiptHash : txHash))
      : txHash;
    const replacementOutcomeHash = replacementHash
      ?? (typeof receiptHash === 'string' ? receiptHash : txHash);
    // A mined revert is definitive even when the nonce was reused. Check it
    // before classifying a successful unrelated replacement as unknown.
    if (receipt?.status === 'reverted') {
      throw new X402SettlementRevertedError(
        replacementReason === 'repriced' || replacementReason === 'replaced'
          ? replacementOutcomeHash
          : adoptedHash,
      );
    }
    if (replacementReason === 'cancelled') {
      throw new X402SettlementRevertedError(adoptedHash);
    }
    if (replacementReason === 'replaced') {
      // Keep the original hash so later reconfirm still observes the replacement
      // relationship. Adopting replacementHash would let a later wait treat the
      // unrelated success receipt as the payment.
      if (receipt && x402SettlementReceiptIsQueued(receipt, this.wallet?.address)) {
        throw new X402SettlementQueuedError(replacementOutcomeHash);
      }
      throw new X402SettlementUnknownError(
        txHash,
        `x402 settlement was replaced by a different transaction (${txHash}); outcome unknown, not a confirmed revert`,
        { replacement: true },
      );
    }
    if (!receipt || receipt.status !== 'success') {
      throw new X402SettlementUnknownError(txHash,
        receipt
          ? `x402 settlement receipt not successful (${txHash})`
          : `x402 settlement receipt missing (${txHash})`,
      );
    }
    if (x402SettlementReceiptIsQueued(receipt, this.wallet?.address)) {
      throw new X402SettlementQueuedError(adoptedHash);
    }
    if (!EVM_TX_HASH.test(adoptedHash)) {
      throw new X402SettlementUnknownError(txHash, 'x402 replacement receipt has no valid transaction hash');
    }
    return adoptedHash;
  }

  /**
   * Parse a 402 response to extract payment requirements.
   */
  async parse402Response(response: Response): Promise<X402PaymentRequired | null> {
    // Try PAYMENT-REQUIRED header first (standard x402)
    const headerValue = response.headers.get('payment-required')
      ?? response.headers.get('x-payment-required');

    if (headerValue) {
      try {
        if (headerValue.length > MAX_PAYMENT_REQUIRED_HEADER_BYTES) return null;
        const decoded = decodeX402PaymentHeader(headerValue);
        if (this.isValidPaymentRequired(decoded)) return decoded as X402PaymentRequired;
      } catch {
        // Fall through to body parsing
      }
    }

    // Try JSON body as fallback — size- and time-bounded, then shape-validated.
    try {
      const text = await readBoundedText(response.clone(), {
        timeoutMs: X402_CHALLENGE_BODY_TIMEOUT_MS,
        maxBytes: MAX_PAYMENT_REQUIRED_BODY_BYTES,
        label: '402 challenge body',
      });
      const body = JSON.parse(text);
      if (this.isValidPaymentRequired(body)) {
        return body as X402PaymentRequired;
      }
    } catch {
      // Not parseable, too large or too slow: never pay from it
    }

    return null;
  }

  /**
   * Validate basic x402 shape before any payment selection.
   * Rejects malformed header/body payloads so untrusted 402 responses cannot
   * smuggle incomplete payment instructions into the wallet flow.
   */
  private isValidPaymentRequired(value: unknown): value is X402PaymentRequired {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as X402PaymentRequired;
    if (candidate.x402Version !== 1) return false;
    if (!candidate.resource || typeof candidate.resource.url !== 'string') return false;
    if (candidate.resource.url.length > 2048) return false;
    if (!Array.isArray(candidate.accepts) || candidate.accepts.length === 0) return false;
    if (candidate.accepts.length > MAX_PAYMENT_OPTIONS) return false;

    return candidate.accepts.every(req => (
      req
      && typeof req.scheme === 'string'
      && typeof req.network === 'string'
      && typeof req.asset === 'string'
      && typeof req.amount === 'string'
      && req.amount.length <= 78
      && /^\d+$/.test(req.amount)
      && req.scheme.length <= 64
      && req.network.length <= 64
      && req.asset.length <= 128
      && req.payTo.length <= 128
      && typeof req.payTo === 'string'
      && typeof req.maxTimeoutSeconds === 'number'
      && req.maxTimeoutSeconds > 0
      && req.maxTimeoutSeconds <= 300
    ));
  }

  /**
   * Refuse auto-pay when the 402 was reached via a cross-origin redirect.
   * Same-origin redirects must land on the exact same path and query.
   */
  private isSafePaymentResponseUrl(requestUrl: string, responseUrl: string): boolean {
    try {
      const requested = new URL(requestUrl);
      const responded = new URL(responseUrl);
      // Origin alone is not enough: a same-origin redirect to a different path
      // can present a 402 whose resource matches the final URL while
      // onBeforePayment / the paid retry still use the original trusted path
      // (Codex P1 on #72). The query is part of the resource identity too: a
      // same-origin redirect from `/buy?item=trusted` to `/buy?item=other`
      // would otherwise validate the challenge against a different request
      // snapshot than the one onBeforePayment and the paid retry use (Codex P1
      // on #79). Refuse auto-pay unless origin, pathname, and query all match.
      return requested.origin === responded.origin
        && requested.pathname === responded.pathname
        && requested.search === responded.search;
    } catch {
      return false;
    }
  }

  private isPaymentTransportAllowed(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') return true;
      return parsed.protocol === 'http:'
        && this.config.allowInsecureHttpForDevelopment === true
        && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    } catch {
      return false;
    }
  }

  /**
   * Bind the 402 payment demand to the exact response origin/path.
   * Allows relative resource URLs from the challenged server, but rejects
   * cross-origin or cross-path demands that could redirect payment to another
   * resource after a malicious/intercepted 402 response.
   */
  private isResourceBoundToRequest(paymentRequired: X402PaymentRequired, requestUrl: string): boolean {
    try {
      const requested = new URL(requestUrl);
      const resource = new URL(paymentRequired.resource.url, requested.origin);
      // The query string is part of the purchased resource: authorization and
      // proof must name exactly the request that will be retried.
      return resource.origin === requested.origin
        && resource.pathname === requested.pathname
        && resource.search === requested.search;
    } catch {
      return false;
    }
  }

  /**
   * Numeric chain id the wallet will actually submit on.
   * `agentTransferToken` always uses `wallet.chain`; a 402 `network` field is
   * untrusted and must not pick a token address from a different chain.
   */
  private walletChainId(): number | null {
    const id = this.wallet?.chain?.id;
    return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
  }

  /**
   * True only when the 402 network's chain id equals the wallet's chain id.
   * Missing wallet chain, unparseable network, or mismatch all fail closed.
   */
  private isNetworkOnWalletChain(network: string): boolean {
    const walletChainId = this.walletChainId();
    const networkChainId = parseNetworkChainId(network);
    return walletChainId !== null && networkChainId !== null && networkChainId === walletChainId;
  }

  /**
   * Select the best compatible payment option from offered requirements.
   * Only `exact` is auto-paid: `upto` is a max-authorization, not a charge.
   *
   * v6 change: resolves assets via TokenRegistry in addition to USDC_ADDRESSES.
   * Now accepts any ERC-20 whose address is in the TokenRegistry for the network.
   * Options whose network chain id differs from the wallet chain are rejected —
   * transfers always execute on wallet.chain, so a foreign network would send
   * the foreign chain's token address on the wallet chain (or a shared
   * OP-stack address such as WETH 0x4200…0006).
   */
  selectPaymentOption(accepts: X402PaymentRequirements[]): X402PaymentRequirements | null {
    // Filter to supported networks, the wallet's chain, and resolvable assets
    const compatible = accepts.filter(req => {
      if (!this.isPayableRequirement(req)) return false;
      if (!this.supportedNetworks.has(req.network)) return false;
      if (!this.isNetworkOnWalletChain(req.network)) return false;

      // Config override: explicit supportedAssets list
      if (this.config.supportedAssets?.[req.network]) {
        return this.config.supportedAssets[req.network].some(
          a => a.toLowerCase() === req.asset.toLowerCase()
        );
      }

      // v6: resolve via TokenRegistry — accept any known ERC-20 on this network
      const resolved = resolveAssetAddress(req.asset, req.network);
      return resolved != null;
    });

    if (compatible.length === 0) return null;

    // Only "exact" is implemented as an ERC-20 transfer of req.amount.
    // "upto" is a max-authorization scheme (seller settles actual usage later).
    // Treating req.amount as a one-shot transfer would overpay the cap.
    const exact = compatible.filter(r => r.scheme === 'exact');
    if (exact.length === 0) return null;
    exact.sort((a, b) => Number(BigInt(a.amount) - BigInt(b.amount)));

    return exact[0];
  }

  private isPayableRequirement(req: X402PaymentRequirements): boolean {
    if (!req || typeof req.amount !== 'string' || !/^\d+$/.test(req.amount)) return false;
    if (typeof req.payTo !== 'string' || !isAddress(req.payTo)) return false;
    if (typeof req.network !== 'string' || typeof req.asset !== 'string') return false;
    try {
      const amount = BigInt(req.amount);
      const token = resolveAssetAddress(req.asset, req.network);
      return amount > 0n && amount <= MAX_UINT256 && !!token && isAddress(token);
    } catch {
      return false;
    }
  }

  /**
   * Confirm a broadcast protocol-fee hash. A revert forgets the phase so the
   * next caller-initiated retry can transfer again. A transient receipt error
   * keeps the unknown hash so retry reconfirms instead of paying 0.77% twice.
   */
  private async confirmProtocolFeePhase(entry: CachedFeePhase, key: string): Promise<void> {
    if (!entry.txHash) {
      throw new X402SettlementUnknownError(undefined,
        'x402 fee submission outcome unknown; explicit on-chain reconciliation required',
        { phase: 'fee', intentKey: key, transfer: entry.transfer },
      );
    }
    try {
      entry.txHash = await this.waitForSettlementReceipt(entry.txHash);
      entry.status = 'confirmed';
    } catch (error) {
      if (error instanceof X402SettlementQueuedError) {
        entry.txHash = error.txHash ?? entry.txHash;
        entry.status = 'queued';
      }
      if (error instanceof X402SettlementUnknownError) {
        entry.txHash = error.txHash ?? entry.txHash;
        entry.status = 'unknown';
      }
      if (error instanceof X402SettlementRevertedError) {
        this.feePhases.delete(key);
      }
      throw error;
    }
  }

  /**
   * Transfer the protocol fee once per explicit intent or unkeyed pending key.
   * Record the hash before waiting for the receipt so a timeout cannot drop a
   * live fee submission. Callers without a settlement key must not reach here.
   */
  private async settleProtocolFeePhase(
    intent: { key: string; termsFingerprint: string },
    token: Address,
    feeAmount: bigint,
    req: X402PaymentRequirements,
  ): Promise<void> {
    const recordedFee = this.feePhases.get(intent.key);
    if (recordedFee && recordedFee.termsFingerprint !== intent.termsFingerprint) {
      throw new X402IntentTermsConflictError(
        intent.key,
        recordedFee.termsFingerprint,
        intent.termsFingerprint,
      );
    }
    if (recordedFee?.status === 'confirmed') {
      return;
    }
    if (recordedFee?.status === 'queued') {
      if (!recordedFee.txHash) throw new X402SettlementUnknownError(undefined);
      throw new X402SettlementQueuedError(recordedFee.txHash);
    }
    if (recordedFee?.status === 'unknown') {
      await this.confirmProtocolFeePhase(recordedFee, intent.key);
      return;
    }
    const pending: CachedFeePhase = {
      termsFingerprint: intent.termsFingerprint,
      amount: feeAmount,
      status: 'unknown',
      transfer: this.prepareTransfer(token, X402_PROTOCOL_FEE_COLLECTOR, feeAmount),
    };
    this.feePhases.set(intent.key, pending);
    try {
      pending.txHash = await this.submitTransfer(pending.transfer!, 'fee', intent.key, req);
    } catch (error) {
      // A definite pre-broadcast failure leaves no fee phase to reconcile.
      if (error instanceof X402PaymentError && this.feePhases.get(intent.key) === pending) {
        this.feePhases.delete(intent.key);
      }
      throw error;
    }
    await this.confirmProtocolFeePhase(pending, intent.key);
  }

  /**
   * Execute the payment via AgentWallet's agentTransferToken.
   *
   * v6 change: resolves asset address via TokenRegistry before executing.
   * The 402 response may specify an asset by symbol ("USDC") or by address.
   */
  private async executePayment(
    req: X402PaymentRequirements,
    intent?: { key: string; termsFingerprint: string },
  ): Promise<{ txHash: Hash }> {
    if (req.scheme !== 'exact') {
      throw new X402PaymentError(
        `Unsupported payment scheme "${req.scheme}"; only "exact" transfers are implemented`,
        req,
      );
    }

    if (!this.isNetworkOnWalletChain(req.network)) {
      throw new X402PaymentError(
        `Payment network "${req.network}" does not match wallet chain ${this.walletChainId() ?? 'unknown'}`,
        req,
      );
    }

    if (!this.isPayableRequirement(req)) {
      throw new X402PaymentError('Invalid EVM payee, asset, or uint256 amount', req);
    }

    // Resolve the actual contract address for the requested asset
    const resolvedAddress = resolveAssetAddress(req.asset, req.network);
    if (!resolvedAddress) {
      throw new X402PaymentError(
        `Cannot resolve asset "${req.asset}" on network "${req.network}" to a contract address`,
        req
      );
    }

    // First check on-chain budget. The protocol fee is transferred before the
    // payee as a separate agentTransferToken, so:
    //   - perTxLimit applies to each leg (principal is the larger) — Codex P2 #69
    //   - period remaining must cover only what this attempt still needs to send
    //     (skip the fee when it already confirmed) — Codex P1 #69
    const amount = BigInt(req.amount);
    const feeAmount = x402ProtocolFeeAmount(amount);
    // ABI-encode both complete calls before the first fee can leave the wallet.
    const payeeTransfer = this.prepareTransfer(resolvedAddress, req.payTo as Address, amount);
    if (feeAmount > 0n) this.prepareTransfer(resolvedAddress, X402_PROTOCOL_FEE_COLLECTOR, feeAmount);
    let onChainBudget: Awaited<ReturnType<typeof checkBudget>>;
    try {
      onChainBudget = await checkBudget(this.wallet, resolvedAddress);
    } catch (cause) {
      // This is a read and neither phase has been submitted by this attempt.
      throw new X402PaymentError(
        `On-chain budget could not be checked before submission: ${cause instanceof Error ? cause.message : String(cause)}`,
        req,
        cause,
      );
    }
    const feeAlreadySettled = intent
      ? this.feePhases.get(intent.key)?.status === 'confirmed'
      : false;
    const periodDebit = feeAlreadySettled ? amount : x402DebitAmount(amount);

    if (amount > onChainBudget.perTxLimit) {
      throw new X402PaymentError(
        `Amount ${amount} exceeds on-chain per-tx limit ${onChainBudget.perTxLimit}`,
        req
      );
    }
    if (!feeAlreadySettled && feeAmount > onChainBudget.perTxLimit) {
      throw new X402PaymentError(
        `Protocol fee ${feeAmount} exceeds on-chain per-tx limit ${onChainBudget.perTxLimit}`,
        req
      );
    }

    if (periodDebit > onChainBudget.remainingInPeriod) {
      throw new X402PaymentError(
        feeAlreadySettled
          ? `Amount ${amount} exceeds remaining period budget ${onChainBudget.remainingInPeriod} after confirmed protocol fee`
          : `Amount ${amount} plus protocol fee ${feeAmount} exceeds remaining period budget ${onChainBudget.remainingInPeriod}`,
        req
      );
    }

    if (feeAmount > 0n) {
      if (!intent) {
        throw new X402PaymentError(
          'x402 protocol fee cannot be settled without an intent key',
          req,
        );
      }
      await this.settleProtocolFeePhase(intent, resolvedAddress, feeAmount, req);
    }

    // Execute the ERC20 transfer via AgentWallet (full amount to payee)
    const txHash = await this.submitTransfer(payeeTransfer, 'payee', intent?.key, req);

    return { txHash };
  }

  private prepareTransfer(token: Address, to: Address, amount: bigint): PreparedTransfer {
    const input = encodeFunctionData({
      abi: AgentAccountV2Abi, functionName: 'agentTransferToken', args: [token, to, amount],
    });
    return Object.freeze({ token, to, amount, input });
  }

  private async submitTransfer(
    transfer: PreparedTransfer,
    phase: PaymentPhase,
    intentKey: string | undefined,
    req: X402PaymentRequirements,
  ): Promise<Hash> {
    try {
      const txHash = await submitAgentTransferToken(this.wallet, {
        token: transfer.token, to: transfer.to, amount: transfer.amount,
      });
      if (!EVM_TX_HASH.test(txHash)) throw new Error('submission returned no valid transaction hash');
      return txHash;
    } catch (cause) {
      if (cause instanceof AgentWalletVerificationError) {
        // Verification runs before any write: a definite non-broadcast failure,
        // so the reservation is released rather than held as unknown.
        throw new X402PaymentError(
          `x402 ${phase} not submitted: ${cause.message}`, req, cause,
        );
      }
      throw new X402SettlementUnknownError(undefined,
        `x402 ${phase} submission outcome unknown: ${cause instanceof Error ? cause.message : String(cause)}; explicit on-chain reconciliation required`,
        { phase, intentKey, transfer, cause },
      );
    }
  }

  private throwUnknownSubmission(key: string, entry: CachedSettlement): never {
    const pending = entry.submissionUnknown!;
    throw this.withConfirmedFeeEvidence(key, new X402SettlementUnknownError(undefined,
      `x402 ${pending.phase} submission outcome unknown; explicit on-chain reconciliation required`,
      { phase: pending.phase, intentKey: key, transfer: pending.transfer },
    ));
  }

  private withConfirmedFeeEvidence<T>(key: string, error: T): T {
    const fee = this.feePhases.get(key);
    if (fee?.status === 'confirmed' && fee.txHash && error && typeof error === 'object') {
      const payeeHash = 'txHash' in error && typeof error.txHash === 'string' && EVM_TX_HASH.test(error.txHash)
        ? error.txHash as Hash : undefined;
      Object.assign(error, {
        confirmedFeeTxHash: fee.txHash,
        txHashes: payeeHash ? [payeeHash, fee.txHash] : [fee.txHash],
        fee: fee.amount,
      });
    }
    return error;
  }

  /**
   * Manually associate a signer/RPC-recovered hash with a lost submission.
   * The operator must establish that it belongs to this attempt. We additionally
   * verify wallet, calldata, network, and receipt; an unrelated success is never
   * payment proof. A missing transaction or unknown receipt keeps the hold.
   */
  async reconcileSubmission(params: {
    intentKey: string; phase: PaymentPhase; txHash: Hash;
  }): Promise<SettlementConfirmation> {
    const { intentKey: key, phase, txHash } = params;
    const entry = this.paymentSettlements.get(key);
    const pending = entry?.submissionUnknown;
    const unknown = (message: string, cause?: unknown) => this.withConfirmedFeeEvidence(key,
      new X402SettlementUnknownError(undefined, message, { phase, intentKey: key, cause }),
    );
    if (!entry || !pending || pending.phase !== phase || !pending.transfer || !EVM_TX_HASH.test(txHash)) {
      throw unknown('x402 reconciliation has no matching unresolved submission');
    }
    if (entry.reconciling) {
      if (entry.reconciling.txHash !== txHash) throw unknown('x402 another hash is already being reconciled');
      return entry.reconciling.promise;
    }
    const publicClient = this.wallet?.publicClient;
    const walletAddress = this.wallet?.address;
    if (typeof publicClient?.getTransaction !== 'function' || typeof walletAddress !== 'string' || !isAddress(walletAddress)) {
      throw unknown('x402 reconciliation requires the wallet address and publicClient.getTransaction');
    }
    const reconciling = (async (): Promise<SettlementConfirmation> => {
      try {
        const transaction = await publicClient.getTransaction({ hash: txHash });
        const sender = this.wallet?.walletClient?.account?.address;
        if (
          transaction?.hash?.toLowerCase() !== txHash.toLowerCase()
          || transaction?.to?.toLowerCase() !== walletAddress.toLowerCase()
          || transaction?.input?.toLowerCase() !== pending.transfer!.input.toLowerCase()
          || transaction?.chainId !== this.walletChainId()
          || transaction?.value !== 0n
          || (typeof sender === 'string' && transaction?.from?.toLowerCase() !== sender.toLowerCase())
        ) {
          throw unknown('x402 reconciliation transaction does not match the attempted wallet transfer');
        }
        let settledHash: Hash;
        try {
          settledHash = await this.waitForSettlementReceipt(txHash);
        } catch (error) {
          if (error instanceof X402SettlementRevertedError) {
            if (phase === 'fee') this.feePhases.delete(key);
            entry.txHash = error.txHash;
            entry.submissionUnknown = undefined;
            entry.feePhasePending = false;
            this.markSettlementReverted(key, entry);
            return 'reverted';
          }
          if (error instanceof X402SettlementQueuedError) {
            if (phase === 'fee') {
              const fee = this.feePhases.get(key)!;
              fee.txHash = error.txHash;
              fee.status = 'queued';
              entry.feePhasePending = true;
            }
            entry.txHash = error.txHash;
            entry.submissionUnknown = undefined;
            this.markSettlementQueued(entry);
            return 'queued';
          }
          throw unknown('x402 reconciliation receipt outcome unknown; reservation retained', error);
        }
        entry.submissionUnknown = undefined;
        if (phase === 'fee') {
          const fee = this.feePhases.get(key)!;
          fee.txHash = settledHash;
          fee.status = 'confirmed';
          entry.txHash = undefined;
          entry.feePhasePending = true;
        } else {
          entry.txHash = settledHash;
          entry.feePhasePending = false;
          this.markSettlementConfirmed(entry);
        }
        return 'confirmed';
      } catch (cause) {
        if (cause instanceof X402SettlementUnknownError) throw cause;
        throw unknown('x402 reconciliation failed; submission outcome unknown', cause);
      } finally {
        entry.reconciling = undefined;
      }
    })();
    entry.reconciling = { txHash, promise: reconciling };
    return reconciling;
  }

  // ─── Budget Access ───

  /** Get the budget tracker for direct inspection */
  get budgetTracker(): X402BudgetTracker {
    return this.budget;
  }

  /** Get transaction log */
  getTransactionLog(filter?: { service?: string; since?: number }): X402TransactionLog[] {
    return this.budget.getTransactionLog(filter);
  }

  /** Get daily spend summary */
  getDailySpendSummary() {
    return this.budget.getDailySpendSummary();
  }
}

// ─── Error Types ───

export class X402SettlementRevertedError extends Error {
  constructor(public readonly txHash: Hash) {
    super(`x402 settlement transaction reverted (${txHash})`);
    this.name = 'X402SettlementRevertedError';
  }
}

export class X402SettlementQueuedError extends Error {
  constructor(public readonly txHash: Hash) {
    super(`x402 settlement was queued for owner approval (${txHash})`);
    this.name = 'X402SettlementQueuedError';
  }
}

/** Replacement or other non-final outcome: keep reserved, never send as proof. */
export class X402SettlementUnknownError extends Error {
  readonly retrySafe = false;
  readonly phase?: PaymentPhase;
  readonly intentKey?: string;
  readonly transfer?: PreparedTransfer;
  readonly cause?: unknown;
  readonly replacement: boolean;
  constructor(public readonly txHash?: Hash, message?: string, context: {
    phase?: PaymentPhase; intentKey?: string; transfer?: PreparedTransfer; cause?: unknown; replacement?: boolean;
  } = {}) {
    super(message ?? `x402 settlement outcome unknown (${txHash})`);
    this.name = 'X402SettlementUnknownError';
    this.phase = context.phase;
    this.intentKey = context.intentKey;
    this.transfer = context.transfer ? Object.freeze({ ...context.transfer }) : undefined;
    this.cause = context.cause;
    this.replacement = context.replacement ?? false;
  }
}

/** The chain settlement completed even though delivering proof/reading the HTTP response failed. */
export class X402PaidRequestError extends Error {
  readonly retrySafe = false;
  readonly txHashes: Hash[];
  readonly receipt: { status: 'success'; transactionHash: Hash };
  constructor(
    public readonly txHash: Hash,
    public readonly confirmedFeeTxHash: Hash | undefined,
    public readonly cause: unknown,
    public readonly idempotencyKey: string,
  ) {
    super(`x402 payment confirmed but paid request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'X402PaidRequestError';
    this.txHashes = confirmedFeeTxHash ? [txHash, confirmedFeeTxHash] : [txHash];
    this.receipt = { status: 'success', transactionHash: txHash };
  }
}

export class X402SettlementBacklogError extends Error {
  constructor(public readonly unconfirmedCount: number) {
    super(
      `x402 settlement backlog: ${unconfirmedCount} settlements are not confirmed successful (in flight, receipt unknown, or reverted and not yet observed); refusing a new transfer until confirmations resume`,
    );
    this.name = 'X402SettlementBacklogError';
  }
}

export class X402IntentTermsConflictError extends Error {
  constructor(
    public readonly intentKey: string,
    public readonly cachedTermsFingerprint: string,
    public readonly observedTermsFingerprint: string,
  ) {
    super(
      'x402 explicit payment intent reused with different amount, recipient, asset, or scheme',
    );
    this.name = 'X402IntentTermsConflictError';
  }
}

export class X402PaymentError extends Error {
  constructor(
    message: string,
    public readonly paymentRequirements: X402PaymentRequirements,
    public readonly cause?: unknown,
  ) {
    super(`x402 payment error: ${message}`);
    this.name = 'X402PaymentError';
  }
}

export class X402BudgetExceededError extends Error {
  constructor(
    public readonly reason: string,
    public readonly url: string,
    public readonly paymentRequirements: X402PaymentRequirements
  ) {
    super(`x402 budget exceeded: ${reason}`);
    this.name = 'X402BudgetExceededError';
  }
}
