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

import type { SpendOutcome } from '../outcomes/index.js';
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
   * Caller-supplied idempotency key. Reuse with the same payload joins the
   * in-flight reservation; reuse with a different payload is a conflict.
   */
  idempotencyKey?: string;
}

export type PolicyStatus = 'approved' | 'rejected' | 'draft';
export type ReservationStatus = 'held' | 'committed' | 'released' | 'locked';
export type ReserveStatus = 'reserved' | 'rejected' | 'draft';
export type AuditStatus = PolicyStatus | ReservationStatus | 'reserved';

/** Result returned by SpendingPolicy.check(). */
export interface PolicyResult {
  status: PolicyStatus;
  reason?: string;
  draftId?: string; // populated when status === 'draft'
  reservationId?: string;
}

/** Result returned by SpendingPolicy.reserve(). */
export interface ReserveResult {
  status: ReserveStatus;
  reason?: string;
  draftId?: string;
  reservation?: SpendReservation;
}

/** A held, committed, released, or locked spend reservation. */
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

function paymentFingerprint(payment: PaymentIntent): string {
  return `${payment.merchant.toLowerCase()}|${payment.amount}|${payment.description ?? ''}`;
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
    try {
      return await this._check(payment);
    } catch (err: unknown) {
      const reason = `Policy engine error (fail-closed): ${err instanceof Error ? err.message : String(err)}`;
      const result: PolicyResult = { status: 'rejected', reason };
      await this.log(payment, result).catch(() => {/* ignore log errors in fail-closed path */});
      return result;
    }
  }

  /**
   * Hold capacity all-or-nothing against allowlist and rolling caps.
   * Does not commit spend. Over-cap rejects or returns a stored draft.
   */
  async reserve(payment: PaymentIntent): Promise<ReserveResult> {
    try {
      const result = this.reserveSync(payment);
      await this.logReserve(payment, result);
      return result;
    } catch (err: unknown) {
      const reason = `Policy engine error (fail-closed): ${err instanceof Error ? err.message : String(err)}`;
      const result: ReserveResult = { status: 'rejected', reason };
      await this.log(payment, { status: 'rejected', reason }).catch(() => undefined);
      return result;
    }
  }

  /**
   * After a draft is approved, reserve the stored intent so it can execute.
   * Over-cap drafts skip the rolling cap (human approved the stored amount).
   * Threshold drafts still enforce the cap against current occupancy.
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
      const result = this.reserveSync(draft.payment, {
        fromApprovedDraft: draftId,
        skipCap: draft.overCap,
        skipDraftThreshold: true,
      });
      if (result.reservation) {
        result.reservation.draftId = draftId;
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
   * Locked (hold-unknown) reservations refuse release — a timer never unlocks.
   * Idempotent: a second observer releases nothing.
   */
  release(
    reservation: SpendReservation | string,
    options: { reconciled?: boolean } = {},
  ): boolean {
    const record = this.resolveReservation(reservation);
    if (!record) return false;
    const canRelease =
      record.status === 'held' ||
      (record.status === 'locked' && options.reconciled === true);
    if (!canRelease) {
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
   * Capacity stays occupied until an explicit later commit (on-chain settle)
   * or a code path that never includes a timer.
   */
  lock(reservation: SpendReservation | string): boolean {
    const record = this.resolveReservation(reservation);
    if (!record || record.status !== 'held') {
      return false;
    }
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
   */
  applyOutcome(reservation: SpendReservation | string, outcome: SpendOutcome): boolean {
    if (outcome.status === 'settled') {
      return this.commit(reservation);
    }
    if (outcome.status === 'released') {
      const record = this.resolveReservation(reservation);
      return this.release(reservation, {
        reconciled: record?.status === 'locked',
      });
    }
    return this.lock(reservation);
  }

  getReservation(reservationId: string): SpendReservation | undefined {
    const record = this.reservations.get(reservationId);
    return record ? { ...record, payment: { ...record.payment } } : undefined;
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

  /** Return all pending (not yet approved or rejected) drafts. */
  getPendingDrafts(): DraftEntry[] {
    return Array.from(this.drafts.values()).filter(
      (d) => !d.approved && !d.rejected
    );
  }

  /** Return all drafts. */
  getAllDrafts(): DraftEntry[] {
    return Array.from(this.drafts.values());
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
    const result: PolicyResult = { status: 'rejected', reason: reserved.reason };
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
      if (existing && existing.status !== 'released') {
        if (paymentFingerprint(existing.payment) !== paymentFingerprint(payment)) {
          return {
            status: 'rejected',
            reason: `Idempotency key "${payment.idempotencyKey}" reused with a different payment payload.`,
            reservation: existing,
          };
        }
        if (existing.status === 'held' || existing.status === 'locked' || existing.status === 'committed') {
          return { status: 'reserved', reservation: existing };
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
      payment: { ...payment },
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
    return { status: 'reserved', reservation };
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
    return this.reservations.get(reservation.reservationId) ?? reservation;
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
    const status: AuditStatus =
      result.status === 'reserved' ? 'reserved' : result.status === 'draft' ? 'draft' : 'rejected';
    this.logSync(payment, {
      status,
      reason: result.reason,
      draftId: result.draftId,
      reservationId: result.reservation?.reservationId,
    });
  }
}
