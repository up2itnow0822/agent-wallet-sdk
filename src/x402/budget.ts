// [MAX-ADDED] x402 Budget Controls — per-service spending caps and transaction logging
// viem types imported on-demand within class methods
import type { X402ServiceBudget, X402TransactionLog, X402ClientConfig } from './types.js';

/**
 * A payment counted against daily limits before its receipt is final.
 * Reservations are keyed by payment identity, not by service+amount, so a
 * release or settlement can only ever touch the spend it reserved. A
 * reservation still pending at the daily rollover is carried into the new day
 * (and counted against it), so it can neither land unaccounted nor subtract
 * spend that was never added.
 */
type X402BudgetReservation = {
  service: string;
  amount: bigint;
  /** startOfDay() epoch seconds of the budget day this reservation is counted in. */
  day: number;
};

/**
 * [MAX-ADDED] In-memory budget tracker for x402 payments.
 * Enforces per-service caps, daily limits, and per-request maximums.
 * On-chain spend limits are ALSO enforced by the AgentWallet contract —
 * this is an additional client-side layer for granular service-level control.
 */
export class X402BudgetTracker {
  private serviceBudgets: Map<string, X402ServiceBudget> = new Map();
  private dailySpend: Map<string, bigint> = new Map(); // service -> today's total
  private reservations: Map<string, X402BudgetReservation> = new Map();
  private reservationSequence = 0;
  private globalDailySpend: bigint = 0n;
  private dailyResetTimestamp: number;
  private transactionLog: X402TransactionLog[] = [];

  private globalDailyLimit: bigint;
  private globalPerRequestMax: bigint;

  constructor(config: X402ClientConfig = {}) {
    this.globalDailyLimit = config.globalDailyLimit ?? BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFF'); // effectively unlimited
    this.globalPerRequestMax = config.globalPerRequestMax ?? BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFF');
    this.dailyResetTimestamp = this.startOfDay();

    if (config.serviceBudgets) {
      for (const budget of config.serviceBudgets) {
        this.serviceBudgets.set(budget.service, budget);
      }
    }
  }

  /**
   * Check if a payment is within budget limits.
   * Returns { allowed: true } or { allowed: false, reason: string }.
   */
  checkBudget(service: string, amount: bigint): { allowed: boolean; reason?: string } {
    this.maybeResetDaily();

    // Global per-request check
    if (amount > this.globalPerRequestMax) {
      return { allowed: false, reason: `Amount ${amount} exceeds global per-request max ${this.globalPerRequestMax}` };
    }

    // Global daily check
    if (this.globalDailySpend + amount > this.globalDailyLimit) {
      return { allowed: false, reason: `Would exceed global daily limit ${this.globalDailyLimit}` };
    }

    // Service-specific checks
    const budget = this.findServiceBudget(service);
    if (budget) {
      if (amount > budget.maxPerRequest) {
        return { allowed: false, reason: `Amount ${amount} exceeds service per-request max ${budget.maxPerRequest} for ${service}` };
      }
      const serviceDailySpend = this.dailySpend.get(service) ?? 0n;
      if (serviceDailySpend + amount > budget.dailyLimit) {
        return { allowed: false, reason: `Would exceed daily limit ${budget.dailyLimit} for ${service}` };
      }
    }

    return { allowed: true };
  }

  /**
   * Count a payment against daily limits before it is broadcast/confirmed and
   * return the reservation id. The returned id is the only handle that can
   * later `settle` or `release` this spend.
   */
  reserve(service: string, amount: bigint): string {
    this.maybeResetDaily();
    this.dailySpend.set(service, (this.dailySpend.get(service) ?? 0n) + amount);
    this.globalDailySpend += amount;
    const id = `r${++this.reservationSequence}`;
    this.reservations.set(id, { service, amount, day: this.dailyResetTimestamp });
    return id;
  }

  /**
   * Atomically check limits and reserve the spend when allowed. JavaScript is
   * single-threaded, so no await can interleave between the check and the
   * reservation: two concurrent intents cannot both pass a limit that only
   * has room for one of them.
   */
  checkAndReserve(
    service: string,
    amount: bigint,
  ): { allowed: true; reservationId: string } | { allowed: false; reason: string } {
    const check = this.checkBudget(service, amount);
    if (!check.allowed) {
      return { allowed: false, reason: check.reason! };
    }
    return { allowed: true, reservationId: this.reserve(service, amount) };
  }

  /**
   * Convert a reservation into final spend once the payment is confirmed.
   * Totals already include the reserved amount, so only the handle is dropped.
   * Idempotent: a missing or already-consumed id is a no-op and returns false.
   */
  settle(reservationId: string): boolean {
    this.maybeResetDaily();
    return this.reservations.delete(reservationId);
  }

  /**
   * Reverse a reservation when the payment definitively fails (execution threw
   * before broadcast, policy declined, or the transaction reverted on-chain).
   * Idempotent, and scoped to the budget day the reservation is counted in
   * (carried forward at rollover), so it only ever subtracts spend that was
   * added to the current day, and a second observer of the same revert
   * releases nothing.
   */
  release(reservationId: string): boolean {
    this.maybeResetDaily();
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.day !== this.dailyResetTimestamp) {
      return false;
    }
    this.reservations.delete(reservationId);
    const { service, amount } = reservation;
    this.subtractDailySpend(service, amount);
    return true;
  }

  /**
   * Drop a reservation handle, remove every unit except `amountToKeep` from
   * today's totals, and leave that remainder counted as settled spend.
   * Used when a protocol fee has already moved but the payee transfer did
   * not: the fee stays inside the daily limit and cannot be released twice.
   * Returns false without changing totals when the reservation is missing,
   * belongs to another budget day, or `amountToKeep` is outside the
   * reserved amount.
   */
  releaseExcept(reservationId: string, amountToKeep: bigint): boolean {
    this.maybeResetDaily();
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.day !== this.dailyResetTimestamp) {
      return false;
    }
    if (amountToKeep < 0n || amountToKeep > reservation.amount) {
      return false;
    }
    const amountToRelease = reservation.amount - amountToKeep;
    this.reservations.delete(reservationId);
    this.subtractDailySpend(reservation.service, amountToRelease);
    return true;
  }

  /** Amount currently reserved but not yet settled or released. */
  getReservedSummary(): { global: bigint; byService: Record<string, bigint> } {
    this.maybeResetDaily();
    let global = 0n;
    const byService: Record<string, bigint> = {};
    for (const reservation of this.reservations.values()) {
      global += reservation.amount;
      byService[reservation.service] = (byService[reservation.service] ?? 0n) + reservation.amount;
    }
    return { global, byService };
  }

  /**
   * Record a completed payment.
   *
   * `reserved: true` means this payment's spend was already counted by
   * `reserve()` and must not be added again; the caller settles or releases
   * the reservation separately once the receipt outcome is known. Replayed
   * observations never change totals.
   */
  recordPayment(log: X402TransactionLog, options: { reserved?: boolean } = {}): void {
    this.maybeResetDaily();
    this.transactionLog.push(log);

    if (log.success && !log.replayed && !options.reserved) {
      const service = log.service;
      this.dailySpend.set(service, (this.dailySpend.get(service) ?? 0n) + log.amount);
      this.globalDailySpend += log.amount;
    }
  }

  /**
   * Get transaction history, optionally filtered.
   */
  getTransactionLog(filter?: { service?: string; since?: number }): X402TransactionLog[] {
    let logs = this.transactionLog;
    if (filter?.service) {
      logs = logs.filter(l => l.service === filter.service);
    }
    if (filter?.since) {
      logs = logs.filter(l => l.timestamp >= filter.since!);
    }
    return logs;
  }

  /**
   * Get current daily spend summary.
   */
  getDailySpendSummary(): { global: bigint; byService: Record<string, bigint>; resetsAt: number } {
    this.maybeResetDaily();
    const byService: Record<string, bigint> = {};
    for (const [service, amount] of this.dailySpend) {
      byService[service] = amount;
    }
    return {
      global: this.globalDailySpend,
      byService,
      resetsAt: this.dailyResetTimestamp + 86400,
    };
  }

  /**
   * Add or update a service budget at runtime.
   */
  setServiceBudget(budget: X402ServiceBudget): void {
    this.serviceBudgets.set(budget.service, budget);
  }

  // ─── Internals ───

  private subtractDailySpend(service: string, amount: bigint): void {
    if (amount <= 0n) {
      return;
    }
    const serviceDaily = this.dailySpend.get(service) ?? 0n;
    this.dailySpend.set(service, serviceDaily > amount ? serviceDaily - amount : 0n);
    this.globalDailySpend = this.globalDailySpend > amount ? this.globalDailySpend - amount : 0n;
  }

  private findServiceBudget(service: string): X402ServiceBudget | undefined {
    // Exact match first, then wildcard
    return this.serviceBudgets.get(service) ?? this.serviceBudgets.get('*');
  }

  private maybeResetDaily(): void {
    const now = this.startOfDay();
    if (now > this.dailyResetTimestamp) {
      this.dailySpend.clear();
      this.globalDailySpend = 0n;
      this.dailyResetTimestamp = now;
      // A payment that was authorized before the rollover but has not settled
      // yet is still going to move funds today. Carry its reservation into the
      // new day (counting it against today's limits too) rather than letting it
      // land unaccounted; a later release then subtracts from today's totals,
      // which is exactly where it was re-added.
      for (const reservation of this.reservations.values()) {
        reservation.day = now;
        this.dailySpend.set(
          reservation.service,
          (this.dailySpend.get(reservation.service) ?? 0n) + reservation.amount,
        );
        this.globalDailySpend += reservation.amount;
      }
    }
  }

  private startOfDay(): number {
    const now = Math.floor(Date.now() / 1000);
    return now - (now % 86400);
  }
}
