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
import { keccak256, toEventHash, toHex } from 'viem';
import type {
  X402PaymentRequired,
  X402PaymentRequirements,
  X402PaymentPayload,
  X402ClientConfig,
  X402TransactionLog,
} from './types.js';
import { DEFAULT_SUPPORTED_NETWORKS } from './types.js';
import { X402BudgetTracker } from './budget.js';
import { agentTransferToken, checkBudget } from '../index.js';
import { resolveAssetAddress } from './multi-asset.js';
import { toReplayableFetchArgs } from './fetch-args.js';

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

/**
 * Minimum window during which a successful settlement may be replayed for the
 * same intent. A settlement is retained for the longer of this and the
 * challenge's own `maxTimeoutSeconds`, so a retry inside the server's
 * advertised window can never miss the cache. The cache is bounded by
 * throughput × window, never by a count that could evict an unexpired intent.
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
/** First delay before an `unknown` settlement is reconfirmed opportunistically again. */
export const X402_RECONFIRM_BACKOFF_MS = 5_000;
/** Cap on the opportunistic reconfirmation delay. */
export const X402_RECONFIRM_BACKOFF_MAX_MS = 300_000;

type SettlementConfirmation = 'confirmed' | 'unknown' | 'reverted' | 'queued';

/** 0.77% protocol fee charged beside the payee transfer. */
const X402_PROTOCOL_FEE_BPS = 77n;
const X402_PROTOCOL_FEE_COLLECTOR: Address =
  '0xff86829393C6C26A4EC122bE0Cc3E466Ef876AdD';

function x402ProtocolFeeAmount(amount: bigint): bigint {
  return (amount * X402_PROTOCOL_FEE_BPS) / 10000n;
}

/** Payee amount plus the protocol fee actually debited from the wallet. */
function x402DebitAmount(amount: bigint): bigint {
  return amount + x402ProtocolFeeAmount(amount);
}

type CachedFeePhase = {
  txHash: Hash;
  termsFingerprint: string;
  /** unknown: broadcast receipt unverified; queued: owner approval required. */
  status: 'unknown' | 'queued' | 'confirmed';
};

type CachedSettlement = {
  promise: Promise<{ txHash: Hash }>;
  /** Canonical payment terms bound to this explicit intent. */
  termsFingerprint: string;
  /** How long a confirmed settlement is replayable: max(default window, challenge timeout). */
  retryWindowMs: number;
  /**
   * null until the receipt is confirmed successful; otherwise epoch ms when
   * the replay window ends. `unknown`, `queued`, and `reverted` entries never expire.
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
type AuthorizeFreshTransfer = () => Promise<string | null>;

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
 * URL + terms + request identity so an unresolved unkeyed broadcast cannot be
 * reused as proof for a different resource, body, or caller context, and it
 * cannot block a later unrelated payment.
 */
export function buildUnkeyedPendingKey(
  method: string,
  url: string | URL,
  termsFingerprint: string,
  requestFingerprint: string = '',
): string {
  const normalizedMethod = method.trim().toUpperCase() || 'GET';
  return [
    'unkeyed',
    encodeX402KeyField(normalizedMethod),
    encodeX402KeyField(canonicalizeX402RequestUrl(url)),
    termsFingerprint,
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
  /** Protocol-fee hashes keyed by explicit intent; survives payee-revert eviction. */
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
    const requestInit = this.snapshotRequestInit(replayInit);
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
    const method = typeof requestInit?.method === 'string' && requestInit.method.trim() !== ''
      ? requestInit.method
      : 'GET';
    // Bind settlement identity and both requests to the same call-time values.
    const unkeyedRequestFingerprint = this.fingerprintUnkeyedRequest(requestInit);

    // Parse the 402 response
    const paymentRequired = await this.parse402Response(response);
    if (!paymentRequired) {
      return response; // Couldn't parse — return original 402
    }

    if (!this.isResourceBoundToRequest(paymentRequired, urlStr)) {
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
    const authorizeFreshTransfer: AuthorizeFreshTransfer = async () => {
      const debit = x402DebitAmount(amount);
      const precheck = this.budget.checkBudget(service, debit);
      if (!precheck.allowed) {
        throw new X402BudgetExceededError(precheck.reason!, urlStr, selected);
      }
      if (this.config.onBeforePayment) {
        const proceed = await this.config.onBeforePayment(selected, urlStr);
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

    const termsFingerprint = buildX402PaymentTermsFingerprint(selected);
    const paymentResult = explicitIntent
      ? await this.settlePayment(
          buildX402PaymentIntentKey(method, urlStr, explicitIntent),
          termsFingerprint,
          (intent) => this.executePayment(selected, intent),
          authorizeFreshTransfer,
          Math.max(X402_SETTLEMENT_RETRY_WINDOW_MS, selected.maxTimeoutSeconds * 1000),
        )
      : await this.executeUnkeyedPayment(
          buildUnkeyedPendingKey(
            method,
            urlStr,
            termsFingerprint,
            unkeyedRequestFingerprint,
          ),
          termsFingerprint,
          (intent) => this.executePayment(selected, intent),
          authorizeFreshTransfer,
          idempotencyKey,
        );
    if (!paymentResult) {
      return response;
    }
    const replayed = paymentResult.replayed;
    const paymentIdempotencyKey = paymentResult.paymentIdempotencyKey ?? idempotencyKey;

    const paymentPayload: X402PaymentPayload = {
      x402Version: paymentRequired.x402Version,
      resource: paymentRequired.resource,
      accepted: selected,
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
    this.config.onPaymentComplete?.(log);

    // Retry request with payment proof
    const retryHeaders = new Headers(requestInit?.headers);
    const payloadB64 = btoa(JSON.stringify(paymentPayload));
    retryHeaders.set('X-PAYMENT', payloadB64);

    const retryResponse = await fetchImpl(requestUrl, {
      ...requestInit,
      headers: retryHeaders,
    });

    return retryResponse;
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
    if (entry.feePhasePending || entry.confirming || !entry.txHash) {
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
    entry.expiresAt = Date.now() + entry.retryWindowMs;
    entry.nextReconfirmAt = undefined;
    entry.reconfirmFailures = undefined;
    entry.log = undefined;
    if (entry.reservationId) {
      this.budget.settle(entry.reservationId);
    }
  }

  /**
   * Record a delayed revert. The reservation is released here, exactly once;
   * the success observation the original caller recorded is corrected with a
   * `success: false` entry (log + onPaymentComplete); and the entry becomes a
   * tombstone, retained until the next observation of this intent throws
   * X402SettlementRevertedError instead of paying fresh.
   */
  private markSettlementReverted(entry: CachedSettlement): void {
    entry.status = 'reverted';
    entry.expiresAt = null;
    entry.nextReconfirmAt = undefined;
    if (entry.reservationId) {
      this.budget.release(entry.reservationId);
      entry.reservationId = undefined;
    }
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
    throw new X402SettlementRevertedError(txHash);
  }

  /** Queued spends stay cached and reserved; a retry must not submit a second transfer. */
  private throwObservedQueued(txHash: Hash): never {
    throw new X402SettlementQueuedError(txHash);
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
        entry.unverifiedReplacement = error instanceof X402SettlementUnknownError;
        throw error;
      }
      if (entry.reservationId) {
        this.budget.release(entry.reservationId);
      }
      throw error;
    }

    entry.txHash = result.txHash;
    try {
      const settledHash = await this.waitForSettlementReceipt(result.txHash);
      entry.txHash = settledHash;
      result = { txHash: settledHash };
    } catch (receiptError) {
      if (receiptError instanceof X402SettlementRevertedError) {
        if (entry.reservationId) {
          this.budget.release(entry.reservationId);
        }
        throw receiptError;
      }
      if (receiptError instanceof X402SettlementQueuedError) {
        entry.txHash = receiptError.txHash;
        this.markSettlementQueued(entry);
        throw receiptError;
      }
      if (receiptError instanceof X402SettlementUnknownError) {
        entry.txHash = receiptError.txHash;
        entry.status = 'unknown';
        entry.unverifiedReplacement = true;
        throw receiptError;
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
        if (entry.unkeyed) {
          this.paymentSettlements.delete(key);
          this.feePhases.delete(key);
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
    const observed = await this.observeSettledPayment(pending, false);
    return observed ? { ...observed, entry } : null;
  }

  /**
   * A 402 without an explicit intent id is paid once per call once its receipt
   * is a confirmed success. Install the in-flight slot before authorize/execute
   * so concurrent retries of the same request identity share one transfer.
   * Distinct POST bodies do not join. After a hash is broadcast, keep that hash
   * and its reservation under this request's unkeyed key until the receipt
   * resolves so a later retry of that same request cannot pay again.
   */
  private async executeUnkeyedPayment(
    key: string,
    termsFingerprint: string,
    execute: (intent: { key: string; termsFingerprint: string }) => Promise<{ txHash: Hash }>,
    authorize: AuthorizeFreshTransfer,
    paymentIdempotencyKey: string,
  ): Promise<PaymentResult | null> {
    this.pruneSettlements();
    const existing = this.paymentSettlements.get(key);
    if (existing) {
      if (existing.feePhasePending) {
        const fee = this.pendingFeePhase(key);
        if (fee?.status === 'queued' && existing.txHash) {
          this.throwObservedQueued(existing.txHash);
        }
        const resumed = await this.resumePendingFeeSettlement(key, existing, execute);
        return resumed ? {
          txHash: resumed.txHash,
          replayed: resumed.replayed,
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

    const occupied = this.unconfirmedSettlementCount();
    if (occupied >= X402_MAX_UNCONFIRMED_SETTLEMENTS) {
      throw new X402SettlementBacklogError(occupied);
    }

    // Reserve the slot before any await so a concurrent same-resource fetch
    // joins this flight instead of authorizing a second transfer.
    const entry = {
      termsFingerprint,
      retryWindowMs: X402_SETTLEMENT_RETRY_WINDOW_MS,
      expiresAt: null,
      status: 'in-flight',
      unkeyed: true,
      paymentIdempotencyKey,
    } as CachedSettlement;
    const pending = (async () => {
      try {
        const reservationId = await authorize();
        if (reservationId === null) {
          throw X402_POLICY_SKIP;
        }
        entry.reservationId = reservationId;
        const result = await this.executeReservedSettlement(key, entry, execute);
        this.paymentSettlements.delete(key);
        this.feePhases.delete(key);
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
      this.paymentSettlements.delete(key);
      this.feePhases.delete(key);
      return { txHash: existing.txHash, replayed: false };
    }
    if (existing.status === 'unknown' && existing.txHash) {
      const confirmation = await this.confirmSubmittedSettlement(
        key,
        existing.txHash,
      );
      if (confirmation === 'confirmed') {
        this.paymentSettlements.delete(key);
        this.feePhases.delete(key);
        return { txHash: existing.txHash, replayed: false };
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
      throw new Error(
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
    return observed ? { txHash: observed.txHash, replayed: true } : null;
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
    const occupied = this.unconfirmedSettlementCount();
    if (occupied >= X402_MAX_UNCONFIRMED_SETTLEMENTS) {
      throw new X402SettlementBacklogError(occupied);
    }

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
        const reservationId = await authorize();
        if (reservationId === null) {
          throw X402_POLICY_SKIP;
        }
        entry.reservationId = reservationId;
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
          this.markSettlementReverted(entry);
          return 'reverted';
        }
        if (receiptError instanceof X402SettlementQueuedError) {
          entry.txHash = receiptError.txHash;
          this.markSettlementQueued(entry);
          return 'queued';
        }
        if (receiptError instanceof X402SettlementUnknownError) {
          entry.txHash = receiptError.txHash;
          entry.status = 'unknown';
          entry.unverifiedReplacement = true;
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
    const publicClient = this.wallet?.publicClient;
    const wait = publicClient?.waitForTransactionReceipt;
    if (typeof wait !== 'function') {
      throw new Error(
        'x402 settlement cannot be confirmed: wallet publicClient.waitForTransactionReceipt is missing',
      );
    }
    let replacementReason: SettlementReplacementReason | undefined;
    let replacementHash: Hash | undefined;
    const receipt = await wait.call(publicClient, {
      hash: txHash,
      onReplaced: (event: SettlementReplacementEvent) => {
        const reason = event?.reason;
        if (reason !== 'repriced' && reason !== 'cancelled' && reason !== 'replaced') {
          return;
        }
        replacementReason = reason;
        const nextHash = event.transactionReceipt?.transactionHash;
        if (typeof nextHash === 'string' && nextHash.startsWith('0x')) {
          replacementHash = nextHash;
        }
      },
    }) as SettlementReceipt | null;
    const receiptHash = receipt?.transactionHash;
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
      );
    }
    if (!receipt || receipt.status !== 'success') {
      throw new Error(
        receipt
          ? `x402 settlement receipt not successful (${txHash})`
          : `x402 settlement receipt missing (${txHash})`,
      );
    }
    if (
      replacementReason !== 'repriced'
      && typeof receiptHash === 'string'
      && receiptHash !== txHash
    ) {
      throw new Error(
        `x402 settlement receipt hash mismatch without replacement signal (${txHash} -> ${receiptHash})`,
      );
    }
    if (x402SettlementReceiptIsQueued(receipt, this.wallet?.address)) {
      throw new X402SettlementQueuedError(adoptedHash);
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
        const decoded = JSON.parse(atob(headerValue));
        if (this.isValidPaymentRequired(decoded)) return decoded as X402PaymentRequired;
      } catch {
        // Fall through to body parsing
      }
    }

    // Try JSON body as fallback
    try {
      const body = await response.clone().json();
      if (this.isValidPaymentRequired(body)) {
        return body as X402PaymentRequired;
      }
    } catch {
      // Not parseable
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
    if (!Array.isArray(candidate.accepts) || candidate.accepts.length === 0) return false;

    return candidate.accepts.every(req => (
      req
      && typeof req.scheme === 'string'
      && typeof req.network === 'string'
      && typeof req.asset === 'string'
      && typeof req.amount === 'string'
      && /^\d+$/.test(req.amount)
      && typeof req.payTo === 'string'
      && typeof req.maxTimeoutSeconds === 'number'
      && req.maxTimeoutSeconds > 0
      && req.maxTimeoutSeconds <= 300
    ));
  }

  /**
   * Bind the 402 payment demand to the exact request origin/path.
   * Allows relative resource URLs from the challenged server, but rejects
   * cross-origin or cross-path demands that could redirect payment to another
   * resource after a malicious/intercepted 402 response.
   */
  private isResourceBoundToRequest(paymentRequired: X402PaymentRequired, requestUrl: string): boolean {
    try {
      const requested = new URL(requestUrl);
      const resource = new URL(paymentRequired.resource.url, requested.origin);
      return resource.origin === requested.origin && resource.pathname === requested.pathname;
    } catch {
      return false;
    }
  }

  /**
   * Select the best compatible payment option from offered requirements.
   * Only `exact` is auto-paid: `upto` is a max-authorization, not a charge.
   *
   * v6 change: resolves assets via TokenRegistry in addition to USDC_ADDRESSES.
   * Now accepts any ERC-20 whose address is in the TokenRegistry for the network.
   */
  selectPaymentOption(accepts: X402PaymentRequirements[]): X402PaymentRequirements | null {
    // Filter to supported networks and resolvable assets
    const compatible = accepts.filter(req => {
      if (!this.supportedNetworks.has(req.network)) return false;

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

  /**
   * Confirm a broadcast protocol-fee hash. A revert forgets the phase so the
   * next caller-initiated retry can transfer again. A transient receipt error
   * keeps the unknown hash so retry reconfirms instead of paying 0.77% twice.
   */
  private async confirmProtocolFeePhase(entry: CachedFeePhase, key: string): Promise<void> {
    try {
      entry.txHash = await this.waitForSettlementReceipt(entry.txHash);
      entry.status = 'confirmed';
    } catch (error) {
      if (error instanceof X402SettlementQueuedError) {
        entry.txHash = error.txHash;
        entry.status = 'queued';
      }
      if (error instanceof X402SettlementUnknownError) {
        entry.txHash = error.txHash;
        entry.status = 'unknown';
      }
      if (error instanceof X402SettlementRevertedError) {
        this.feePhases.delete(key);
      }
      throw error;
    }
  }

  /**
   * Transfer the protocol fee once per explicit intent. Record the hash before
   * waiting for the receipt so a timeout cannot drop a live fee submission.
   */
  private async settleProtocolFeePhase(
    intent: { key: string; termsFingerprint: string },
    token: Address,
    feeAmount: bigint,
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
      throw new X402SettlementQueuedError(recordedFee.txHash);
    }
    if (recordedFee?.status === 'unknown') {
      await this.confirmProtocolFeePhase(recordedFee, intent.key);
      return;
    }
    const feeTxHash = await agentTransferToken(this.wallet, {
      token,
      to: X402_PROTOCOL_FEE_COLLECTOR,
      amount: feeAmount,
    });
    const pending: CachedFeePhase = {
      txHash: feeTxHash,
      termsFingerprint: intent.termsFingerprint,
      status: 'unknown',
    };
    this.feePhases.set(intent.key, pending);
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

    // Resolve the actual contract address for the requested asset
    const resolvedAddress = resolveAssetAddress(req.asset, req.network);
    if (!resolvedAddress) {
      throw new X402PaymentError(
        `Cannot resolve asset "${req.asset}" on network "${req.network}" to a contract address`,
        req
      );
    }

    // First check on-chain budget against the full debit. The protocol fee is
    // transferred before the payee, so a principal-only check can pass, charge
    // the fee, then revert the payee and strand funds at the collector.
    const onChainBudget = await checkBudget(this.wallet, resolvedAddress);
    const amount = BigInt(req.amount);
    const feeAmount = x402ProtocolFeeAmount(amount);
    const debit = x402DebitAmount(amount);

    if (debit > onChainBudget.perTxLimit) {
      throw new X402PaymentError(
        `Amount ${amount} plus protocol fee ${feeAmount} exceeds on-chain per-tx limit ${onChainBudget.perTxLimit}`,
        req
      );
    }

    if (debit > onChainBudget.remainingInPeriod) {
      throw new X402PaymentError(
        `Amount ${amount} plus protocol fee ${feeAmount} exceeds remaining period budget ${onChainBudget.remainingInPeriod}`,
        req
      );
    }

    if (feeAmount > 0n) {
      if (intent) {
        await this.settleProtocolFeePhase(intent, resolvedAddress, feeAmount);
      } else {
        const feeTxHash = await agentTransferToken(this.wallet, {
          token: resolvedAddress,
          to: X402_PROTOCOL_FEE_COLLECTOR,
          amount: feeAmount,
        });
        await this.waitForSettlementReceipt(feeTxHash);
      }
    }

    // Execute the ERC20 transfer via AgentWallet (full amount to payee)
    const txHash = await agentTransferToken(this.wallet, {
      token: resolvedAddress,
      to: req.payTo as Address,
      amount,
    });

    return { txHash };
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
  constructor(public readonly txHash: Hash, message?: string) {
    super(message ?? `x402 settlement outcome unknown (${txHash})`);
    this.name = 'X402SettlementUnknownError';
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
    public readonly paymentRequirements: X402PaymentRequirements
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
