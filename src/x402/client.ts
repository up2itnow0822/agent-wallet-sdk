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
import { toEventHash } from 'viem';
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

type SettlementConfirmation = 'confirmed' | 'unknown' | 'reverted';

/** 0.77% protocol fee charged beside the payee transfer. */
const X402_PROTOCOL_FEE_BPS = 77n;
const X402_PROTOCOL_FEE_COLLECTOR: Address =
  '0xff86829393C6C26A4EC122bE0Cc3E466Ef876AdD';

type CachedFeePhase = {
  txHash: Hash;
  termsFingerprint: string;
  /** unknown: broadcast, receipt not observed; confirmed: receipt success. */
  status: 'unknown' | 'confirmed';
};

type CachedSettlement = {
  promise: Promise<{ txHash: Hash }>;
  /** Canonical payment terms bound to this explicit intent. */
  termsFingerprint: string;
  /** How long a confirmed settlement is replayable: max(default window, challenge timeout). */
  retryWindowMs: number;
  /**
   * null until the receipt is confirmed successful; otherwise epoch ms when
   * the replay window ends. `unknown` and `reverted` entries never expire.
   */
  expiresAt: number | null;
  /**
   * in-flight: policy/broadcast/first receipt still pending.
   * unknown: broadcast, but receipt polling failed; retained (never evicted) and
   *          reconfirmed on later client activity so a revert can be released.
   * confirmed: receipt observed with status success.
   * reverted: a delayed revert was found by background reconfirmation and no
   *           caller has observed it yet; retained until the next observation
   *           of this intent, which throws instead of silently paying again.
   */
  status: 'in-flight' | 'unknown' | 'confirmed' | 'reverted';
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

type SettlementReceiptLog = {
  address?: string;
  topics?: readonly string[];
};

type SettlementReceipt = {
  status?: string;
  logs?: readonly SettlementReceiptLog[];
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
   */
  async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const urlStr = canonicalizeX402RequestUrl(url);
    const response = await globalThis.fetch(url, init);

    if (response.status !== 402) {
      return response;
    }

    if (!this.config.autoPay) {
      return response;
    }

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
    const method = typeof init?.method === 'string' && init.method.trim() !== ''
      ? init.method
      : 'GET';
    const explicitIntent = explicitX402PaymentIntentId(selected);
    const idempotencyKey = buildX402PaymentIdempotencyKey(
      method,
      urlStr,
      selected,
      explicitIntent ?? this.nextUnkeyedIntentId(),
    );

    // Policy gate for one fresh transfer. The budget is checked before the
    // (possibly slow, human-facing) onBeforePayment callback so nobody is asked
    // to approve a payment the limits already refuse, then re-checked and
    // reserved atomically once approval is in hand. No await separates that
    // final check from the reservation, so two concurrent intents cannot both
    // pass a daily limit that only has room for one of them.
    const authorizeFreshTransfer: AuthorizeFreshTransfer = async () => {
      const precheck = this.budget.checkBudget(service, amount);
      if (!precheck.allowed) {
        throw new X402BudgetExceededError(precheck.reason!, urlStr, selected);
      }
      if (this.config.onBeforePayment) {
        const proceed = await this.config.onBeforePayment(selected, urlStr);
        if (!proceed) {
          return null;
        }
      }
      const reserved = this.budget.checkAndReserve(service, amount);
      if (!reserved.allowed) {
        throw new X402BudgetExceededError(reserved.reason, urlStr, selected);
      }
      return reserved.reservationId;
    };

    const paymentResult = explicitIntent
      ? await this.settlePayment(
          buildX402PaymentIntentKey(method, urlStr, explicitIntent),
          buildX402PaymentTermsFingerprint(selected),
          (intent) => this.executePayment(selected, intent),
          authorizeFreshTransfer,
          Math.max(X402_SETTLEMENT_RETRY_WINDOW_MS, selected.maxTimeoutSeconds * 1000),
        )
      : await this.executeUnkeyedPayment(
          () => this.executePayment(selected),
          authorizeFreshTransfer,
        );
    if (!paymentResult) {
      return response;
    }
    const replayed = paymentResult.replayed;

    const paymentPayload: X402PaymentPayload = {
      x402Version: paymentRequired.x402Version,
      resource: paymentRequired.resource,
      accepted: selected,
      payload: {
        txHash: paymentResult.txHash,
        network: selected.network,
        idempotencyKey,
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
      idempotencyKey,
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
    const retryHeaders = new Headers(init?.headers);
    const payloadB64 = btoa(JSON.stringify(paymentPayload));
    retryHeaders.set('X-PAYMENT', payloadB64);

    const retryResponse = await globalThis.fetch(url, {
      ...init,
      headers: retryHeaders,
    });

    return retryResponse;
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
    if (entry.confirming || !entry.txHash) {
      return;
    }
    if (entry.nextReconfirmAt !== undefined && now < entry.nextReconfirmAt) {
      return;
    }
    void this.confirmSubmittedSettlement(key, entry.txHash).catch(() => undefined);
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

  /**
   * A 402 without an explicit intent id is paid once per call. The spend is
   * reserved before the transfer and settled as soon as the transfer is
   * submitted; there is no replay cache to keep it pending against.
   */
  private async executeUnkeyedPayment(
    execute: () => Promise<{ txHash: Hash }>,
    authorize: AuthorizeFreshTransfer,
  ): Promise<{ txHash: Hash; replayed: false; entry?: undefined } | null> {
    const reservationId = await authorize();
    if (reservationId === null) {
      return null;
    }
    try {
      const result = await execute();
      // Unkeyed challenges have no replay cache, so a later fetch pays again.
      // Still wait for the receipt: a queued or reverted hash must never be
      // sent as X-PAYMENT, and the reservation must be released if nothing moved.
      await this.waitForSettlementReceipt(result.txHash);
      this.budget.settle(reservationId);
      return { txHash: result.txHash, replayed: false };
    } catch (error) {
      this.budget.release(reservationId);
      throw error;
    }
  }

  private async settlePayment(
    key: string,
    termsFingerprint: string,
    execute: (intent: { key: string; termsFingerprint: string }) => Promise<{ txHash: Hash }>,
    authorize: AuthorizeFreshTransfer,
    retryWindowMs: number = X402_SETTLEMENT_RETRY_WINDOW_MS,
  ): Promise<{ txHash: Hash; replayed: boolean; entry: CachedSettlement } | null> {
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
      const observed = await this.observeSettledPayment(existing.promise, true);
      if (!observed) {
        return null;
      }
      if (existing.status === 'unknown') {
        await this.confirmSubmittedSettlement(key, observed.txHash);
      }
      if (existing.status === 'reverted') {
        // The original broadcast definitively failed (found either by this
        // retry or by background reconfirmation). Its budget reservation was
        // released exactly once when the revert was recorded. Fail closed:
        // never auto-retry a confirmed revert. A later caller-initiated
        // attempt may resume the payee transfer without re-charging the fee.
        this.throwObservedRevert(key, existing, observed.txHash);
      }
      return { ...observed, entry: existing };
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
        let result: { txHash: Hash };
        try {
          result = await execute({ key, termsFingerprint });
        } catch (error) {
          // No hash was returned, so nothing is tracked on-chain for this
          // intent; give the reserved spend back.
          this.budget.release(reservationId);
          throw error;
        }
        entry.txHash = result.txHash;
        try {
          await this.waitForSettlementReceipt(result.txHash);
        } catch (receiptError) {
          if (
            receiptError instanceof X402SettlementRevertedError
            || receiptError instanceof X402SettlementQueuedError
          ) {
            // Confirmed revert or AgentAccount queue: nothing moved to the
            // payee, release once, evict (below). Never send the hash as proof.
            this.budget.release(reservationId);
            throw receiptError;
          }
          // Broadcast already happened but the outcome is unknown (RPC
          // timeout, missing receipt). Keep the hash and its reservation so a
          // retry replays instead of paying twice, and keep confirming it.
          entry.status = 'unknown';
          return result;
        }
        this.markSettlementConfirmed(entry);
        this.pruneSettlements();
        return result;
      } catch (error) {
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
    if (entry.confirming) {
      return entry.confirming;
    }
    const confirming = (async (): Promise<SettlementConfirmation> => {
      try {
        await this.waitForSettlementReceipt(txHash);
        if (this.paymentSettlements.get(key) === entry) {
          this.markSettlementConfirmed(entry);
          this.pruneSettlements();
        }
        return 'confirmed';
      } catch (receiptError) {
        if (
          receiptError instanceof X402SettlementRevertedError
          || receiptError instanceof X402SettlementQueuedError
        ) {
          this.markSettlementReverted(entry);
          return 'reverted';
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
   */
  private async waitForSettlementReceipt(txHash: Hash): Promise<void> {
    const publicClient = this.wallet?.publicClient;
    const wait = publicClient?.waitForTransactionReceipt;
    if (typeof wait !== 'function') {
      throw new Error(
        'x402 settlement cannot be confirmed: wallet publicClient.waitForTransactionReceipt is missing',
      );
    }
    const receipt = await wait.call(publicClient, { hash: txHash }) as SettlementReceipt | null;
    if (receipt?.status === 'reverted') {
      throw new X402SettlementRevertedError(txHash);
    }
    if (!receipt || receipt.status !== 'success') {
      throw new Error(
        receipt
          ? `x402 settlement receipt not successful (${txHash})`
          : `x402 settlement receipt missing (${txHash})`,
      );
    }
    if (x402SettlementReceiptIsQueued(receipt, this.wallet?.address)) {
      throw new X402SettlementQueuedError(txHash);
    }
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
   * Prefers: Base network, stablecoins, exact scheme.
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

    // Prefer "exact" scheme, then lowest amount
    const exact = compatible.filter(r => r.scheme === 'exact');
    const candidates = exact.length > 0 ? exact : compatible;
    candidates.sort((a, b) => Number(BigInt(a.amount) - BigInt(b.amount)));

    return candidates[0];
  }

  /**
   * Confirm a broadcast protocol-fee hash. A revert forgets the phase so the
   * next caller-initiated retry can transfer again. A transient receipt error
   * keeps the unknown hash so retry reconfirms instead of paying 0.77% twice.
   */
  private async confirmProtocolFeePhase(entry: CachedFeePhase, key: string): Promise<void> {
    try {
      await this.waitForSettlementReceipt(entry.txHash);
      entry.status = 'confirmed';
    } catch (error) {
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
    // Resolve the actual contract address for the requested asset
    const resolvedAddress = resolveAssetAddress(req.asset, req.network);
    if (!resolvedAddress) {
      throw new X402PaymentError(
        `Cannot resolve asset "${req.asset}" on network "${req.network}" to a contract address`,
        req
      );
    }

    // First check on-chain budget
    const onChainBudget = await checkBudget(this.wallet, resolvedAddress);
    const amount = BigInt(req.amount);

    if (amount > onChainBudget.perTxLimit) {
      throw new X402PaymentError(
        `Amount ${amount} exceeds on-chain per-tx limit ${onChainBudget.perTxLimit}`,
        req
      );
    }

    if (amount > onChainBudget.remainingInPeriod) {
      throw new X402PaymentError(
        `Amount ${amount} exceeds remaining period budget ${onChainBudget.remainingInPeriod}`,
        req
      );
    }

    const feeAmount = (amount * X402_PROTOCOL_FEE_BPS) / 10000n;

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

