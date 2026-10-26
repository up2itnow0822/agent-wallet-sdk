/**
 * SpendingPolicy — Programmable spending guardrails for AI agents.
 *
 * Payment-flow states: reserve → execute → settle | release | hold-unknown.
 *   - reserve(amount) holds capacity all-or-nothing against rolling caps
 *   - commit(reservation) after a settled outcome
 *   - release(reservation) after a definite not-charged outcome
 *   - lock / applyOutcome(hold-unknown) keeps the hold; a timer never unlocks
 *
 * `check()` remains the backward-compatible reserve-then-commit wrapper.
 *
 * @module policy/SpendingPolicy
 */

import { isEvmTxHash, type SpendOutcome } from '../outcomes/index.js';
import { x402DebitAmount, x402ProtocolFeeAmount } from '../x402/fee.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A payment the agent wants to make. */
export interface PaymentIntent {
  /** Merchant contract address or domain (e.g. "0xABC..." or "api.example.com") */
  merchant: string;
  /**
   * Amount in the smallest token unit (e.g. USDC micro-cents = 6 decimals).
   * Use an integer number of base units. Exact fee math uses BigInt internally.
   */
  amount: number;
  /** ISO-8601 timestamp string. Defaults to now if omitted. */
  timestamp?: string;
  /** Optional human-readable label */
  description?: string;
  /**
   * Caller-supplied idempotency key. Reuse with the same payload observes the
   * existing reservation without authorizing execution again. A definite
   * release permits a new attempt with the same terms; changed terms conflict.
   */
  idempotencyKey?: string;
}

export type PolicyStatus = 'approved' | 'rejected' | 'draft';
export type ReservationStatus = 'held' | 'committed' | 'released' | 'locked';
export type ReserveStatus = 'reserved' | 'existing' | 'rejected' | 'draft';
export type AuditStatus = PolicyStatus | ReservationStatus | ReserveStatus;

/** Result returned by SpendingPolicy.check(). */
export interface PolicyResult {
  status: PolicyStatus;
  reason?: string;
  draftId?: string; // populated when status === 'draft'
  reservationId?: string;
}

/**
 * Result returned by reserve() or reserveApprovedDraft(). Only `reserved`
 * grants permission to execute. `existing` shares the previous attempt for
 * observation or reconciliation and never authorizes another transfer.
 */
export interface ReserveResult {
  status: ReserveStatus;
  reason?: string;
  draftId?: string;
  reservation?: SpendReservation;
}

/**
 * A protected view of a spend reservation. Its status reflects later policy
 * transitions; changing the view cannot change the policy's authorization.
 */
export interface SpendReservation {
  reservationId: string;
  payment: PaymentIntent;
  principalAmount: number;
  feeAmount: number;
  reservedAmount: number;
  status: ReservationStatus;
  createdAt: string;
  idempotencyKey?: string;
  draftId?: string;
  /** Present once locked: the submission identity reconciliation must match. */
  submission?: SubmissionIdentity;
}

/**
 * Immutable identity of the on-chain submission(s) behind a locked reservation.
 * Recorded once at lock time; reconciliation can only use these exact hashes.
 * Record EVERY submitted phase (e.g. protocol fee and payee) — release requires
 * all recorded hashes to have reverted. Phases with different calldata each
 * need their own binding in `calls`. A hash with no call binding
 * (`from` = the signing wallet, `to`, `data`) can never be released by
 * reconciliation; the lock stays until committed.
 */
export interface SubmissionIdentity {
  chainId?: number;
  txHashes: readonly string[];
  /**
   * Default call binding, checked against every recorded hash that has no
   * entry in `calls` (required for reconciliation of those hashes).
   */
  from?: string;
  to?: string;
  data?: string;
  value?: bigint;
  /**
   * Per-hash call bindings for multi-phase submissions whose phases differ in
   * calldata (e.g. protocol fee and payee). Each entry's hash is recorded as
   * a submission hash; reconciliation checks each hash against its own call.
   */
  calls?: readonly SubmissionCall[];
}

/** Call binding of one submitted transaction. */
export interface SubmissionCall {
  hash: string;
  from: string;
  to: string;
  data: string;
  value?: bigint;
}

/** Minimal read client used to reconcile a locked reservation on-chain (viem PublicClient compatible). */
export interface ReconciliationClient {
  getChainId(): Promise<number>;
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ transactionHash?: string; status?: string | number } | null | undefined>;
  getTransaction?(args: { hash: `0x${string}` }): Promise<{ hash?: string; from?: string; to?: string | null; input?: string; value?: bigint } | null | undefined>;
}

export type ReconcileStatus = 'released' | 'committed' | 'unresolved';

export interface ReconcileResult {
  status: ReconcileStatus;
  reason?: string;
}

/** A queued draft transaction awaiting approval. */
export interface DraftEntry {
  draftId: string;
  payment: PaymentIntent;
  queuedAt: string; // ISO-8601
  approved: boolean;
  rejected: boolean;
  /** True when the draft was created because the rolling cap would be exceeded. */
  overCap: boolean;
}

/** Immutable record written to the audit log. */
export interface AuditEntry {
  id: string;
  timestamp: string;
  merchant: string;
  amount: number;
  status: AuditStatus;
  reason?: string;
  draftId?: string;
  reservationId?: string;
}

/** Configuration passed to SpendingPolicy constructor. */
export interface SpendingPolicyConfig {
  /**
   * MerchantAllowlist: list of allowed contract addresses or domains.
   * If provided and non-empty, only these merchants are allowed.
   * Pass an empty array [] to disable allowlist enforcement (allow all).
   */
  merchantAllowlist?: string[];

  /**
   * RollingSpendCap: maximum cumulative spend in a rolling time window.
   * Set to undefined to disable.
   */
  rollingCap?: {
    /** Max amount (same units as PaymentIntent.amount) */
    maxAmount: number;
    /** Window size in milliseconds (e.g. 86_400_000 for 24 h) */
    windowMs: number;
  };

  /**
   * DraftThenApprove: payments above this threshold are placed in draft status
   * for human (or another agent) approval rather than executed immediately.
   * Set to undefined to disable.
   */
  draftThreshold?: number;

  /**
   * When true, reserve() and check() hold principal + the 0.77% x402 protocol
   * fee (`(amount * 77n) / 10000n`) so the rolling cap matches the on-chain debit.
   */
  includeProtocolFee?: boolean;

  /**
   * Over-cap behavior. `reject` (default) fails closed. `draft` stores the
   * intent so approveDraft + reserveApprovedDraft can execute it (no dead-end).
   */
  overCapBehavior?: 'reject' | 'draft';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_idCounter}`;
}

const MAX_INTENT_STRING = 2048;

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (value.length > MAX_INTENT_STRING) throw new Error(`${label} is too long`);
  return value;
}

/**
 * Read every PaymentIntent field exactly once into a frozen plain object.
 * Getters, Proxies and prototype tricks cannot make later checks, records or
 * results see different terms from the ones validated (TOCTOU, CWE-367).
 */
export function snapshotPaymentIntent(payment: PaymentIntent): Readonly<PaymentIntent> {
  if (payment === null || typeof payment !== 'object') {
    throw new Error('payment intent must be an object');
  }
  const merchant = payment.merchant;
  const amount = payment.amount;
  const timestamp = payment.timestamp;
  const description = payment.description;
  const idempotencyKey = payment.idempotencyKey;

  if (typeof merchant !== 'string' || merchant.length === 0 || merchant.length > MAX_INTENT_STRING) {
    throw new Error('merchant must be a non-empty string');
  }
  if (typeof amount !== 'number') throw new Error('amount must be a number of base units');
  toSafeIntegerAmount(amount, 'amount');

  const snapshot: PaymentIntent = { merchant, amount };
  const ts = readOptionalString(timestamp, 'timestamp');
  const desc = readOptionalString(description, 'description');
  const key = readOptionalString(idempotencyKey, 'idempotencyKey');
  if (ts !== undefined) snapshot.timestamp = ts;
  if (desc !== undefined) snapshot.description = desc;
  if (key !== undefined && key !== '') snapshot.idempotencyKey = key;
  return Object.freeze(snapshot);
}

function paymentFingerprint(payment: PaymentIntent): string {
  return JSON.stringify([payment.merchant.toLowerCase(), payment.amount, payment.description ?? '']);
}

function toSafeIntegerAmount(amount: number, label: string): number {
  if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(amount)) {
    throw new Error(`${label} must be a non-negative integer number of base units`);
  }
  if (amount > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} exceeds MAX_SAFE_INTEGER`);
  }
  return amount;
}

export function debitAmountForPolicy(principal: number, includeProtocolFee: boolean): {
  principalAmount: number;
  feeAmount: number;
  reservedAmount: number;
} {
  const principalAmount = toSafeIntegerAmount(principal, 'amount');
  if (!includeProtocolFee) {
    return { principalAmount, feeAmount: 0, reservedAmount: principalAmount };
  }
  const principalExact = BigInt(principalAmount);
  const feeExact = x402ProtocolFeeAmount(principalExact);
  const reservedExact = x402DebitAmount(principalExact);
  if (reservedExact > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('reserved amount exceeds MAX_SAFE_INTEGER');
  }
  return {
    principalAmount,
    feeAmount: Number(feeExact),
    reservedAmount: Number(reservedExact),
  };
}

function freezeCall(call: SubmissionCall): SubmissionCall | undefined {
  if (!call || !isEvmTxHash(call.hash)) return undefined;
  if (typeof call.from !== 'string' || typeof call.to !== 'string' || typeof call.data !== 'string') return undefined;
  const frozen: SubmissionCall = {
    hash: call.hash.toLowerCase(),
    from: call.from.toLowerCase(),
    to: call.to.toLowerCase(),
    data: call.data.toLowerCase(),
  };
  if (typeof call.value === 'bigint') frozen.value = call.value;
  return Object.freeze(frozen);
}

function freezeSubmission(submission: SubmissionIdentity): SubmissionIdentity {
  // One binding per hash. Two different bindings for one hash make that hash
  // unprovable (recorded with a binding that can never match), never a
  // silent fallback to the default binding.
  const byHash = new Map<string, SubmissionCall>();
  for (const call of Array.from(submission.calls ?? [])) {
    const frozenCall = freezeCall(call);
    if (!frozenCall) continue;
    const prior = byHash.get(frozenCall.hash);
    byHash.set(frozenCall.hash, prior && !sameCall(prior, frozenCall) ? CONFLICTING_CALL(frozenCall.hash) : (prior ?? frozenCall));
  }
  const calls = [...byHash.values()];
  const hashes = [...Array.from(submission.txHashes ?? []), ...calls.map((c) => c.hash)].filter(isEvmTxHash);
  const chainId = submission.chainId;
  const frozen: SubmissionIdentity = {
    txHashes: Object.freeze([...new Set(hashes.map((h) => h.toLowerCase()))]),
  };
  if (typeof chainId === 'number' && Number.isSafeInteger(chainId) && chainId > 0) frozen.chainId = chainId;
  if (typeof submission.from === 'string') frozen.from = submission.from.toLowerCase();
  if (typeof submission.to === 'string') frozen.to = submission.to.toLowerCase();
  if (typeof submission.data === 'string') frozen.data = submission.data.toLowerCase();
  if (typeof submission.value === 'bigint') frozen.value = submission.value;
  if (calls.length > 0) frozen.calls = Object.freeze(calls);
  return Object.freeze(frozen);
}

/** A binding no transaction can match (empty sender/target/calldata). */
const CONFLICTING_CALL = (hash: string): SubmissionCall => Object.freeze({ hash, from: '', to: '', data: '' });

function sameCall(a: SubmissionCall, b: SubmissionCall): boolean {
  return a.from === b.from && a.to === b.to && a.data === b.data && a.value === b.value;
}

/** The binding a recorded hash must match: its own call, else the default binding. */
function bindingFor(submission: SubmissionIdentity, hash: string): Omit<SubmissionCall, 'hash'> | undefined {
  const own = submission.calls?.find((c) => c.hash === hash.toLowerCase());
  if (own) return own.from && own.to && own.data ? own : undefined;
  if (!submission.from || !submission.to || !submission.data) return undefined;
  return { from: submission.from, to: submission.to, data: submission.data, value: submission.value };
}

function callMatches(
  expected: Omit<SubmissionCall, 'hash'>,
  tx: { from?: string; to?: string | null; input?: string; value?: bigint },
): boolean {
  if ((tx.from ?? '').toLowerCase() !== expected.from) return false;
  if ((tx.to ?? '').toLowerCase() !== expected.to) return false;
  if ((tx.input ?? '').toLowerCase() !== expected.data) return false;
  if (expected.value !== undefined && tx.value !== expected.value) return false;
  return true;
}

// ─── SpendingPolicy ───────────────────────────────────────────────────────────

export class SpendingPolicy {
  private config: SpendingPolicyConfig;
  private allowlist: Set<string>;
  /** Committed spend that ages out of the rolling window. */
  private spendWindow: Array<{ amount: number; ts: number; reservationId: string }>;
  private auditLog: AuditEntry[];
  private drafts: Map<string, DraftEntry>;
  private reservations: Map<string, SpendReservation>;
  private idempotency: Map<string, string>;
  private approvedDraftReservations: Map<string, string>;

  constructor(config: SpendingPolicyConfig) {
    this.config = config;
    this.allowlist = new Set(
      (config.merchantAllowlist ?? []).map((m) => m.toLowerCase())
    );
    this.spendWindow = [];
    this.auditLog = [];
    this.drafts = new Map();
    this.reservations = new Map();
    this.idempotency = new Map();
    this.approvedDraftReservations = new Map();
  }

  // ─── Public Interface ───────────────────────────────────────────────────────

  /**
   * FailClosed: wraps the actual check logic so that ANY unhandled error
   * produces a rejection rather than inadvertently approving a payment.
   *
   * Backward compatible: an approved check() is reserve() then commit().
   * Prefer reserve/commit/release for the payment flow so unknown outcomes
   * can keep the hold instead of consuming the cap immediately.
   */
  async check(payment: PaymentIntent): Promise<PolicyResult> {
    let snapshot: Readonly<PaymentIntent> | undefined;
    try {
      snapshot = snapshotPaymentIntent(payment);
      return await this._check(snapshot);
    } catch (err: unknown) {
      const reason = `Policy engine error (fail-closed): ${err instanceof Error ? err.message : String(err)}`;
      const result: PolicyResult = { status: 'rejected', reason };
      if (snapshot) await this.log(snapshot, result).catch(() => {/* ignore log errors in fail-closed path */});
      else this.logRejectedUnreadable(reason);
      return result;
    }
  }

  /**
   * Hold capacity all-or-nothing against allowlist and rolling caps.
   * Does not commit spend. Over-cap rejects or returns a stored draft.
   * Only a new `reserved` result authorizes execution. An `existing` result
   * observes the same intent, including when it is locked or committed.
   */
  async reserve(payment: PaymentIntent): Promise<ReserveResult> {
    let snapshot: Readonly<PaymentIntent> | undefined;
    try {
      snapshot = snapshotPaymentIntent(payment);
      const result = this.reserveSync(snapshot);
      await this.logReserve(snapshot, result);
      return result;
    } catch (err: unknown) {
      const reason = `Policy engine error (fail-closed): ${err instanceof Error ? err.message : String(err)}`;
      const result: ReserveResult = { status: 'rejected', reason };
      if (snapshot) await this.log(snapshot, { status: 'rejected', reason }).catch(() => undefined);
      else this.logRejectedUnreadable(reason);
      return result;
    }
  }

  /**
   * After a draft is approved, reserve the stored intent so it can execute.
   * Over-cap drafts skip the rolling cap (human approved the stored amount).
   * Threshold drafts still enforce the cap against current occupancy.
   * One approval binds to one attempt. Repeated callers observe `existing`;
   * a new executable reservation is possible only after definite release.
   */
  async reserveApprovedDraft(draftId: string): Promise<ReserveResult> {
    const draft = this.drafts.get(draftId);
    if (!draft) {
      return { status: 'rejected', reason: `Unknown draft: ${draftId}`, draftId };
    }
    if (draft.rejected) {
      return { status: 'rejected', reason: `Draft ${draftId} was rejected.`, draftId };
    }
    if (!draft.approved) {
      return { status: 'rejected', reason: `Draft ${draftId} is not approved.`, draftId };
    }
    try {
      const existingId = this.approvedDraftReservations.get(draftId);
      const existing = existingId ? this.reservations.get(existingId) : undefined;
      if (existing && existing.status !== 'released') {
        const result = this.existingResult(existing);
        await this.logReserve(draft.payment, result);
        return result;
      }
      const result = this.reserveSync(draft.payment, {
        fromApprovedDraft: draftId,
        skipCap: draft.overCap,
        skipDraftThreshold: true,
      });
      if ((result.status === 'reserved' || result.status === 'existing') && result.reservation) {
        // Bind before the first await so concurrent callers cannot claim the
        // same human approval for separate spends.
        this.approvedDraftReservations.set(draftId, result.reservation.reservationId);
      }
      await this.logReserve(draft.payment, result);
      return result;
    } catch (err: unknown) {
      const reason = `Policy engine error (fail-closed): ${err instanceof Error ? err.message : String(err)}`;
      return { status: 'rejected', reason, draftId };
    }
  }

  /**
   * Finalize a reservation after a settled outcome. Capacity stays consumed.
   * Idempotent: a missing, released, or already-committed id returns false.
   */
  commit(reservation: SpendReservation | string, options: { silent?: boolean } = {}): boolean {
    const record = this.resolveReservation(reservation);
    if (!record || (record.status !== 'held' && record.status !== 'locked')) {
      return false;
    }
    record.status = 'committed';
    this.spendWindow.push({
      amount: record.reservedAmount,
      ts: Date.now(),
      reservationId: record.reservationId,
    });
    if (!options.silent) {
      this.logSync(record.payment, {
        status: 'committed',
        reservationId: record.reservationId,
      });
    }
    return true;
  }

  /**
   * Return held capacity after a definite not-charged outcome.
   * Locked (hold-unknown) reservations refuse release — a timer never unlocks
   * them and no caller flag can. Use reconcileLocked() with on-chain evidence.
   * Idempotent: a second observer releases nothing.
   */
  release(reservation: SpendReservation | string): boolean {
    const record = this.resolveReservation(reservation);
    if (!record || record.status !== 'held') {
      return false;
    }
    record.status = 'released';
    this.logSync(record.payment, {
      status: 'released',
      reservationId: record.reservationId,
    });
    return true;
  }

  /**
   * Lock a held reservation after a hold-unknown outcome.
   * Capacity stays occupied until a confirmed settlement commits it or an
   * explicit reconciled release proves no charge. A timer never unlocks it.
   */
  lock(reservation: SpendReservation | string, submission?: SubmissionIdentity): boolean {
    const record = this.resolveReservation(reservation);
    if (!record) return false;
    // Submission identity is recorded once, at lock time, and is immutable.
    // Hashes cannot be attached afterwards: a later "observed" hash could be an
    // earlier reverted attempt of the same call and would wrongly release.
    if (record.status !== 'held') {
      return false;
    }
    record.submission = freezeSubmission(submission ?? { txHashes: [] });
    record.status = 'locked';
    this.logSync(record.payment, {
      status: 'locked',
      reservationId: record.reservationId,
      reason: 'hold-unknown: keep reservation, do not auto-retry',
    });
    return true;
  }

  /**
   * Apply a classified spend outcome to a reservation.
   * settled → commit; released → release; hold-unknown → lock (never release).
   * An already-locked attempt needs valid revert hash evidence to release;
   * a later pre-broadcast rejection cannot reconcile the earlier submission.
   */
  applyOutcome(
    reservation: SpendReservation | string,
    outcome: SpendOutcome,
    /** Call binding of the submission (wallet sender, target, calldata, value). Required for later reconciliation. */
    call?: Pick<SubmissionIdentity, 'from' | 'to' | 'data' | 'value' | 'calls'>,
  ): boolean {
    if (outcome.status === 'settled') {
      return this.commit(reservation);
    }
    if (outcome.status === 'released') {
      // Only a held (never-submitted-ambiguously) reservation may be released
      // by a classified outcome. A locked one needs reconcileLocked().
      return this.release(reservation);
    }
    return this.lock(reservation, {
      chainId: outcome.chainId,
      txHashes: outcome.txHashes.filter(isEvmTxHash),
      ...(call ?? {}),
    });
  }

  /**
   * Reconcile a locked reservation against the chain using ONLY the submission
   * identity recorded when it was locked. All recorded hashes must be found on
   * the recorded chain: every receipt reverted → released; any success →
   * committed; anything missing or ambiguous → unresolved (stays locked).
   */
  async reconcileLocked(
    reservation: SpendReservation | string,
    client: ReconciliationClient,
  ): Promise<ReconcileResult> {
    const record = this.resolveReservation(reservation);
    if (!record || record.status !== 'locked') {
      return { status: 'unresolved', reason: 'reservation is not locked' };
    }
    const submission = record.submission;
    if (!submission || submission.txHashes.length === 0) {
      return {
        status: 'unresolved',
        reason: 'no submission hash was recorded; the hold stays locked (commit it to let it age out)',
      };
    }
    if (submission.chainId === undefined || submission.chainId === null) {
      return { status: 'unresolved', reason: 'submission chain was not recorded' };
    }
    const unbound = submission.txHashes.find((hash) => !bindingFor(submission, hash));
    if (unbound) {
      return {
        status: 'unresolved',
        reason: `no call binding (from, to, data) was recorded at lock time for ${unbound}; reconciliation cannot prove it belongs to this payment`,
      };
    }
    try {
      const chainId = await client.getChainId();
      if (chainId !== submission.chainId) {
        return { status: 'unresolved', reason: `client chain ${chainId} differs from submission chain ${submission.chainId}` };
      }
      let reverted = 0;
      for (const hash of submission.txHashes) {
        const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
        if (!receipt || typeof receipt.transactionHash !== 'string' ||
            receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
          return { status: 'unresolved', reason: `no receipt bound to ${hash}` };
        }
        {
          if (!client.getTransaction) {
            return { status: 'unresolved', reason: 'call binding requires getTransaction' };
          }
          const tx = await client.getTransaction({ hash: hash as `0x${string}` });
          const binding = bindingFor(submission, hash);
          if (!tx || !binding || !callMatches(binding, tx)) {
            return { status: 'unresolved', reason: `transaction ${hash} does not match the recorded call` };
          }
        }
        const st = receipt.status;
        if (st === 'success' || st === 1 || st === '0x1') {
          // Re-check status after awaits: commit only from a still-locked record.
          if (record.status !== 'locked') return { status: 'unresolved', reason: 'reservation changed' };
          this.commit(record);
          return { status: 'committed' };
        }
        if (st === 'reverted' || st === 0 || st === '0x0') reverted += 1;
        else return { status: 'unresolved', reason: `unknown receipt status for ${hash}` };
      }
      if (reverted === submission.txHashes.length && record.status === 'locked') {
        record.status = 'released';
        this.logSync(record.payment, {
          status: 'released',
          reservationId: record.reservationId,
          reason: 'reconciled: every recorded submission reverted on-chain',
        });
        return { status: 'released' };
      }
      return { status: 'unresolved', reason: 'reservation changed during reconciliation' };
    } catch (err) {
      return { status: 'unresolved', reason: `reconciliation error: ${(err as Error).message}` };
    }
  }

  getReservation(reservationId: string): SpendReservation | undefined {
    const record = this.reservations.get(reservationId);
    return record ? { ...record, payment: { ...record.payment } } : undefined;
  }

  private logRejectedUnreadable(reason: string): void {
    this.auditLog.push({
      id: nextId('audit'),
      timestamp: new Date().toISOString(),
      merchant: '<unreadable>',
      amount: 0,
      status: 'rejected',
      reason,
    });
  }

  /** Held + locked reserved amounts (not yet committed or released). */
  getHeldAmount(): number {
    let total = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.status === 'held' || reservation.status === 'locked') {
        total += reservation.reservedAmount;
      }
    }
    return total;
  }

  /**
   * Write a payment attempt to the immutable audit log.
   */
  async log(payment: PaymentIntent, result: PolicyResult & { reservationId?: string }): Promise<void> {
    this.logSync(payment, result);
  }

  /** Return a copy of the current merchant allowlist. */
  getMerchantAllowlist(): string[] {
    return Array.from(this.allowlist);
  }

  /** Add a merchant address/domain to the allowlist at runtime. */
  addMerchant(address: string): void {
    this.allowlist.add(address.toLowerCase());
  }

  /** Return the full, immutable audit log (copy). */
  getAuditLog(): AuditEntry[] {
    return [...this.auditLog];
  }

  // ─── Draft queue management ─────────────────────────────────────────────────

  /** Approve a queued draft by its draftId. Returns false if not found. */
  approveDraft(draftId: string): boolean {
    const draft = this.drafts.get(draftId);
    if (!draft) return false;
    draft.approved = true;
    return true;
  }

  /** Reject a queued draft by its draftId. Returns false if not found. */
  rejectDraft(draftId: string): boolean {
    const draft = this.drafts.get(draftId);
    if (!draft) return false;
    draft.rejected = true;
    return true;
  }

  /** Return copies of all pending (not yet approved or rejected) drafts. */
  getPendingDrafts(): DraftEntry[] {
    return Array.from(this.drafts.values()).filter(
      (d) => !d.approved && !d.rejected
    ).map((d) => ({ ...d, payment: { ...d.payment } }));
  }

  /** Return copies of all drafts, including their stored payment terms. */
  getAllDrafts(): DraftEntry[] {
    return Array.from(this.drafts.values()).map((d) => ({ ...d, payment: { ...d.payment } }));
  }

  // ─── Private Logic ──────────────────────────────────────────────────────────

  private async _check(payment: PaymentIntent): Promise<PolicyResult> {
    const reserved = this.reserveSync(payment);
    if (reserved.status === 'reserved' && reserved.reservation) {
      this.commit(reserved.reservation, { silent: true });
      const result: PolicyResult = {
        status: 'approved',
        reservationId: reserved.reservation.reservationId,
      };
      await this.log(payment, result);
      return result;
    }
    if (reserved.status === 'draft') {
      const result: PolicyResult = {
        status: 'draft',
        reason: reserved.reason,
        draftId: reserved.draftId,
      };
      await this.log(payment, result);
      return result;
    }
    const result: PolicyResult = {
      status: 'rejected',
      reason: reserved.reason,
      reservationId: reserved.reservation?.reservationId,
    };
    await this.log(payment, result);
    return result;
  }

  /**
   * Check limits and create a held reservation with no await in between,
   * so concurrent reserve() calls cannot both pass a cap that only has
   * room for one of them.
   */
  private reserveSync(
    payment: PaymentIntent,
    options: {
      fromApprovedDraft?: string;
      skipCap?: boolean;
      skipDraftThreshold?: boolean;
    } = {},
  ): ReserveResult {
    if (this.allowlist.size > 0) {
      const merchant = payment.merchant.toLowerCase();
      if (!this.allowlist.has(merchant)) {
        return {
          status: 'rejected',
          reason: `Merchant "${payment.merchant}" is not on the allowlist.`,
        };
      }
    }

    const amounts = debitAmountForPolicy(
      payment.amount,
      this.config.includeProtocolFee === true,
    );

    if (payment.idempotencyKey) {
      const existingId = this.idempotency.get(payment.idempotencyKey);
      const existing = existingId ? this.reservations.get(existingId) : undefined;
      if (existing) {
        if (paymentFingerprint(existing.payment) !== paymentFingerprint(payment)) {
          return {
            status: 'rejected',
            reason: `Idempotency key "${payment.idempotencyKey}" reused with a different payment payload.`,
            reservation: this.reservationView(existing),
          };
        }
        if (existing.status !== 'released') {
          return this.existingResult(existing);
        }
      }
    }

    if (this.config.rollingCap && !options.skipCap) {
      const { maxAmount } = this.config.rollingCap;
      const spent = this.occupiedAmount();
      if (spent + amounts.reservedAmount > maxAmount) {
        const reason =
          `Rolling spend cap exceeded: spent ${spent}, cap ${maxAmount}, attempted ${amounts.reservedAmount}.`;
        if (this.config.overCapBehavior === 'draft') {
          return this.queueDraft(payment, reason, true);
        }
        return { status: 'rejected', reason };
      }
    }

    if (
      !options.skipDraftThreshold &&
      this.config.draftThreshold !== undefined &&
      payment.amount >= this.config.draftThreshold
    ) {
      return this.queueDraft(
        payment,
        `Amount ${payment.amount} meets or exceeds draft threshold ${this.config.draftThreshold}. Awaiting approval.`,
        false,
      );
    }

    const reservation: SpendReservation = {
      reservationId: nextId('resv'),
      payment, // already a frozen snapshot
      principalAmount: amounts.principalAmount,
      feeAmount: amounts.feeAmount,
      reservedAmount: amounts.reservedAmount,
      status: 'held',
      createdAt: payment.timestamp ?? new Date().toISOString(),
      idempotencyKey: payment.idempotencyKey,
      draftId: options.fromApprovedDraft,
    };
    this.reservations.set(reservation.reservationId, reservation);
    if (payment.idempotencyKey) {
      this.idempotency.set(payment.idempotencyKey, reservation.reservationId);
    }
    return { status: 'reserved', reservation: this.reservationView(reservation) };
  }

  private queueDraft(payment: PaymentIntent, reason: string, overCap: boolean): ReserveResult {
    const draftId = nextId('draft');
    const draft: DraftEntry = {
      draftId,
      payment: { ...payment },
      queuedAt: payment.timestamp ?? new Date().toISOString(),
      approved: false,
      rejected: false,
      overCap,
    };
    this.drafts.set(draftId, draft);
    return { status: 'draft', reason, draftId };
  }

  private occupiedAmount(): number {
    this.purgeCommittedWindow();
    let occupied = 0;
    for (const entry of this.spendWindow) {
      occupied += entry.amount;
    }
    for (const reservation of this.reservations.values()) {
      if (reservation.status === 'held' || reservation.status === 'locked') {
        occupied += reservation.reservedAmount;
      }
    }
    return occupied;
  }

  private purgeCommittedWindow(): void {
    if (!this.config.rollingCap) return;
    const windowStart = Date.now() - this.config.rollingCap.windowMs;
    this.spendWindow = this.spendWindow.filter((e) => e.ts >= windowStart);
  }

  private resolveReservation(reservation: SpendReservation | string): SpendReservation | undefined {
    if (typeof reservation === 'string') {
      return this.reservations.get(reservation);
    }
    return this.reservations.get(reservation.reservationId);
  }

  private reservationView(record: SpendReservation): SpendReservation {
    return Object.freeze({
      ...record,
      payment: Object.freeze({ ...record.payment }),
      get status() { return record.status; },
    });
  }

  private existingResult(record: SpendReservation): ReserveResult {
    return {
      status: 'existing',
      reason: `Reservation ${record.reservationId} is ${record.status}; observe or reconcile the existing attempt, do not execute again.`,
      draftId: record.draftId,
      reservation: this.reservationView(record),
    };
  }

  private logSync(
    payment: PaymentIntent,
    result: { status: AuditStatus; reason?: string; draftId?: string; reservationId?: string },
  ): void {
    this.auditLog.push({
      id: nextId('audit'),
      timestamp: payment.timestamp ?? new Date().toISOString(),
      merchant: payment.merchant,
      amount: payment.amount,
      status: result.status,
      reason: result.reason,
      draftId: result.draftId,
      reservationId: result.reservationId,
    });
  }

  private async logReserve(payment: PaymentIntent, result: ReserveResult): Promise<void> {
    this.logSync(payment, {
      status: result.status,
      reason: result.reason,
      draftId: result.draftId,
      reservationId: result.reservation?.reservationId,
    });
  }
}
